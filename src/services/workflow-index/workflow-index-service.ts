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
import { parse as parseYaml } from 'yaml';
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
  version: z.string().regex(/^\d+\.\d+\.\d+/),
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
    if (this._index.has(key)) {
      const existing = this._index.get(key);
      if (existing && !existing.isTemp) {
        throw Object.assign(new Error(`Workflow "${key}" already exists`), {
          _reason: 'already_exists',
        });
      }
    }

    const categorySlug = slugify(workflow.category ?? 'uncategorized');
    const nameSlug = slugify(workflow.name);
    const categoryDir = path.join(this.workflowsDir, 'categories', categorySlug);
    const filePath = path.join(categoryDir, `${nameSlug}-workflow.yaml`);

    await fs.mkdir(categoryDir, { recursive: true });
    await fs.writeFile(filePath, buildYaml(workflow), 'utf-8');

    // Immediately rebuild so the index is fresh for the caller.
    // The watcher will also fire and trigger a redundant rebuild — that's fine (idempotent).
    await this.rebuild();
    return filePath;
  }

  /** Write a temporary workflow YAML and rebuild the index. */
  async writeTemp(workflow: ParsedWorkflow): Promise<string> {
    const tempDir = path.join(this.workflowsDir, 'temp');
    await fs.mkdir(tempDir, { recursive: true });

    const nameSlug = slugify(workflow.name);
    const filePath = path.join(tempDir, `${nameSlug}-workflow.yaml`);
    await fs.writeFile(filePath, buildYaml(workflow), 'utf-8');

    await this.rebuild();
    return filePath;
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
// YAML serialisation helper
// ---------------------------------------------------------------------------

function buildYaml(workflow: ParsedWorkflow): string {
  const lines: string[] = [];

  lines.push(`name: ${quote(workflow.name)}`);
  lines.push(`version: "${workflow.version}"`);
  lines.push(`description: ${quote(workflow.description)}`);
  lines.push(`author: ${quote(workflow.author)}`);
  if (workflow.category) lines.push(`category: ${quote(workflow.category)}`);
  if (workflow.tags && workflow.tags.length > 0) {
    lines.push('tags:');
    for (const tag of workflow.tags) lines.push(`  - ${quote(tag)}`);
  }
  if (workflow.created_date) lines.push(`created_date: "${workflow.created_date}"`);
  if (workflow.last_updated_date) lines.push(`last_updated_date: "${workflow.last_updated_date}"`);
  if (workflow.temporary) lines.push('temporary: true');

  lines.push('steps:');
  for (const step of workflow.steps) {
    lines.push(`  - server: ${quote(step.server)}`);
    lines.push(`    tool: ${quote(step.tool)}`);
    if (step.action) lines.push(`    action: ${quote(step.action)}`);
    if (step.description) lines.push(`    description: ${quote(step.description)}`);
    if (step.name) lines.push(`    name: ${quote(step.name)}`);
    if (step.forEach) lines.push(`    forEach: ${quote(step.forEach)}`);
    if (step.params && Object.keys(step.params).length > 0) {
      lines.push('    params:');
      for (const [k, v] of Object.entries(step.params)) {
        lines.push(`      ${k}: ${yamlValue(v)}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

function quote(s: string): string {
  if (/[:#[\]{},&*?|<>=!%@`\\]|^[-?]/.test(s) || s.includes('\n')) {
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return s;
}

function yamlValue(v: unknown): string {
  if (typeof v === 'string') return quote(v);
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (v === null) return 'null';
  return JSON.stringify(v);
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
