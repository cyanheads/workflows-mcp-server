/**
 * @fileoverview In-memory workflow index service with filesystem watcher.
 * Loads, validates, and indexes YAML workflow files from the configured directory.
 * Watches for changes and rebuilds the index with debouncing.
 * @module services/workflow-index/workflow-index-service
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import * as semver from 'semver';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { IndexSnapshot, ParsedWorkflow, WorkflowEntry, WorkflowIndex } from './types.js';

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const StepSchema = z.object({
  server: z.string().min(1),
  tool: z.string().min(1),
  action: z.string().optional(),
  description: z.string().optional(),
  name: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  forEach: z.string().optional(),
});

const WorkflowSchema = z.object({
  name: z.string().min(1),
  // Full semver validation, not a start-anchored regex — a suffix like "1.0.0junk" must
  // fail here so it is skipped at index build and never reaches semver.rcompare.
  version: z.string().refine((v) => semver.valid(v) !== null, {
    message: 'version must be a valid semantic version',
  }),
  description: z.string().min(1),
  author: z.string().min(1),
  category: z.string().min(1).optional(),
  tags: z
    .array(z.string())
    .nullable()
    .optional()
    .transform((v) => v ?? undefined),
  created_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}/)
    .optional(),
  last_updated_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}/)
    .optional(),
  temporary: z.boolean().optional(),
  steps: z.array(StepSchema).min(1),
});

// ---------------------------------------------------------------------------
// Slugification
// ---------------------------------------------------------------------------

/** Convert a display string to a filesystem-safe kebab-case slug. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Maximum slug length for a name used in a filename (leaves room for version + suffix). */
const MAX_NAME_SLUG_LENGTH = 200;

/** Throw a tagged error if the slug derived from a workflow name is empty or too long. */
function assertValidNameSlug(name: string, slug: string): void {
  if (!slug) {
    throw Object.assign(new Error(`Workflow name "${name}" produces an empty slug`), {
      _reason: 'invalid_name',
    });
  }
  if (slug.length > MAX_NAME_SLUG_LENGTH) {
    throw Object.assign(
      new Error(
        `Workflow name is too long — keep it under ${MAX_NAME_SLUG_LENGTH} characters after slugification`,
      ),
      { _reason: 'name_too_long' },
    );
  }
}

// ---------------------------------------------------------------------------
// Logging helpers (background/non-request context)
// ---------------------------------------------------------------------------

function logInfo(msg: string): void {
  logger.info(msg);
}

function logWarn(msg: string): void {
  logger.warning(msg);
}

