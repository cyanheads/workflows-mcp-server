<div align="center">
  <h1>@cyanheads/workflows-mcp-server</h1>
  <p><b>Store, query, and create YAML workflow playbooks for LLM agents via MCP. STDIO or Streamable HTTP.</b>
  <div>5 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/workflows-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/workflows-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/workflows-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/workflows-mcp-server/releases/latest/download/workflows-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=workflows-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvd29ya2Zsb3dzLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22workflows-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fworkflows-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

A declarative workflow library for LLM agents, backed by local YAML files. Store, list, and retrieve named, versioned multi-step playbooks — each a sequence of MCP server/tool calls — for permanent reuse or one-shot temporary runs. Runs as a stdio process or a local Streamable HTTP server; an in-memory index rebuilds automatically as files change.

### Tools

| Tool | Description |
|:-----|:------------|
| `workflow_list` | List all permanent workflows in the index, with optional keyword, category, and tag filters. |
| `workflow_get` | Retrieve a complete workflow definition by name, with global instructions prepended. |
| `workflow_create` | Write a new permanent workflow YAML to the library. |
| `workflow_create_temp` | Write a temporary workflow draft, indexed but excluded from list results, kept until deleted. |
| `workflow_delete` | Remove a permanent workflow or a temporary draft by name and optional version, after the user confirms the resolved target. |

## Capability reference

### `workflow_list` <sub>tool</sub>

- Optional keyword `query` filter (case-insensitive substring across workflow name and description)
- Optional category filter (case-insensitive substring match)
- Optional tag filter (case-insensitive AND match — all listed tags must be present)
- Filter values are trimmed of leading and trailing whitespace before matching; a blank `query` or `category` applies no filter
- Set `includeTools: true` to surface the unique `server/tool` pairs used across each workflow's steps
- Temporary workflows are excluded; results sorted by name, then by semver precedence descending (a release before its prereleases)
- Empty results echo the applied filters with a hint to broaden

---

### `workflow_get` <sub>tool</sub>

- Semver-aware: omit `version` to get the highest available match; specify a version for an exact lookup
- A `version` that is not valid semver is rejected as invalid arguments before any lookup; a tolerated spelling (`v1.0.0`, surrounding whitespace, build metadata) resolves to its canonical form (`1.0.0`)
- `name` is trimmed before lookup, matching how the create tools store it; a blank `name` is rejected as invalid arguments
- Returns the full workflow YAML structure with all steps and metadata
- Injects the `global_instructions.md` content as `globalInstructions` — apply these when executing the workflow; `null` when the file is absent
- Temporary workflows are accessible here even though excluded from `workflow_list`
- Template placeholders (`{{input.foo}}`, `{{steps.X.output.Y}}`) are returned verbatim — the server never interpolates them

---

### `workflow_create` <sub>tool</sub>

- Workflow stored at `categories/<slugified-category>/<slugified-name>-<slugified-version>-<hash>-workflow.yaml`, where `<hash>` is the first 8 hex characters of SHA-256 over `name@version` — one file per `name@version`, so multiple versions coexist and keys whose slugs coincide (`Deploy` / `deploy`, `Café Plan` / `Caf Plan`) never share a file
- Any name with visible content is accepted; one with no ASCII letters or digits (e.g. `Рабочий процесс`) uses `workflow` as the name part of its filename
- Rejects if `name@version` already exists, as a permanent workflow or a temporary draft — bump the version to create a new revision, or delete the draft with `workflow_delete` to store it permanently
- Concurrent creates of one `name@version` produce one workflow and one `already_exists`, even across categories
- `version` is stored in canonical semver form: a leading `v`, surrounding whitespace, and build metadata are dropped, so `v1.0.0+build.5` is stored, keyed, and retrieved as `1.0.0`
- Rejects a whitespace-only `name`, `description`, `author`, `category`, or step `server`/`tool` with `invalid_input`
- Rejects a `name` longer than 200 characters or a `category` longer than 255 characters after slugification with `invalid_input`, so every file and directory name fits the 255-byte limit
- Server stamps `created_date` and `last_updated_date` automatically
- Index and snapshot rebuilt after write; filesystem watcher also fires (idempotent, debounced)
- A filesystem failure is reported as `write_failed` with the error code and description only, never the absolute path

---

### `workflow_create_temp` <sub>tool</sub>

- Writing a `name@version` that already has a draft overwrites that draft in place: `status` is `"created"` for a new draft and `"overwritten"` for a replaced one, and an overwrite keeps the draft's original `created_date`
- Rejects a `name@version` held by a permanent workflow with `already_exists`
- Stored under `temp/` with the same filename scheme, canonical `version` storage, and whitespace-only field rejection as `workflow_create`
- Indexed and accessible via `workflow_get` but excluded from `workflow_list` results; a `notice` field saying so rides along in both `structuredContent` and the text output
- Drafts persist: a draft stays under `temp/` across restarts until `workflow_delete` removes it — nothing expires drafts or cleans them up
- Useful for one-shot plans, scaffolding, or drafts not yet ready for the permanent library

---

### `workflow_delete` <sub>tool</sub>

