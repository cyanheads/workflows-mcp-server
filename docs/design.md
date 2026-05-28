# workflows-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `workflow_list` | List workflows from the index. Filters by category, tags (AND match), and optionally surfaces the unique `<server>/<tool>` pairs used across each matching workflow's steps. Temporary workflows are excluded. | `category?`, `tags?`, `includeTools?` | `readOnlyHint: true`, `openWorldHint: false` |
| `workflow_get` | Retrieve a complete workflow definition by name plus the current global instructions text. When `version` is omitted, returns the highest semver match. | `name`, `version?` | `readOnlyHint: true`, `openWorldHint: false` |
| `workflow_create` | Write a new permanent workflow YAML to `categories/<slugified-category>/`. Rejects if `name@version` already exists. Server stamps `created_date` and `last_updated_date`. Rebuilds the index and snapshot after write. | `name`, `version`, `description`, `author`, `category`, `steps[]`, `tags?` | `idempotentHint: false` |
| `workflow_create_temp` | Write a temporary workflow to `temp/`. Sets `temporary: true`, skips conflict checks (temp is throwaway). Stamps dates. Excluded from `workflow_list` results but accessible via `workflow_get`. | Same as `workflow_create` minus `category` | `idempotentHint: false` |

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

- In-memory index keyed by `name@version`, built at startup, rebuilt on filesystem change
- Permanent workflows live under `categories/<slugified-category>/`, temp workflows under `temp/`
- Semver-aware lookup: when `version` is omitted on `workflow_get`, return the highest semver match
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
| `WorkflowIndexService` | Local filesystem (`node:fs/promises`) + watcher | All four tools |

`WorkflowIndexService` owns: initial index build, filesystem watcher lifecycle, semver-aware lookup, write operations (permanent + temp), index snapshot writes.

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

Each step is independently testable before the next is added.

---

## Domain Mapping

### Workflow schema (Zod)

The `WorkflowSchema` is the Zod shape the index service validates every loaded YAML against.

