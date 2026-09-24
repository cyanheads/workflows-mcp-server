/**
 * @fileoverview In-memory workflow index service with filesystem watcher.
 * Loads, validates, and indexes YAML workflow files from the configured directory.
 * Watches for changes and rebuilds the index with debouncing.
 * @module services/workflow-index/workflow-index-service
 */

import { createHash, randomUUID } from 'node:crypto';
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

/** A required text field: rejects empty and whitespace-only values without altering the text. */
const requiredText = () =>
  z.string().refine((v) => v.trim().length > 0, {
    message: 'must not be blank or whitespace-only',
  });

const StepSchema = z.object({
  server: requiredText(),
  tool: requiredText(),
  action: z.string().optional(),
  description: z.string().optional(),
  name: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  forEach: z.string().optional(),
});

const WorkflowSchema = z.object({
  name: requiredText(),
  // Full semver validation, not a start-anchored regex — a suffix like "1.0.0junk" must
  // fail here so it is skipped at index build and never reaches semver.rcompare. The parsed
  // value is the canonical spelling, so a file authored as "v1.0.0" indexes as name@1.0.0 —
  // the same key workflow_create writes and workflow_get/workflow_delete look up.
  version: z.string().transform((v, ctx) => {
    const canonical = semver.valid(v);
    if (canonical === null) {
      ctx.addIssue({ code: 'custom', message: 'must be a valid semantic version' });
      return z.NEVER;
    }
    return canonical;
  }),
  description: requiredText(),
  author: requiredText(),
  category: requiredText().optional(),
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

/** Render schema issues as `path: message` pairs, e.g. `steps.1.tool: must not be blank…`. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Check a workflow against the schema the index applies when it loads a file, so a create
 * tool rejects exactly what a rebuild would skip. Returns `path: message` pairs for each
 * failing field, or undefined when the workflow is valid.
 */
export function findWorkflowIssues(workflow: ParsedWorkflow): string | undefined {
  const result = WorkflowSchema.safeParse(workflow);
  return result.success ? undefined : describeIssues(result.error);
}

/**
 * The canonical spelling of a semver version — the identity used for index keys, lookups,
 * and written files. `semver.valid()` trims whitespace, strips a leading `v`, and drops build
 * metadata (`v1.0.0+build.5` → `1.0.0`). Callers validate the input as semver first, so a
 * non-semver string here is a programmer error and throws.
 */
export function canonicalVersion(version: string): string {
  const canonical = semver.valid(version);
  if (canonical === null) throw new Error(`"${version}" is not a valid semantic version`);
  return canonical;
}

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

/** Maximum slug length for a workflow name — the filename budget below assumes it. */
const MAX_NAME_SLUG_LENGTH = 200;

/**
 * Maximum slug length for a category. The slug is a whole directory name, so it gets the full
 * 255-byte limit on one path component; slugs are ASCII, so characters are bytes.
 */
const MAX_CATEGORY_SLUG_LENGTH = 255;

/**
 * Maximum length of the version part of a filename. With the longest name slug, two
 * separators, the 8-character hash, and the `-workflow.yaml` suffix, every filename stays
 * within the 255-byte limit: 200 + 1 + 31 + 1 + 8 + 14 = 255.
 */
const MAX_VERSION_SLUG_LENGTH = 31;

/** Name part of the filename for a name with no ASCII letters or digits to slugify. */
const PLACEHOLDER_NAME_SLUG = 'workflow';

/** An Error carrying the `_reason` tag the tool handlers map to a declared error reason. */
function taggedError(message: string, reason: string): Error & { _reason: string } {
  return Object.assign(new Error(message), { _reason: reason });
}

/**
 * Throw a tagged error if a workflow name is blank or its slug is too long for a filename. A
 * name that slugifies to nothing (e.g. one written in a non-Latin script) is valid — the
 * filename falls back to {@link PLACEHOLDER_NAME_SLUG} and the key hash keeps it distinct.
 */
function assertValidName(name: string): void {
  if (!name.trim()) {
    throw taggedError('Workflow name must not be blank', 'invalid_name');
  }
  if (slugify(name).length > MAX_NAME_SLUG_LENGTH) {
    throw taggedError(
      `Workflow name is too long — keep it to at most ${MAX_NAME_SLUG_LENGTH} characters after slugification`,
      'name_too_long',
    );
  }
}

/**
 * A filesystem error's message without the path it names. Node and Bun format a system error as
 * `CODE: description, <syscall> '<path>'` (plus ` -> '<dest>'` for a rename), where the path is
 * an absolute location under the workflows root. Everything from the syscall on is dropped, so a
 * path that itself contains a quote cannot survive a partial match.
 */
export function withoutFsPath(message: string): string {
  return message.replace(/,\s*[a-z]\w* '.*$/s, '').trim();
}

/**
 * The filename for a stored key: readable name and version slugs plus the first 8 hex characters
 * of SHA-256 over `name@version` — e.g. `git-wrapup-1-0-0-3f2a9c1d-workflow.yaml`. Slugs are lossy
 * (case, punctuation, and non-ASCII letters all collapse), so the hash is what keeps distinct keys
 * at distinct paths, including on case-insensitive filesystems. The result is a pure function of
 * the key, so the `wx` write flag still guards concurrent writes of one key. `version` must be
 * canonical ({@link canonicalVersion}), as index keys are.
 */
function workflowFileName(name: string, version: string): string {
  const nameSlug = slugify(name) || PLACEHOLDER_NAME_SLUG;
  const versionSlug = slugify(version).slice(0, MAX_VERSION_SLUG_LENGTH).replace(/-+$/, '');
  const hash = createHash('sha256').update(`${name}@${version}`).digest('hex').slice(0, 8);
  return `${nameSlug}-${versionSlug}-${hash}-workflow.yaml`;
}

/** The `code` of a Node.js system error (`EEXIST`, `ENOENT`, …), if it has one. */
function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * An indexed workflow as a delete confirmation names it: key parts, source, and file path
 * relative to the workflows root.
 */
export interface WorkflowTarget {
  name: string;
  /** File path relative to the workflows root. */
  path: string;
  source: 'permanent' | 'temp';
  version: string;
}

/** A target the user was asked to confirm, with a SHA-256 of the file bytes it named. */
export interface ConfirmedTarget extends WorkflowTarget {
  contentHash: string;
}

/**
 * How long a delete confirmation stays redeemable: the SDK legacy shim's per-round timeout for an
 * elicitation (600 s), the longest a 2025-era client's answer can take to arrive.
 */
const DELETE_CONFIRMATION_TTL_MS = 600_000;

/** Most delete confirmations held at once. Past it the oldest is dropped, and so refused. */
const MAX_PENDING_DELETE_CONFIRMATIONS = 1_000;

/**
 * Why a fresh resolution is not the confirmed target, or undefined when it names the same key,
 * source, and file. A move of the key's file names both paths, since the key alone reads the same.
 */
function describeTargetChange(
  now: WorkflowTarget,
  confirmed: WorkflowTarget,
  requested: string,
): string | undefined {
  const nowLabel = `${now.name}@${now.version} (${now.source})`;
  if (nowLabel !== `${confirmed.name}@${confirmed.version} (${confirmed.source})`) {
    return `Workflow "${requested}" now resolves to ${nowLabel}, not the ${confirmed.name}@${confirmed.version} (${confirmed.source}) that was confirmed`;
  }
  if (now.path !== confirmed.path) {
    return `Workflow ${nowLabel} is now stored at ${now.path}, not at ${confirmed.path} where it was confirmed`;
  }
  return;
}

/** SHA-256 of a file's bytes, hex-encoded. */
async function hashFile(filePath: string): Promise<string> {
  return createHash('sha256')
    .update(await fs.readFile(filePath))
    .digest('hex');
}

/** Outcome of {@link WorkflowIndexService.deleteWorkflow}. */
export interface DeletedWorkflow {
  name: string;
  /**
   * Path, relative to the workflows root, of another file that declares the deleted key and is
   * indexed under it now — present only when the key still resolves after the delete.
   */
  nowIndexedPath?: string;
  version: string;
}

/** Outcome of {@link WorkflowIndexService.writeTemp}. */
export interface TempWriteResult<W extends ParsedWorkflow = ParsedWorkflow> {
  filePath: string;
  status: 'created' | 'overwritten';
  /** The workflow as written — on an overwrite, carrying the replaced draft's `created_date`. */
  workflow: W;
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
  private _shutdown = false;
  /** Tail of the mutation queue — see {@link exclusive}. */
  private _mutationQueue: Promise<void> = Promise.resolve();
  /**
   * Pending delete confirmations by id, in issue order — see {@link requestDeleteConfirmation}.
   * Every entry has the same TTL, so insertion order is also expiry order.
   */
  private readonly _deleteConfirmations = new Map<
    string,
    { confirmed: ConfirmedTarget; expiresAt: number }
  >();
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
    await this.exclusive(() => this.rebuild());
    // initWorkflowIndexService() does not await this, so a shutdown can land mid-build. Starting
    // the watcher afterwards would open a ref'd fs.watch nothing aborts.
    if (this._shutdown) return;
    this.startWatcher();
  }

  /**
   * Release the filesystem watcher and any pending debounced rebuild.
   *
   * Both handles are ref'd — a pending `setTimeout` and an open `fs.watch` keep the event loop
   * alive — so this is what the `createApp({ teardown })` hook calls on every shutdown path. It
   * also bars an in-flight {@link init} from starting a watcher after the fact.
   */
  shutdown(): void {
    this._shutdown = true;
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    this._debounceTimer = undefined;
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

  /**
   * Semver-aware lookup. Returns the highest version match if version is omitted. A given
   * version must already be canonical ({@link canonicalVersion}) — index keys are.
   */
  findWorkflow(name: string, version?: string): WorkflowEntry | undefined {
    if (version) {
      return this._index.get(`${name}@${version}`);
    }
    const matches = this.findByName(name);
    if (matches.length === 0) return;
    matches.sort((a, b) => semver.rcompare(a.workflow.version, b.workflow.version));
    return matches[0];
  }

  // --- Delete confirmations ---

  /**
   * Resolve a delete target the way {@link findWorkflow} does — an omitted version picks the
   * highest across permanent workflows and temporary drafts — hash its file, and record a pending
   * confirmation for it under a random single-use id. The id is all that travels to the client:
   * the record stays here, so a confirmation this server never issued, already redeemed, or let
   * expire ({@link DELETE_CONFIRMATION_TTL_MS}) cannot be presented. Runs in the mutation queue
   * so the hash is of the file the index resolved at that moment. Throws a tagged `not_found`
   * error when nothing matches or the indexed file is already gone.
   */
  async requestDeleteConfirmation(
    name: string,
    version: string | undefined,
  ): Promise<{ id: string; target: WorkflowTarget }> {
    return await this.exclusive(async () => {
      const { entry, target } = this.resolveEntry(name, version);
      const contentHash = await this.hashIndexedFile(entry.filePath, target);

      const now = Date.now();
      for (const [id, pending] of this._deleteConfirmations) {
        const full = this._deleteConfirmations.size >= MAX_PENDING_DELETE_CONFIRMATIONS;
        if (pending.expiresAt > now && !full) break;
        this._deleteConfirmations.delete(id);
      }
      const id = randomUUID();
      this._deleteConfirmations.set(id, {
        confirmed: { ...target, contentHash },
        expiresAt: now + DELETE_CONFIRMATION_TTL_MS,
      });
      return { id, target };
    });
  }

  /**
   * Redeem a pending confirmation: remove it and return its target, or undefined when `id` is not
   * a pending, unexpired confirmation. Removal comes first, so an id works once however the round
   * that presented it turns out.
   */
  takeDeleteConfirmation(id: unknown): ConfirmedTarget | undefined {
    if (typeof id !== 'string') return;
    const pending = this._deleteConfirmations.get(id);
    this._deleteConfirmations.delete(id);
    if (!pending || pending.expiresAt <= Date.now()) return;
    return pending.confirmed;
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

  /**
   * Write a permanent workflow YAML and rebuild the index.
   *
   * The index holds one entry per `name@version` across both sources, so a key held by any
   * indexed workflow — permanent, or a temporary draft — is rejected with a tagged
   * `already_exists` error. The index key is category-independent, so this check (not the `wx`
   * flag, which guards only the one path) is what stops a second file for the key under a
   * different category; {@link exclusive} keeps it valid until the write lands.
   */
  async writePermanent(workflow: ParsedWorkflow): Promise<string> {
    return await this.exclusive(async () => {
      const key = `${workflow.name}@${workflow.version}`;
      const existing = this._index.get(key);
      if (existing) {
        throw taggedError(
          `Workflow "${key}" already exists${existing.isTemp ? ' as a temporary draft' : ''}`,
          'already_exists',
        );
      }

      assertValidName(workflow.name);
      const categorySlug = slugify(workflow.category ?? 'uncategorized');
      // A provided category that slugifies empty (e.g. "!!!") would drop the file into the
      // categories/ root with no subdirectory — reject it as invalid input. The default
      // 'uncategorized' fallback (category omitted) stays safe.
      if (workflow.category !== undefined && !categorySlug) {
        throw taggedError(
          `Workflow category "${workflow.category}" produces an empty slug`,
          'invalid_category',
        );
      }
      if (categorySlug.length > MAX_CATEGORY_SLUG_LENGTH) {
        throw taggedError(
          `Workflow category is too long — keep it to at most ${MAX_CATEGORY_SLUG_LENGTH} characters after slugification`,
          'invalid_category',
        );
      }

      const categoryDir = path.join(this.workflowsDir, 'categories', categorySlug);
      const filePath = path.join(categoryDir, workflowFileName(workflow.name, workflow.version));
      const content = stringifyYaml(workflow, { lineWidth: 0 });
      // `wx` fails atomically if the file already exists.
      const writeExclusive = () =>
        fs.writeFile(filePath, content, { encoding: 'utf-8', flag: 'wx' });

      await fs.mkdir(categoryDir, { recursive: true });
      try {
        await writeExclusive().catch(async (err: unknown) => {
          // Another process's empty-category cleanup can remove the directory between the
          // mkdir and the write. Recreate it and retry once.
          if (errnoCode(err) !== 'ENOENT') throw err;
          await fs.mkdir(categoryDir, { recursive: true });
          await writeExclusive();
        });
      } catch (err: unknown) {
        if (errnoCode(err) === 'EEXIST') {
          throw taggedError(`Workflow "${key}" already exists`, 'already_exists');
        }
        throw err;
      }

      // Immediately rebuild so the index is fresh for the caller.
      // The watcher will also fire and trigger a redundant rebuild — that's fine (idempotent).
      await this.rebuild();
      return filePath;
    });
  }

  /**
   * Write a temporary workflow YAML and rebuild the index.
   *
   * A key held by a permanent workflow is rejected with a tagged `already_exists` error. The
   * target is the indexed draft's own file when the key already has one — including a draft
   * stored under an older filename — else the path {@link workflowFileName} builds. The write
   * itself decides the outcome: an exclusive create reports `created`; one that finds the file
   * already there overwrites it, keeping the replaced draft's `created_date`, and reports
   * `overwritten`.
   */
  async writeTemp<W extends ParsedWorkflow>(workflow: W): Promise<TempWriteResult<W>> {
    return await this.exclusive(async () => {
      const key = `${workflow.name}@${workflow.version}`;
      const existing = this._index.get(key);
      if (existing && !existing.isTemp) {
        throw taggedError(
          `Workflow "${key}" already exists as a permanent workflow`,
          'already_exists',
        );
      }

      assertValidName(workflow.name);
      const filePath =
        existing?.filePath ??
        path.join(this.workflowsDir, 'temp', workflowFileName(workflow.name, workflow.version));
      await fs.mkdir(path.dirname(filePath), { recursive: true });

      let result: TempWriteResult<W>;
      try {
        await fs.writeFile(filePath, stringifyYaml(workflow, { lineWidth: 0 }), {
          encoding: 'utf-8',
          flag: 'wx',
        });
        result = { filePath, status: 'created', workflow };
      } catch (err: unknown) {
        if (errnoCode(err) !== 'EEXIST') throw err;
        const createdDate = existing?.workflow.created_date;
        const replacement =
          createdDate === undefined ? workflow : { ...workflow, created_date: createdDate };
        await fs.writeFile(filePath, stringifyYaml(replacement, { lineWidth: 0 }), 'utf-8');
        result = { filePath, status: 'overwritten', workflow: replacement };
      }

      await this.rebuild();
      return result;
    });
  }

  /**
   * Delete an indexed workflow file — permanent or temporary draft — and rebuild the index.
   *
   * `name` and `version` are re-resolved inside the serialized section ({@link exclusive}), and
   * the file is unlinked only when that resolution is still `confirmed` — the same key, source,
   * and file the user confirmed, with the same bytes. Running the check there means no write can
   * swap the target between the check and the unlink. Only an already-indexed file is ever
   * removed, never a caller-supplied path. Throws a tagged error (`_reason`) for the two domain
   * failures: `not_found` (nothing matches the name, or the name/version pair, or the indexed file
   * is gone) and `target_changed` (the name now resolves to a different version, source, or file
   * than `confirmed`, or that file's content changed). Filesystem errors from the unlink propagate
   * raw for the caller to classify. A category directory the delete empties is removed
   * ({@link removeEmptiedCategoryDir}); `temp/` never is.
   *
   * @returns The deleted workflow's canonical name and version, plus the file now indexed under
   *   that key when another file declares it too.
   */
  async deleteWorkflow(
    name: string,
    version: string | undefined,
    confirmed: ConfirmedTarget,
  ): Promise<DeletedWorkflow> {
    return await this.exclusive(async () => {
      const { entry, target } = this.resolveEntry(name, version);
      const change = describeTargetChange(
        target,
        confirmed,
        `${name}${version ? `@${version}` : ''}`,
      );
      if (change) throw taggedError(change, 'target_changed');
      if ((await this.hashIndexedFile(entry.filePath, target)) !== confirmed.contentHash) {
        throw taggedError(
          `Workflow ${target.name}@${target.version} (${target.source}) at ${target.path} had its content changed after it was confirmed`,
          'target_changed',
        );
      }

      await fs.unlink(entry.filePath);
      await this.removeEmptiedCategoryDir(path.dirname(entry.filePath));

      // Immediately rebuild so the index reflects the removal for the caller.
      // The watcher will also fire and trigger a redundant rebuild — that's fine (idempotent).
      await this.rebuild();
      const { name: deletedName, version: deletedVersion } = entry.workflow;
      const successor = this._index.get(`${deletedName}@${deletedVersion}`);
      return {
        name: deletedName,
        version: deletedVersion,
        ...(successor && { nowIndexedPath: path.relative(this.workflowsDir, successor.filePath) }),
      };
    });
  }

  // --- Internal ---

  /** {@link hashFile} for an indexed entry's file; a file already gone is a tagged `not_found`. */
  private async hashIndexedFile(filePath: string, target: WorkflowTarget): Promise<string> {
    try {
      return await hashFile(filePath);
    } catch (err: unknown) {
      if (errnoCode(err) !== 'ENOENT') throw err;
      throw taggedError(
        `The file for workflow "${target.name}@${target.version}" no longer exists`,
        'not_found',
      );
    }
  }

  /** {@link findWorkflow} plus the entry's {@link WorkflowTarget}; throws tagged `not_found`. */
  private resolveEntry(
    name: string,
    version: string | undefined,
  ): { entry: WorkflowEntry; target: WorkflowTarget } {
    const entry = this.findWorkflow(name, version);
    if (!entry) {
      throw taggedError(
        `No indexed workflow "${name}${version ? `@${version}` : ''}"`,
        'not_found',
      );
    }
    return {
      entry,
      target: {
        name: entry.workflow.name,
        version: entry.workflow.version,
        source: entry.isTemp ? 'temp' : 'permanent',
        path: path.relative(this.workflowsDir, entry.filePath),
      },
    };
  }

  /**
   * Run a mutation once every earlier one has settled. A write or delete checks the index, then
   * touches the filesystem, then rebuilds; interleaving two of those sequences lets both pass the
   * check before either rebuild lands — two creates of one key into different categories would
   * both succeed. Index rebuilds run here too, so a watcher-triggered rebuild that read the disk
   * before a write cannot swap in its stale index after that write's own rebuild. Plain lookups
   * never wait on the queue; a delete confirmation's resolve-and-hash does, so the hash is of the
   * file it resolved. One process serves one directory, so an in-process queue is enough.
   */
  private exclusive<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this._mutationQueue.then(mutation);
    this._mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Remove a category directory a delete just emptied. Only a direct child of `categories/`
   * qualifies — never `categories/` itself, `temp/`, or a nested directory. Non-recursive `rmdir`
   * refuses a directory that still holds any file (another workflow, a note, a `.DS_Store`), so
   * `ENOTEMPTY` — and `ENOENT`, when something else already removed it — is expected and ignored.
   * The workflow is already gone by this point, so any other failure is logged and never fails
   * the delete.
   */
  private async removeEmptiedCategoryDir(dir: string): Promise<void> {
    if (path.dirname(path.resolve(dir)) !== path.resolve(this.workflowsDir, 'categories')) return;
    try {
      await fs.rmdir(dir);
    } catch (err: unknown) {
      const code = errnoCode(err);
      if (code === 'ENOTEMPTY' || code === 'ENOENT') return;
      logWarn(`Failed to remove emptied category directory ${dir}: ${String(err)}`);
    }
  }

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
      logWarn(`Invalid workflow schema at ${filePath}: ${describeIssues(result.error)}`);
      return;
    }

    const workflow = result.data as ParsedWorkflow;

    // Warn if a non-temp file is missing a category
    if (!isTemp && !workflow.category) {
      logWarn(`Permanent workflow missing category field: ${filePath} (name: ${workflow.name})`);
    }

    const key = `${workflow.name}@${workflow.version}`;
    const existing = index.get(key);
    // One entry per key, and a permanent workflow outranks a temp draft. categories/ is scanned
    // before temp/, so a same-key permanent entry is already in place when the draft is read.
    if (existing && !existing.isTemp && isTemp) {
      logWarn(
        `Temporary workflow "${key}" at ${filePath} is shadowed by the permanent workflow at ${existing.filePath} — the permanent entry is indexed`,
      );
      return;
    }
    if (existing) {
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
    this.exclusive(() => this.rebuild()).catch((err) => {
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

/**
 * Release the live service and clear the accessor — the `initWorkflowIndexService` counterpart,
 * called from `createApp({ teardown })`. Idempotent: a second call is a no-op.
 */
export function shutdownWorkflowIndexService(): void {
  _service?.shutdown();
  _service = undefined;
}

export function getWorkflowIndexService(): WorkflowIndexService {
  if (!_service) {
    throw new Error(
      'WorkflowIndexService not initialized — call initWorkflowIndexService() in setup()',
    );
  }
  return _service;
}