function logError(msg: string, err: unknown): void {
  logger.error(msg, err instanceof Error ? err : new Error(String(err)));
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class WorkflowIndexService {
  private _index: WorkflowIndex = new Map();
  private _ready = false;
  private _watcherController: AbortController | undefined;
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly workflowsDir: string;
  private readonly globalInstructionsPath: string;
  private readonly watcherDebounceMs: number;

  constructor(workflowsDir: string, globalInstructionsPath: string, watcherDebounceMs: number) {
    this.workflowsDir = workflowsDir;
    this.globalInstructionsPath = globalInstructionsPath;
    this.watcherDebounceMs = watcherDebounceMs;
  }

  // --- Public API ---

  get ready(): boolean {
    return this._ready;
  }

  /** The current in-memory index. */
  get index(): WorkflowIndex {
    return this._index;
  }

  /** Initialize: build initial index and start filesystem watcher. */
  async init(): Promise<void> {
    // Ensure the workflow root exists before the first rebuild and watch. On a fresh install the
    // configured WORKFLOWS_DIR may not exist yet; without this, writeSnapshot() ENOENTs on
    // <root>/_index.json and fs.watch() throws ENOENT so the watcher exits — leaving the server
    // "ready" but silently un-watched. Creating it up front mirrors the lazy mkdir in
    // writePermanent()/writeTemp().
    await fs.mkdir(this.workflowsDir, { recursive: true });
    await this.rebuild();
    this.startWatcher();
  }

  /** Tear down the watcher. */
  shutdown(): void {
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._watcherController?.abort();
  }

  // --- Lookup ---

  /** Find all entries matching a name (across all versions). */
  findByName(name: string): WorkflowEntry[] {
    const results: WorkflowEntry[] = [];
    for (const entry of this._index.values()) {
      if (entry.workflow.name === name) results.push(entry);
    }
    return results;
  }

  /** Semver-aware lookup. Returns the highest version match if version is omitted. */
  findWorkflow(name: string, version?: string): WorkflowEntry | undefined {
    if (version) {
      return this._index.get(`${name}@${version}`);
    }
    const matches = this.findByName(name);
    if (matches.length === 0) return;
    matches.sort((a, b) => semver.rcompare(a.workflow.version, b.workflow.version));
    return matches[0];
  }

  /** Read global_instructions.md content. Returns null if file missing. */
  async readGlobalInstructions(): Promise<string | null> {
    try {
      return await fs.readFile(this.globalInstructionsPath, 'utf-8');
    } catch {
      return null;
    }
  }

  // --- Write operations ---

  /** Write a permanent workflow YAML and rebuild the index. */
  async writePermanent(workflow: ParsedWorkflow): Promise<string> {
    const key = `${workflow.name}@${workflow.version}`;

    // Reject cross-category duplicates. The index key is category-independent, so a second
    // file with the same name@version under a different category would collapse to one key
    // at rebuild (last-write-wins). The `wx` flag below only guards same-path collisions.
    // A temp entry with this key does not block a permanent create.
    const existing = this._index.get(key);
    if (existing && !existing.isTemp) {
      throw Object.assign(new Error(`Workflow "${key}" already exists`), {
        _reason: 'already_exists',
      });
    }

    const categorySlug = slugify(workflow.category ?? 'uncategorized');
    const nameSlug = slugify(workflow.name);
    const versionSlug = slugify(workflow.version);

    assertValidNameSlug(workflow.name, nameSlug);
    // A provided category that slugifies empty (e.g. "!!!") would drop the file into the
    // categories/ root with no subdirectory — reject it as invalid input, mirroring the
    // name-slug guard. The default 'uncategorized' fallback (category omitted) stays safe.
    if (workflow.category !== undefined && !categorySlug) {
      throw Object.assign(
        new Error(`Workflow category "${workflow.category}" produces an empty slug`),
        { _reason: 'invalid_category' },
      );
    }

    const categoryDir = path.join(this.workflowsDir, 'categories', categorySlug);
    // Include version in filename so multiple versions coexist on disk.
    const filePath = path.join(categoryDir, `${nameSlug}-${versionSlug}-workflow.yaml`);

    await fs.mkdir(categoryDir, { recursive: true });
    try {
      // `wx` flag fails atomically if the file already exists, preventing TOCTOU races.
      await fs.writeFile(filePath, stringifyYaml(workflow, { lineWidth: 0 }), {
        encoding: 'utf-8',
        flag: 'wx',
      });
    } catch (err: unknown) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw Object.assign(new Error(`Workflow "${key}" already exists`), {
          _reason: 'already_exists',
        });
      }
      throw err;
    }

    // Immediately rebuild so the index is fresh for the caller.
    // The watcher will also fire and trigger a redundant rebuild — that's fine (idempotent).
    await this.rebuild();
    return filePath;
  }

  /** Write a temporary workflow YAML and rebuild the index. */
  async writeTemp(workflow: ParsedWorkflow): Promise<string> {
    const nameSlug = slugify(workflow.name);
    const versionSlug = slugify(workflow.version);

    assertValidNameSlug(workflow.name, nameSlug);

    const tempDir = path.join(this.workflowsDir, 'temp');
    await fs.mkdir(tempDir, { recursive: true });

    // Include version in filename so different versions are distinct files.
    const filePath = path.join(tempDir, `${nameSlug}-${versionSlug}-workflow.yaml`);
    await fs.writeFile(filePath, stringifyYaml(workflow, { lineWidth: 0 }), 'utf-8');

    await this.rebuild();
    return filePath;
  }

  /**
   * Delete an indexed permanent workflow file and rebuild the index.
   *
   * The target is resolved through {@link findWorkflow}, so only an already-indexed file is ever
   * removed — never an arbitrary caller-supplied path. Throws a tagged error (`_reason`) for the
   * two domain failures: `not_found` (no entry matches the name, or the name/version pair) and
   * `temp_not_allowed` (the resolved entry is a temp workflow — temp workflows are session-scoped
   * and expire on their own, so they are out of scope for deletion). Filesystem errors from the
   * unlink propagate raw for the caller to classify.
   *
   * @returns The deleted workflow's canonical name and version.
   */
  async deleteWorkflow(name: string, version?: string): Promise<{ name: string; version: string }> {
    const entry = this.findWorkflow(name, version);
    if (!entry) {
      throw Object.assign(
        new Error(`No indexed workflow "${name}${version ? `@${version}` : ''}"`),
        {
          _reason: 'not_found',
        },
      );
    }
    if (entry.isTemp) {
      throw Object.assign(
        new Error(
          `Workflow "${name}${version ? `@${version}` : ''}" is temporary and cannot be deleted`,
        ),
        { _reason: 'temp_not_allowed' },
      );
    }

    await fs.unlink(entry.filePath);

    // Immediately rebuild so the index reflects the removal for the caller.
    // The watcher will also fire and trigger a redundant rebuild — that's fine (idempotent).
    await this.rebuild();
    return { name: entry.workflow.name, version: entry.workflow.version };
  }

  // --- Internal ---

  private async rebuild(): Promise<void> {
    const newIndex: WorkflowIndex = new Map();

    try {
      const categoriesDir = path.join(this.workflowsDir, 'categories');
      await this.scanDirectory(categoriesDir, false, newIndex);

      const tempDir = path.join(this.workflowsDir, 'temp');
      await this.scanDirectory(tempDir, true, newIndex);
    } catch (err) {
      logWarn(`Workflow index rebuild error: ${String(err)}`);
    }

    this._index = newIndex;
    this._ready = true;
    logInfo(`Workflow index rebuilt (${newIndex.size} entries)`);

    // Write snapshot asynchronously — don't await
    this.writeSnapshot(newIndex).catch((err) => {
      logWarn(`Failed to write index snapshot: ${String(err)}`);
    });
  }

  private async scanDirectory(dir: string, isTemp: boolean, index: WorkflowIndex): Promise<void> {
    let entries: import('node:fs').Dirent<string>[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true, recursive: true, encoding: 'utf8' });
    } catch {
      // Directory may not exist yet — that's fine
      return;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (!name.endsWith('.yaml') && !name.endsWith('.yml')) continue;
      if (name === '_index.json') continue;

      // `recursive: true` sets `entry.parentPath` in Node 22+, falling back to `entry.path`
      const parentDir =
        (entry as { parentPath?: string }).parentPath ?? (entry as { path?: string }).path ?? dir;

      const filePath = path.join(parentDir, name);
      await this.loadFile(filePath, isTemp, index);
    }
  }

  private async loadFile(filePath: string, isTemp: boolean, index: WorkflowIndex): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      logWarn(`Failed to read workflow file ${filePath}: ${String(err)}`);
      return;
    }

    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch (err) {
      logWarn(`Failed to parse YAML at ${filePath}: ${String(err)}`);
      return;
    }

    const result = WorkflowSchema.safeParse(parsed);
    if (!result.success) {
      logWarn(
        `Invalid workflow schema at ${filePath}: ${JSON.stringify(result.error.flatten().fieldErrors)}`,
      );
      return;
    }

    const workflow = result.data as ParsedWorkflow;

    // Warn if a non-temp file is missing a category
    if (!isTemp && !workflow.category) {
      logWarn(`Permanent workflow missing category field: ${filePath} (name: ${workflow.name})`);
    }

    const key = `${workflow.name}@${workflow.version}`;
    if (index.has(key)) {
      logWarn(`Duplicate workflow key "${key}" — last write wins (file: ${filePath})`);
    }

    index.set(key, { workflow, filePath, isTemp });
  }

  private async writeSnapshot(index: WorkflowIndex): Promise<void> {
    const snapshot: IndexSnapshot = {
      generatedAt: new Date().toISOString(),
      count: index.size,
      entries: {},
    };

    for (const [key, entry] of index) {
      snapshot.entries[key] = {
        filePath: entry.filePath,
        isTemp: entry.isTemp,
        name: entry.workflow.name,
        version: entry.workflow.version,
        ...(entry.workflow.category !== undefined && { category: entry.workflow.category }),
        ...(entry.workflow.tags !== undefined && { tags: entry.workflow.tags }),
      };
    }

    const snapshotPath = path.join(this.workflowsDir, '_index.json');
    await fs.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf-8');
  }

  private startWatcher(): void {
    this._watcherController = new AbortController();
    const signal = this._watcherController.signal;
    const debounceMs = this.watcherDebounceMs;
    const rebuild = () => this.scheduledRebuild();

    // Fire and forget — the loop runs in the background
    void (async () => {
      try {
        const watcher = fs.watch(this.workflowsDir, { recursive: true, signal });
        for await (const event of watcher) {
          // Skip snapshot file events to avoid infinite loop
          const filename = event.filename;
          if (typeof filename === 'string' && filename.endsWith('_index.json')) {
            continue;
          }
          // Debounce
          if (this._debounceTimer) clearTimeout(this._debounceTimer);
          this._debounceTimer = setTimeout(rebuild, debounceMs);
        }
      } catch (err: unknown) {
        // AbortError is expected on shutdown — ignore it
        if (
          err instanceof Error &&
          (err.name === 'AbortError' || (err as { code?: string }).code === 'ABORT_ERR')
        ) {
          return;
        }
        logWarn(`Filesystem watcher exited unexpectedly: ${String(err)}`);
      }
    })();
  }

  private scheduledRebuild(): void {
    this.rebuild().catch((err) => {
      logWarn(`Debounced rebuild failed: ${String(err)}`);
    });
  }
}

// ---------------------------------------------------------------------------
// Init/accessor pattern
// ---------------------------------------------------------------------------

let _service: WorkflowIndexService | undefined;

export function initWorkflowIndexService(
  _config: AppConfig,
  _storage: StorageService,
  workflowsDir: string,
  globalInstructionsPath: string,
  watcherDebounceMs: number,
): void {
  _service = new WorkflowIndexService(workflowsDir, globalInstructionsPath, watcherDebounceMs);
  _service.init().catch((err) => {
    logError('WorkflowIndexService init failed', err);
  });
}

export function getWorkflowIndexService(): WorkflowIndexService {
  if (!_service) {
    throw new Error(
      'WorkflowIndexService not initialized — call initWorkflowIndexService() in setup()',
    );
  }
  return _service;
}