- Deletes permanent workflows and temporary drafts alike; the output's `source` (`"permanent"` or `"temp"`) says which was removed
- Semver-aware: omit `version` to delete the highest available match across permanent workflows and drafts; specify a version to target one exactly
- Same `version` and `name` rules as `workflow_get`: non-semver input is rejected before anything is deleted, a tolerated spelling targets its canonical form, and a padded `name` is trimmed
- Asks the user first: the call returns a confirmation prompt naming the resolved `name@version`, its source, and its file path relative to `WORKFLOWS_DIR`, and deletes only when the user answers `confirm: true`. Answering `false`, declining, or cancelling fails with `cancelled` and deletes nothing
- The server keeps each prompt's record and hands the client only a random id for it. An answer must come back within 10 minutes and works once; an answer to a prompt the server never issued, already answered, or issued too long ago fails with `confirmation_invalid` and deletes nothing
- The file is deleted only if it is still the one the user saw: if the name resolves to a different workflow or file, or the file's content changed, by the time the answer arrives, the call fails with `target_changed` and deletes nothing
- Needs a client that can show the prompt (elicitation); a client without it cannot delete, and there is no way around the prompt
- Irreversible: the file is removed and the workflow no longer appears in `workflow_list` or `workflow_get` — unless another hand-authored file declares the same `name@version`. That copy then takes its place, and the result carries a `notice` naming its path relative to `WORKFLOWS_DIR`
- Deleting a draft frees its `name@version`, so `workflow_create` can then store it permanently
- Deleting the last workflow in a `categories/<slug>/` directory removes that emptied directory; a directory still holding any file stays

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Workflow library:

- YAML workflow files validated against a schema at index time; invalid files (including a whitespace-only `name`, `description`, `author`, `category`, or step `server`/`tool`) are skipped and logged, never crash the server
- Versions indexed in canonical semver form — a file authored as `version: v1.0.0` indexes as `name@1.0.0`
- One index entry per `name@version`: a permanent workflow outranks a temporary draft with the same key (the draft is skipped with a warning naming both files), and two files of one kind that share a key log a duplicate warning, with the last one read winning
- In-memory index keyed by `name@version`, built at startup from `workflows-yaml/categories/` and `workflows-yaml/temp/` recursively, kept fresh by a debounced recursive filesystem watcher on any add/change/remove
- The index reads each workflow's identity from its file content, never its filename, so files named under any scheme — including the earlier `<name>-<version>-workflow.yaml` — are listed, retrieved, and deleted like any other
- Creates and deletes run one at a time within the server, so each one's existence check holds until its write lands
- Semver-aware lookup — latest version returned when `version` is omitted
- `_index.json` snapshot written on every rebuild for external tooling and debugging
- Configurable `WORKFLOWS_DIR`, `GLOBAL_INSTRUCTIONS_PATH`, and debounce interval

Agent-friendly output:

- Discriminated output — `source: "permanent" | "temp"` on every `workflow_get` response and typed `reason` codes (`not_found`, `version_not_found`, `already_exists`, `cancelled`, `confirmation_invalid`, `target_changed`, `index_unavailable`, …) on failures, so callers branch on data instead of parsing error strings
- No extra round trip — `workflow_get` always returns `globalInstructions` alongside the workflow definition in the same response
- Response shaping — `workflow_list`'s optional `includeTools` flag pre-derives the unique `server/tool` pairs used by a workflow, and an empty result echoes the applied filters with a broadening hint instead of returning nothing

---

## Getting started

No API keys required. The server reads from a local `workflows-yaml/` directory by default.

Add the following to your MCP client configuration file:

```json
{
  "mcpServers": {
    "workflows-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/workflows-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "WORKFLOWS_DIR": "/absolute/path/to/your/workflows-yaml"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "workflows-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/workflows-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "WORKFLOWS_DIR": "/absolute/path/to/your/workflows-yaml"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "workflows-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "-v", "/absolute/path/to/your/workflows-yaml:/workflows-yaml",
        "-e", "WORKFLOWS_DIR=/workflows-yaml",
        "ghcr.io/cyanheads/workflows-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Seed workflows

The repository ships a `workflows-yaml/` directory with example workflows organized under `categories/`. These are ready to use as a starting point. The `workflows-yaml/global_instructions.md` file contains instructions the server prepends to every `workflow_get` response — edit it to set global guidance for your agent.

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- A local directory containing YAML workflow files (or use the bundled `workflows-yaml/` seed).

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/workflows-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd workflows-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env if needed — most settings have defaults
```

---

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `WORKFLOWS_DIR` | Absolute or relative path to the workflows root directory. | `./workflows-yaml` |
| `GLOBAL_INSTRUCTIONS_PATH` | Path to the global instructions markdown file. Derives from `WORKFLOWS_DIR` when not set. | `<WORKFLOWS_DIR>/global_instructions.md` |
| `WATCHER_DEBOUNCE_MS` | Milliseconds to debounce filesystem change events before rebuilding the index. | `500` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_SESSION_MODE` | HTTP sessions: `auto` or `stateful`. `workflow_delete`'s confirmation prompt needs a live session, so HTTP startup with `stateless` fails with a configuration error. Ignored over stdio. | `stateful`, declared in `src/index.ts` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

---

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t workflows-mcp-server .
docker run --rm \
  -v /path/to/workflows-yaml:/workflows-yaml \
  -e WORKFLOWS_DIR=/workflows-yaml \
  -p 3010:3010 \
  workflows-mcp-server
```

The Dockerfile defaults to HTTP transport, stateful session mode (required — see `MCP_SESSION_MODE` above), and logs to `/var/log/workflows-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

---

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and inits the workflow index service. |
| `src/config/` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools/` | Tool definitions (`*.tool.ts`). |
| `src/services/workflow-index/` | `WorkflowIndexService` — YAML parsing, index build, watcher, semver lookup, write helpers. |
| `tests/` | Unit and integration tests mirroring `src/`. |
| `workflows-yaml/` | Seed workflow library — `categories/` for permanent workflows, `temp/` for temporary drafts, `global_instructions.md` for agent-global guidance. |

---

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging
- Register new tools via the barrel in `src/mcp-server/tools/definitions/index.ts`
- Filesystem operations go through `WorkflowIndexService`, not directly in tool handlers

---

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

---

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
