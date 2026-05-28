# workflows-mcp-server — idea & requirements

A declarative workflow library that LLM agents query for multi-step playbooks. The server stores YAML workflow definitions and returns them on request, augmented with global instructions. **It does not execute workflows** — the consuming agent reads the returned plan and orchestrates the steps through its own MCP tool surface.

## Why it exists

LLM agents handling non-trivial tasks benefit from explicit, reusable plans. Hard-coding multi-step logic inside agents is brittle; freeform improvisation drifts. A workflow library gives agents:

- **Reusable plans** — define a sequence once, run it from any session or agent
- **Shared vocabulary** — workflows can be passed between agents by name
- **Centralized policy** — global instructions inject behavioral guidance into every workflow without rewriting them
- **Planning scaffold** — the act of writing a workflow forces the agent to articulate its plan, improving tool-use clarity
- **Discoverability** — categories and tags let an agent ask "what playbooks exist for X?"

This is the same idea behind Cursor "rules" or Cline "workflows", but as a portable MCP service with persistent storage.

## Core concepts

### Workflow

A YAML document describing a multi-step procedure. Schema:

| Field | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Human-friendly; unique with `version` |
| `version` | semver string | yes | Multiple versions of one name can coexist |
| `description` | string | yes | One-liner pitch |
| `author` | string | yes | Person or team |
| `category` | string | yes | Filed under `categories/<slugified>/` |
| `tags` | string[] | no | Free-form, used for filtering |
| `created_date` | YYYY-MM-DD | server-set | Stamped on creation |
| `last_updated_date` | YYYY-MM-DD | server-set | Stamped on creation/update |
| `temporary` | boolean | no | If true, indexed but excluded from list output |
| `steps` | Step[] | yes (min 1) | Ordered sequence |

### Step

One unit of work the consuming agent should perform.

| Field | Type | Required | Notes |
|---|---|---|---|
| `server` | string | yes | Target MCP server name (hint to agent) |
| `tool` | string | yes | Target tool on that server |
| `action` | string | no | Sub-action / variant label |
| `description` | string | no | Why this step exists |
| `params` | object | yes | Key-value map; may contain `{{input.foo}}` placeholders for caller-supplied values |

Placeholder syntax `{{input.foo}}` is a convention for the consuming agent to resolve — the server stores the raw string and returns it verbatim. No interpolation happens server-side.

### Global instructions

A markdown document (default: `global_instructions.md`) prepended/attached to every workflow returned by `get`. Lets the user adjust agent behavior across the entire library without editing individual workflows. Single source of truth for cross-cutting guidance like error handling, parameter clarification, or step-failure policy.

### Temporary workflows

Workflows flagged `temporary: true`. Stored in a separate location (`temp/`), indexed, and retrievable by name — but excluded from list results. Used for:

- One-shot multi-step plans an agent drafts for itself ("collect my thoughts")
- Passing plans between agents by name without polluting the public catalog
- Throwaway scaffolding during longer reasoning chains

## Required tools

Four capabilities are mandatory. Tool names should follow current framework conventions (the design phase decides exact names).

1. **List workflows** — discover what's available. Filters: `category`, `tags` (AND match), optional `includeTools` flag to surface a unique `<server>/<tool>` list per workflow.
2. **Get workflow** — retrieve a complete definition by `name` and optional `version` (latest semver if omitted). Returns the parsed workflow plus the current global instructions text.
3. **Create permanent workflow** — write a new workflow YAML to the appropriate category directory. Reject if `name@version` already exists. Re-index after write. Server stamps the dates.
4. **Create temporary workflow** — same as create permanent, but marks `temporary: true` and writes to `temp/`. Excluded from list results. No conflict check needed (temp is throwaway).

## Required behaviors

- **In-memory index** — load all workflows at startup, keyed by `name@version`. Separate buckets for permanent vs temporary.
- **Filesystem watching** — detect file add/change/remove and rebuild the index automatically. Debounce rapid changes.
- **Semver-aware lookup** — when `version` is omitted on get, return the highest semver match.
- **Persisted index snapshot** — write the current index to a JSON file (`_index.json` or similar) on every rebuild so external tools can introspect without parsing every YAML. The runtime ignores this file when (re)building.
- **Slugification** — workflow names and categories are slugified for filesystem paths (`Standard Git Wrap-up` → `standard-git-wrap-up`). Original `name` and `category` strings are preserved in the YAML body.
- **No execution** — the server is a registry/library. It never calls another MCP server, never resolves `{{input.foo}}`, never sequences steps.

## Storage layout

```
workflows-yaml/
├── _index.json              # auto-generated snapshot; runtime ignores it
├── global_instructions.md   # injected on get
├── categories/
│   └── <slugified-category>/
│       └── <slugified-name>-workflow.yaml
└── temp/
    └── <slugified-name>-workflow.yaml
```

The directory root must be configurable (env var or framework config) so the server works whether installed as an npm package, run from source, or hosted in a container with a mounted volume.

## Worth reconsidering during design

These are open questions the design phase should resolve, not preserved decisions:

- **Tool naming.** Adopt current framework conventions (`workflow_list`, `workflow_get`, `workflow_create`, `workflow_create_temporary` or similar) rather than the legacy verb-noun-mixed names.
- **Storage abstraction.** Use the framework's storage/tenant layer rather than direct `fs` calls — this enables tenant-scoped libraries if hosted, and keeps the implementation aligned with sibling servers.
- **Hosting posture.** Workflows are typically user-owned content (like Obsidian notes). Default model is local-only with a configurable storage root. Per-tenant hosted mode is possible if the storage layer supports it; defer that decision until the storage path is set.
- **File watcher dependency.** `chokidar` was used previously. Evaluate whether the framework already provides a watcher abstraction or whether `node:fs.watch` suffices.
- **Additional tools to consider.** `workflow_update` (vs only create), `workflow_delete`, `workflow_list_categories`, `workflow_get_global_instructions` (read-only access without fetching a full workflow). Decide based on agent ergonomics; don't add unless they earn their slot.
- **Validation depth.** Zod schemas for input are required. Decide whether to validate loaded YAML files at index time and surface invalid ones in the index (with an `errors` field) or silently skip them with logs.

## Out of scope

- Step execution / orchestration. The server returns plans; the agent runs them.
- Template variable resolution. `{{input.foo}}` is a hint to the consuming agent; the server never interpolates.
- LLM calls. No sampling, no completion. Pure data layer.
- Authentication of workflow authors. Whoever can write to the storage root can create workflows. Layer auth at the MCP transport level via the framework if needed.

## Seed content

`workflows-yaml/` has been pre-populated with the migrated workflow library — categories include git operations, GitHub operations, research operations, web operations, testing, and several personal-project workflow sets. These provide working examples of the schema and exercise category/tag filtering during development. They are not authoritative content; treat them as fixtures the design and test phases can reference and prune as needed.