```
WorkflowSchema = z.object({
  name:              z.string().min(1)
  version:           z.string().regex(/^\d+\.\d+\.\d+/)   // semver, basic check
  description:       z.string().min(1)
  author:            z.string().min(1)
  category:          z.string().min(1).optional()           // required for permanent workflows, absent for temp
  tags:              z.array(z.string()).optional()
  created_date:      z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional()
  last_updated_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional()
  temporary:         z.boolean().optional()
  steps:             z.array(StepSchema).min(1)
})

StepSchema = z.object({
  server:      z.string().min(1)
  tool:        z.string().min(1)
  action:      z.string().optional()
  description: z.string().optional()
  name:        z.string().optional()    // some seed files use step-level names
  params:      z.record(z.unknown()).optional()
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

This means the seed directories with underscores (`git_operations`, `github_operations`, `research_operations`, `web_operations`) will be treated as equivalent to `git-operations` etc. **when reading** — the index scans all files in `categories/` recursively and applies the slug rule to infer the category. **When writing**, new workflows always use kebab-case. The seed files are fixtures and their directory names don't need renaming.

---

## Error Contracts

### `workflow_list`

| Reason | Code | When | Recovery |
|:-------|:-----|:-----|:---------|
| `index_unavailable` | `ServiceUnavailable` | Index has not been built yet (watcher not started or initial build failed) | Retry after the server has finished initializing its workflow index. |

### `workflow_get`

| Reason | Code | When | Recovery |
|:-------|:-----|:-----|:---------|
| `not_found` | `NotFound` | No workflow matches the given `name` (with or without `version`) | Use `workflow_list` to discover available workflow names and verify spelling. |
| `version_not_found` | `NotFound` | Name exists but the specific `version` does not | Omit `version` to get the latest, or use `workflow_list` to see available versions for this name. |
| `index_unavailable` | `ServiceUnavailable` | Index not ready | Retry after the server has finished initializing its workflow index. |

### `workflow_create`

| Reason | Code | When | Recovery |
|:-------|:-----|:-----|:---------|
| `already_exists` | `Conflict` | `name@version` already exists in the permanent index | Change the version field or use a different name to avoid the conflict. |
| `invalid_steps` | `ValidationError` | `steps` array is empty or a step is missing required `server`/`tool` fields | Each step must have `server` and `tool` fields; provide at least one step. |
| `write_failed` | `InternalError` | Filesystem write error (permissions, disk full) | Check that the workflows directory is writable and has sufficient disk space. |

### `workflow_create_temp`

| Reason | Code | When | Recovery |
|:-------|:-----|:-----|:---------|
| `invalid_steps` | `ValidationError` | Same as `workflow_create` | Each step must have `server` and `tool` fields; provide at least one step. |
| `write_failed` | `InternalError` | Same as `workflow_create` | Check that the workflows directory is writable and has sufficient disk space. |

---

## Design Decisions

| Topic | Decision | Reasoning |
|:------|:---------|:---------|
| **Tool names** | `workflow_list`, `workflow_get`, `workflow_create`, `workflow_create_temp` | Standard `{prefix}_{verb}_{noun}` pattern. `_create_temp` is a two-word noun warranting 4 segments; it's clearer than `workflow_create_temporary` (too long) or a `mode` enum on `workflow_create` (complicates output schema and conflict semantics — temp skips conflict checks). |
| **Storage abstraction** | Direct `node:fs/promises`, not `ctx.state` / framework `StorageService` | `ctx.state` is a tenant-scoped KV store for ephemeral, request-scoped data. It's not suited for file content, directory trees, or watcher lifecycles. The data source is a user-owned directory on the local filesystem — `fs` is the correct primitive. The framework's storage layer adds complexity with no benefit here. |
| **Filesystem watcher** | `node:fs/promises watch` (`fs.watch` recursive) via `AbortController` | Bun and Node ≥22 both support `fs.watch` with `{ recursive: true }`. No external dependency needed. `chokidar` was the legacy choice but adds 2+ transitive deps (`fsevents`, etc.) for functionality that `node:fs` now covers. If `recursive` watch proves unreliable across platforms, the fallback is `chokidar` — but v1 starts with zero extra deps. |
| **`workflow_update`** | Dropped | An update is a create with a new version string — the consuming agent already knows the name@version convention. Adding `workflow_update` would create ambiguity (does it bump the version? overwrite in place?) without clarity. Agents that need to revise a workflow create a new version. |
| **`workflow_delete`** | Dropped | Filesystem deletion is irreversible. Staying out of delete territory keeps the server's blast radius minimal. Deletion is a human operation via the filesystem. |
| **`workflow_list_categories`** | Dropped | `workflow_list` without filters already returns all workflows; category names are discoverable from the `category` field in results. A dedicated tool adds surface without adding capability. |
| **`workflow_get_global_instructions`** | Dropped | Global instructions are always returned with `workflow_get`. Exposing them separately is a minor convenience that doesn't earn a slot. If an agent needs instructions without a workflow, it calls `workflow_get` on any workflow — or reads the file directly. |
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

- **No deduplication across seed directories.** The seed has both `research_operations/` and `research-operations/` directories with different workflows. The index will have both. If two files share a `name@version`, the second one encountered wins (last-write semantics) with a warning logged.
- **Recursive `fs.watch` on macOS/Bun.** Bun's `fs.watch({ recursive: true })` is well-supported on macOS but has known edge cases on some Linux setups. If the watcher produces false-positive or missed events in production, adding `chokidar` is the upgrade path.
- **Semver validation is basic.** The Zod pattern `/^\d+\.\d+\.\d+/` accepts `1.0.0` but also `1.0.0-beta` and `1.0.0.extra`. A stricter semver regex is possible but the seed data uses clean `major.minor.patch` strings throughout — the loose check is sufficient for v1.
