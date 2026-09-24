# workflows-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `workflow_list` | List workflows from the index. Filters by keyword, category, tags (AND match), each trimmed of surrounding whitespace, and optionally surfaces the unique `<server>/<tool>` pairs used across each matching workflow's steps. Sorted by name, then semver precedence descending. Temporary workflows are excluded. | `query?`, `category?`, `tags?`, `includeTools?` | `readOnlyHint: true`, `openWorldHint: false` |
| `workflow_get` | Retrieve a complete workflow definition by name plus the current global instructions text. When `version` is omitted, returns the highest semver match. A non-semver `version` is rejected as invalid arguments; a tolerated spelling is canonicalized before lookup. `name` is trimmed before lookup; a blank one is rejected as invalid arguments. | `name`, `version?` | `readOnlyHint: true`, `openWorldHint: false` |
| `workflow_create` | Write a new permanent workflow YAML to `categories/<slugified-category>/`. Rejects if `name@version` is already indexed, as a permanent workflow or a temporary draft. Stores the canonical semver `version`; rejects whitespace-only required text. Server stamps `created_date` and `last_updated_date`. Rebuilds the index and snapshot after write. | `name`, `version`, `description`, `author`, `category`, `steps[]`, `tags?` | `idempotentHint: false` |
| `workflow_create_temp` | Write a temporary workflow to `temp/`. Sets `temporary: true`. Overwrites an existing draft of the same `name@version` in place and reports `status: "overwritten"` (keeping the draft's `created_date`), else `"created"`; rejects a key a permanent workflow holds. Stamps dates. Excluded from `workflow_list` results but accessible via `workflow_get`; the temporary notice rides in the `enrichment` `notice` field. Drafts persist until `workflow_delete` removes them; nothing expires them. | Same as `workflow_create` minus `category` | `idempotentHint: false` |
| `workflow_delete` | Delete a permanent workflow or a temporary draft by name and optional version; omitting version selects the highest across both sources. Same `name` trimming and `version` validation and canonicalization as `workflow_get`. The first call records a confirmation server-side (target plus a SHA-256 of the file bytes) and returns an `input_required` prompt (`ctx.requestInput` with an `inputRequired.elicit` form, `{ confirm: boolean }`) naming the resolved `name@version`, its source, and its path relative to `WORKFLOWS_DIR`; `requestState` carries only the record's random id. The re-entered call redeems the id first (single use, 600 s), then unlinks only on an accepted `confirm: true` whose record still matches a fresh resolution and hash. Output carries `source`; an `enrichment` `notice` names the file now indexed under the key when another file declares it. Removes a `categories/<slug>/` directory the delete empties; never `temp/`. | `name`, `version?` | `destructiveHint: true`, `idempotentHint: false`, `openWorldHint: false` |

### Resources

None. The entire surface is covered by tools — all read operations are accessible via `workflow_list` and `workflow_get`. Resources are not worth the overhead when `workflow_get` already returns the full definition plus global instructions as a structured response.

### Prompts

None. This is a pure data layer — no recurring LLM interaction patterns warrant prompting.

---

## Overview

A declarative workflow library MCP server. LLM agents query it for multi-step playbooks defined as YAML files. The server stores definitions in a local directory tree, indexes them at startup, and returns them on request with the current global instructions prepended. **It does not execute workflows** — the consuming agent reads the returned plan and orchestrates the steps through its own MCP tool surface.

There is no external API. The data source is the local filesystem (`workflows-yaml/`). No API keys, no HTTP clients, no rate limits.

---

## Requirements

- In-memory index keyed by `name@version`, built at startup, rebuilt on filesystem change — one entry per key across permanent and temp sources, enforced at write time in both directions; on disk, a permanent file outranks a same-key temp file
- Permanent workflows live under `categories/<slugified-category>/`, temp workflows under `temp/`, each file named from its key (see Filenames)
- Writes and deletes run one at a time in-process: each check → write → rebuild sequence completes before the next begins
- Semver-aware lookup: when `version` is omitted on `workflow_get`, return the highest semver match
- One version identity: the canonical `semver.valid()` string. Create tools persist it (written YAML, index key, returned `key`), the loader canonicalizes each parsed `version`, and `workflow_get`/`workflow_delete` canonicalize their input before lookup
- Required text fields (`name`, `description`, `author`, `category`, step `server`/`tool`) must carry non-whitespace content, enforced by the same `WorkflowSchema` at load time and before either create tool writes
- Filesystem watcher detects add/change/remove and rebuilds the index; debounce rapid changes. Note: when `workflow_create` writes a file, the watcher will also fire and trigger a redundant rebuild — this is acceptable (the rebuild is idempotent and debounced); no special gating is needed.
- Index snapshot written to `workflows-yaml/_index.json` on every rebuild; runtime ignores this file during (re)builds
- `global_instructions.md` content prepended to every `workflow_get` response
- Slugification uses kebab-case throughout: `"Git Operations"` → `"git-operations"`, `"Standard Git Wrap-up"` → `"standard-git-wrap-up"`
- YAML files validated at index time; invalid files are skipped and logged — they do not block the index
- Template placeholders (`{{input.foo}}`) are opaque strings — returned verbatim, never interpolated server-side
- Local-only by default; configurable workflows root via env var

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `WorkflowIndexService` | Local filesystem (`node:fs/promises`) + watcher | All five tools |

`WorkflowIndexService` owns: initial index build, filesystem watcher lifecycle, semver-aware lookup, permanent and temporary writes, pending delete confirmations, deletion of either kind against a confirmed target, and index snapshot writes.

No `StorageService` (framework KV). See Decisions Log.

---

## Config

| Env Var | Required | Default | Description |
|:--------|:---------|:--------|:------------|
| `WORKFLOWS_DIR` | No | `./workflows-yaml` | Absolute or relative path to the workflows root directory. Resolved relative to CWD at startup. |
| `GLOBAL_INSTRUCTIONS_PATH` | No | `${WORKFLOWS_DIR}/global_instructions.md` | Path to the global instructions markdown file. If missing, `globalInstructions` in `workflow_get` response is `null` and the tool notes its absence. |
| `WATCHER_DEBOUNCE_MS` | No | `500` | Milliseconds to debounce filesystem change events before rebuilding the index. |

All three go in `src/config/server-config.ts` via `parseEnvConfig`.

---

## Implementation Order

1. Config — `src/config/server-config.ts` with the three env vars above
2. `WorkflowIndexService` — Zod schema, YAML parsing, index build, watcher, snapshot, write helpers
3. `workflow_list` — read-only, exercises the index and filter logic
4. `workflow_get` — read-only, exercises semver lookup and global instructions injection
5. `workflow_create` — write path for permanent workflows
6. `workflow_create_temp` — write path for temp workflows (simpler variant of create)
7. `workflow_delete` — confirm with the user, then remove a permanent workflow or a draft and refresh the index

Each step is independently testable before the next is added.

---

## Domain Mapping

### Workflow schema (Zod)

The `WorkflowSchema` is the Zod shape the index service validates every loaded YAML against.

```
WorkflowSchema = z.object({
  name:              requiredText()                         // z.string().refine(v => v.trim().length > 0)
  version:           z.string().transform(v => semver.valid(v))   // non-semver fails; parsed value is canonical
  description:       requiredText()
  author:            requiredText()
  category:          requiredText().optional()              // required for permanent workflows, absent for temp
  tags:              z.array(z.string()).nullable().optional().transform(v => v ?? undefined)
  created_date:      z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional()
  last_updated_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional()
  temporary:         z.boolean().optional()
  steps:             z.array(StepSchema).min(1)
})

StepSchema = z.object({
  server:      requiredText()
  tool:        requiredText()
  action:      z.string().optional()
  description: z.string().optional()
  name:        z.string().optional()    // some seed files use step-level names
  params:      z.record(z.string(), z.unknown()).optional()
  forEach:     z.string().optional()    // seed data uses this; stored as opaque string
})
```

**Validation stance: lenient (skip + log).** Invalid files are logged at `warning` level with the file path and parse error summary. They are excluded from the index. The index build continues; invalid files never crash the server. No `errors` field on index entries — a workflow either indexed successfully or it didn't.

**Note on `category` for temp workflows.** The `WorkflowSchema.category` field is optional (see above). At index time, the service must enforce the permanent/temp distinction at the application level: permanent workflows written by `workflow_create` must always include a category (the tool validates this before calling the service), while temp workflows written by `workflow_create_temp` omit it. This means a permanent workflow file that is missing a `category` will still pass schema validation — it will load, but `category` will be undefined. The index builder should emit a warning when a non-temp file is missing a `category`.

### Index shape

```
type WorkflowIndex = Map<string, WorkflowEntry>  // key = "name@version"

type WorkflowEntry = {
  workflow: ParsedWorkflow    // validated, parsed YAML
  filePath: string            // absolute path
  isTemp: boolean
}
```

The semver lookup for `workflow_get` with no version: collect all entries matching the name, sort by semver descending, return the first.

### `workflow_get` output schema

```
{
  workflow:            ParsedWorkflow    // full validated workflow object
  globalInstructions:  string | null     // content of global_instructions.md, or null if file missing
  source:              'permanent' | 'temp'
}
```

`globalInstructions` is `null` (not omitted) when the file is missing, so callers can distinguish "no instructions file" from a fetch error. The tool notes the absence in its text output.

**Build note:** every Zod input and output field in tool definitions must have `.describe()`. This is enforced by the framework linter (`lint:mcp` / `devcheck`).

### Slugification

Single rule: lowercase, replace any non-alphanumeric run with a single hyphen, trim leading/trailing hyphens.

```
"Git Operations"        → "git-operations"
"Standard Git Wrap-up"  → "standard-git-wrap-up"
"web_operations"        → "web-operations"       (underscores treated as separators)
"project-chimera"       → "project-chimera"      (already clean)
```

The index scans all files in `categories/` recursively and reads the category from each workflow's YAML, regardless of its directory name. New writes always use kebab-case directories. Existing seed directories with underscores do not need renaming.

A category that slugifies to empty (`"!!!"`) or to more than 255 characters — the limit on one directory name — is rejected as `invalid_input`. A name that slugifies to empty is not — see Filenames.

### Filenames

```
<name-slug>-<version-slug>-<hash>-workflow.yaml
"Git Wrap-up" @ 1.0.0      → git-wrap-up-1-0-0-<hash>-workflow.yaml
"Рабочий процесс" @ 1.0.0  → workflow-1-0-0-<hash>-workflow.yaml
```

- `<hash>` is the first 8 hex characters of SHA-256 over the stored key, `name@<canonical version>`. Slugs are lossy — case, punctuation, and non-ASCII letters collapse — so the hash is what keeps distinct keys (`Deploy` / `deploy`, `Slug A+B` / `Slug A B`, `1.0.0-RC1` / `1.0.0-rc1`) at distinct paths, on case-insensitive filesystems too.
- The filename is a pure function of the key, so the `wx` write flag still guards concurrent writes of one key.
- A name with no ASCII letters or digits uses the fixed name part `workflow`; only a blank name is invalid. A name slug over 200 characters is rejected (`name_too_long`), and the version part is cut to 31 characters, so every filename fits the 255-byte limit.
- Identity comes from file content, never the filename, so files under any older naming need no migration. A temp write to a key whose draft is indexed targets that draft's existing file.
- `workflow_delete` removes the file's parent directory, with a non-recursive `rmdir`, when that directory is a direct child of `categories/` and now empty; `categories/`, `temp/`, and nested directories are never touched. `workflow_create` recreates its category directory and retries once if a cleanup elsewhere removed it mid-write.

---

## Error Contracts

### `workflow_list`

| Reason | Code | When | Recovery |
|:-------|:-----|:-----|:---------|
| `index_unavailable` | `ServiceUnavailable` | Index has not been built yet (watcher not started or initial build failed) | Retry after the server has finished initializing its workflow index. |

### `workflow_get`

| Reason | Code | When | Recovery |
|:-------|:-----|:-----|:---------|
| `not_found` | `NotFound` | No workflow matches the given `name` (with or without `version`) | Use `workflow_list` to see permanent workflow names (temporary drafts are not listed; use the key `workflow_create_temp` returned), then check the spelling. |
| `version_not_found` | `NotFound` | Name exists but the specific `version` does not | Omit `version` to get the latest, or use `workflow_list` to see permanent versions (drafts are not listed; use the key `workflow_create_temp` returned). |
| `index_unavailable` | `ServiceUnavailable` | Index not ready | Retry after the server has finished initializing its workflow index. |

### `workflow_create`

| Reason | Code | When | Recovery |
|:-------|:-----|:-----|:---------|
| `already_exists` | `Conflict` | `name@version` is already indexed, as a permanent workflow or a temporary draft | Change the version or name; if a temporary draft holds the key, delete it with `workflow_delete` and retry. |
| `invalid_input` | `ValidationError` | A whitespace-only name, description, author, category, or step server/tool; a category that slugifies to empty; or a workflow name or category that exceeds its length limit after slugification | Give every required text field visible content, use a category with alphanumeric characters, and keep the slugified name to at most 200 characters and the slugified category to at most 255. |
| `write_failed` | `InternalError` | Filesystem write error (permissions, disk full); the message keeps the error code and description and drops the path | Check that the workflows directory is writable and has sufficient disk space. |

### `workflow_create_temp`

| Reason | Code | When | Recovery |
|:-------|:-----|:-----|:---------|
| `invalid_input` | `ValidationError` | A whitespace-only name, description, author, or step server/tool, or a workflow name that exceeds the filename length limit after slugification | Give every required text field visible content and keep the name to at most 200 characters after slugification. |
| `already_exists` | `Conflict` | A permanent workflow holds this `name@version` | Choose a different version or name for the draft, or read the permanent workflow with `workflow_get`. |
| `write_failed` | `InternalError` | Same as `workflow_create` | Check that the workflows directory is writable and has sufficient disk space. |

Schema-invalid tool arguments return `InvalidParams` (`data.reason: invalid_arguments`) before the handler runs — including a `version` that is not valid semver on any of the four tools that take one.

### `workflow_delete`

| Reason | Code | When | Recovery |
|:-------|:-----|:-----|:---------|
| `not_found` | `NotFound` | No permanent workflow or draft matches the name and optional version, or its indexed file is already gone — on the first call, or on the confirming call when the target was removed in between | Use `workflow_list` to see permanent names and versions (drafts are not listed; use the key `workflow_create_temp` returned). |
| `cancelled` | `InvalidRequest` (logged at `notice`) | The user answered `confirm: false`, declined, or cancelled the prompt; an accepted answer that is not `{ confirm: boolean }` counts the same | Nothing was deleted; don't re-ask unless the user asks again. |
| `confirmation_invalid` | `InvalidRequest` | The accepted answer carries no confirmation id the server issued and has not yet redeemed: missing, unknown, already used, or older than 600 s | Nothing was deleted; call again with only `name` and `version` so the user is asked. |
| `target_changed` | `Conflict` | On the confirming call the input resolves to a different `name@version`, source, or file than the prompt named, or the file's bytes no longer match the hash taken when the prompt was issued. When only the file moved, the message names both relative paths; when only the content changed, it says so | Nothing was deleted; call again so the user confirms the current target, or pin `version`. |
| `delete_failed` | `InternalError` | Reading the file for the prompt, or deleting it, fails; the message keeps the error code and description and drops the path | Check that the file is readable and the workflows directory is writable. |
| `index_unavailable` | `ServiceUnavailable` | Index is not ready | Retry after initialization. |

A client that cannot answer the prompt is refused by the framework (`client_capability_missing`) or, on the 2026-07-28 revision, by the SDK (`-32021`); nothing is deleted.

---

## Design Decisions

| Topic | Decision | Reasoning |
|:------|:---------|:---------|
| **Tool names** | `workflow_list`, `workflow_get`, `workflow_create`, `workflow_create_temp`, `workflow_delete` | Separate operations keep permanent creation, temporary overwrite, and confirmed deletion semantics explicit. |
| **Storage abstraction** | Direct `node:fs/promises`, not `ctx.state` / framework `StorageService` | `ctx.state` is a tenant-scoped KV store for ephemeral, request-scoped data. It's not suited for file content, directory trees, or watcher lifecycles. The data source is a user-owned directory on the local filesystem — `fs` is the correct primitive. The framework's storage layer adds complexity with no benefit here. |
| **Filesystem watcher** | `node:fs/promises watch` (`fs.watch` recursive) via `AbortController` | Bun and Node ≥22 both support `fs.watch` with `{ recursive: true }`. No external dependency needed. `chokidar` was the legacy choice but adds 2+ transitive deps (`fsevents`, etc.) for functionality that `node:fs` now covers. If `recursive` watch proves unreliable across platforms, the fallback is `chokidar` — but v1 starts with zero extra deps. |
| **`workflow_update`** | Dropped | An update is a create with a new version string — the consuming agent already knows the name@version convention. Adding `workflow_update` would create ambiguity (does it bump the version? overwrite in place?) without clarity. Agents that need to revise a workflow create a new version. |
| **`workflow_delete`** | Deletes permanent workflows and drafts, marked destructive, gated on a user confirmation round | An omitted `version` deletes the newest match, so an under-specified call must not unlink on its own. The consent comes from the user through an elicitation form, not an input `confirm` field the model would fill in, and there is no proceed-when-unavailable fallback: a client that cannot answer cannot delete. `version` stays optional because the prompt names the version it resolved. |
| **Delete confirmation record** | The first call stores `{ target, contentHash, expiresAt }` in an in-process map under a `crypto.randomUUID()` id and sends only the id as `requestState`. The answering call removes the id before anything else; a missing, unknown, used, or expired id fails `confirmation_invalid`. Records live 600 s (the SDK legacy shim's per-round elicitation timeout); expired ones are pruned on each new prompt, and at most 1,000 are held, oldest dropped first | `requestState` round-trips through the client, and neither the SDK nor the handler could tell a state the server issued from one the client wrote: a first call carrying an accepted answer and a hand-built target deleted with no prompt at all, and a replayed round deleted again once the key was recreated. A record only the server holds, redeemed once, means every delete follows a prompt this server issued. One process serves one directory, so an in-process map is the right scope; a record lost to a restart fails closed. A separate reason from `target_changed` because nothing about the workflow changed — the answer itself is not one this server is waiting for — and callers and logs should tell a stale or forged answer from a moved file. |
| **Confirmed-target check** | Inside its serialized delete the service re-resolves the input and unlinks only when name, version, source, and relative path match the record, and a fresh SHA-256 of the file bytes matches the one taken when the prompt was issued; any mismatch fails `target_changed` | A newer version, a moved file, or new content at the same path between prompt and answer must not turn the user's yes into a delete of something they never saw — deleting and recreating a key, or a `workflow_create_temp` overwrite of a draft, lands at the same path, so only the bytes tell them apart. Checking inside the mutation queue means no write through this server can land between the check and the unlink; the prompt itself never runs while the queue is held. |
| **Key still resolving after a delete** | Deletion succeeds, and an `enrichment` `notice` names the file now indexed under the key, relative to `WORKFLOWS_DIR` | Hand-authored files can share a `name@version`; the index holds one and the rest wait behind it. The user confirmed one file, so only that file goes, but the caller must learn that `workflow_get` now returns a different copy rather than nothing. |
| **Session mode** | `createApp({ sessionMode: { default: 'stateful', require: 'stateful' } })`; the Dockerfile and `.env.example` set `stateful` | A 2025-era HTTP client answers the confirmation round only over a live session. Under stateless serving the elicitation is refused, so no such client could ever delete; `require` turns that into a startup `ConfigurationError`. Stdio and 2026-07-28 clients work in either mode. |
| **Temporary drafts** | Persist until deleted with `workflow_delete`; no TTL, expiry, or cleanup sweep | There is no session to scope a draft to over stdio or on the 2026-07-28 revision, and over HTTP the session mode is a deployment setting. A timer that deletes files from a user-owned directory is worse than an explicit delete. |
| **`workflow_list_categories`** | Dropped | `workflow_list` without filters already returns all workflows; category names are discoverable from the `category` field in results. A dedicated tool adds surface without adding capability. |
| **`workflow_get_global_instructions`** | Dropped | Global instructions are always returned with `workflow_get`. Exposing them separately is a minor convenience that doesn't earn a slot. If an agent needs instructions without a workflow, it calls `workflow_get` on any workflow — or reads the file directly. |
| **Version identity** | The canonical `semver.valid()` string, applied on every write, load, and lookup | Index keys are `name@version`, so a spelling stored verbatim (`v1.0.0`) was unreachable by its canonical form. Canonicalizing everywhere makes one spelling per version; build metadata is dropped, which matches `semver.rcompare` already ignoring it for ordering. Input schemas stay JSON-Schema-serializable, so tools validate with `.refine` and canonicalize in the handler. |
| **Filenames** | Readable slugs plus an 8-hex SHA-256 prefix of the stored key | Lossy slugs alone mapped distinct keys to one path: a permanent create misreported `already_exists`, a temp write replaced another key's draft, and non-Latin names had no slug to store. The hash carries identity, so the slug is readability only; old-named files need no migration because identity comes from content. |
| **Cross-source keys** | One index entry per `name@version`; each create rejects a key the other source holds, and a rebuild keeps the permanent entry of an on-disk pair | A same-key temp draft replaced the permanent entry in the index, hiding it from `workflow_list` and making it undeletable. Rejecting at write time keeps the index and the disk in agreement; deleting the draft is the promote path. |
| **Temp overwrite outcome** | Exclusive create first; `EEXIST` means overwrite, reported as `overwritten` | The write decides the outcome, so there is no check-then-act stat. An overwrite keeps the draft's `created_date`. The temporary notice moved from `format()` to `enrichment` so `structuredContent` clients see it too. |
| **Write serialization** | In-process promise queue around each check → write → rebuild, and around index rebuilds | Two creates of one key into different categories both passed the index check before either rebuild ran. One process serves one directory, so an in-process queue closes the gap; lookups stay lock-free. |
| **Emptied category directories** | Removed by `workflow_delete` with non-recursive `rmdir`, direct children of `categories/` only | `workflow_create` creates category directories implicitly, so the tool that empties one removes it. `rmdir` refuses a non-empty directory atomically; a failure is logged, never fails the delete. |
| **Blank required text** | Rejected at both edges through the one `WorkflowSchema` | Create tools run the loader's schema over the workflow they are about to write (`invalid_input`), so they never write a file a rebuild would skip. Empty strings still fail the input schema's `min(1)` first. |
| **Name lookup** | `workflow_get` and `workflow_delete` trim `name` before lookup; a blank `name` fails the input schema | The create tools store the trimmed name, so a lookup of the padded form it was created with must find it. A name that trims to nothing names no workflow, so it is invalid arguments rather than `not_found`. |
| **Slug length bounds** | Name slug at most 200 characters, category slug at most 255, both rejected as `invalid_input` before any filesystem call; `write_failed` messages drop everything from the syscall on | Each is one path component under the 255-byte limit — the name shares its component with the version, hash, and suffix. Unbounded, a long category failed in `mkdir` as `write_failed`, and the scrub that only knew `open '…'` let the absolute path through; cutting from the syscall on also survives a path that contains a quote. |
| **Validation stance** | Lenient (skip + log invalid files) | The seed data has real inconsistencies: missing `category` fields, YAML comments, step-level `name` fields not in the schema. Strict rejection would leave the server unable to index a substantial fraction of the seed. Lenient indexing with warning logs is safer during v1 — agents see a partial index that's honest about what loaded, rather than a server that refuses to start. |
| **Index persistence (`_index.json`)** | Keep, at `workflows-yaml/_index.json` | External tools and debug workflows benefit from a JSON snapshot. Cost is trivial (async write on each rebuild). The file is generated content — runtime ignores it when rebuilding. Path stays at the root of the workflows dir; no reason to relocate. |
| **Global instructions path** | Configurable via `GLOBAL_INSTRUCTIONS_PATH` env var, defaults to `${WORKFLOWS_DIR}/global_instructions.md` | Fixed path in the seed data works for most users; a configurable override handles edge cases (Docker mounts, multi-root setups). Missing file is non-fatal — `workflow_get` returns `globalInstructions: null` and notes it in the output. |
| **Template placeholders** | Opaque — server never interpolates | `{{input.foo}}`, `{{steps.X.output.Y}}`, `{{now | date: …}}` are all conventions between the workflow author and the consuming agent. The server is a registry; it returns strings verbatim. This is explicit in the schema (`params: z.record(z.unknown())`) and in the tool descriptions. |
| **Slugification** | Kebab-case, underscores treated as separators | idea.md specifies `"Standard Git Wrap-up" → "standard-git-wrap-up"`. Consistent with the project's naming conventions and modern URL idioms. Seed directories with underscores are read as-is (the indexer traverses recursively regardless of directory name); new writes always produce kebab-case directories. |
| **Seed directory inconsistency** | Read all, write kebab | The seed has both `git_operations/` and `research-operations/` style dirs. Rather than rename them (which would break any existing refs), the indexer scans `categories/` fully recursively. New `workflow_create` calls always produce `categories/<kebab-name>/`. Over time, the library naturally migrates to kebab-case. |
| **Hosting posture** | Local-only for v1 | Workflows are user-owned content (analogous to Obsidian notes). The configured root is a local filesystem path. Per-tenant hosted mode would require `ctx.state`-backed storage, which is the wrong abstraction for this data shape. Defer until there's a concrete hosted use case. |
| **Auth scopes** | None for v1 | stdio-only default; local personal use. The framework's auth layer can be added later at the transport level without touching tool definitions. |
| **Step `name` field** | Added as optional in schema | The seed's `pubmed-research-workflow.yaml` uses step-level `name` fields. Excluding it would mark valid seed content as invalid. Adding it as optional (`z.string().optional()`) costs nothing and improves schema accuracy. |
| **`forEach` step field** | Added as optional opaque string | Same seed file uses `forEach` constructs. The server treats them as opaque (no execution); including them in the schema allows accurate round-tripping. |

---

## Known Limitations

- **No deduplication across seed directories.** The seed has both `research_operations/` and `research-operations/` directories with different workflows. The index will have both. If two permanent files (or two temp files) share a `name@version` — including two spellings that canonicalize to the same version, such as `v1.0.0` and `1.0.0` — the second one encountered wins (last-write semantics) with a warning logged. A permanent and a temp file sharing a key always resolve to the permanent one.
- **Write serialization is per process.** Two server processes pointed at one `WORKFLOWS_DIR` do not share the write queue; only the same-path `wx` guard and the category-directory retry hold across them.
- **Recursive `fs.watch` on macOS/Bun.** Bun's `fs.watch({ recursive: true })` is well-supported on macOS but has known edge cases on some Linux setups. If the watcher produces false-positive or missed events in production, adding `chokidar` is the upgrade path.
