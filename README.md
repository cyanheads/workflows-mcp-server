<div align="center">
  <h1>@cyanheads/workflows-mcp-server</h1>
  <p><b>Store, query, and create YAML workflow playbooks for LLM agents via MCP. STDIO or Streamable HTTP.</b>
  <div>5 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.4.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/workflows-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.2.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/workflows-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/workflows-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

- Optional `query` (name and description), `category` (substring), and `tags` (all must match) filters, case-insensitive; temporary drafts are never listed
- Sorted by name, then highest version first; an empty result carries a `notice` echoing the applied filters
- `includeTools: true` adds each workflow's unique `server/tool` pairs

---

### `workflow_get` <sub>tool</sub>

- `name` plus an optional semver `version`; omit `version` for the highest available, drafts included
- Returns the full workflow, its `source` (`permanent` or `temp`), and `globalInstructions` from `global_instructions.md` (`null` when absent); fails with `not_found` or `version_not_found`
- Template placeholders such as `{{input.foo}}` come back verbatim — the server never interpolates them

---

### `workflow_create` <sub>tool</sub>

- `name`, semver `version`, `description`, `author`, `category`, and `steps` (plus optional `tags`); stored as one file per `name@version` under `categories/<category>/`, with created and updated dates stamped
- Returns the `key` (`name@version`) and `filePath`; fails with `already_exists` when a permanent workflow or a draft holds the key, `invalid_input`, or `write_failed`

---

### `workflow_create_temp` <sub>tool</sub>

- The `workflow_create` fields minus `category`; stored under `temp/`, retrievable with `workflow_get`, never listed, and kept until `workflow_delete` removes it
- `status` is `created`, or `overwritten` when it replaced the draft of the same key (keeping that draft's `created_date`); a key held by a permanent workflow fails with `already_exists`

---

### `workflow_delete` <sub>tool</sub>

- `name` plus an optional `version` (omitted: the highest across permanent workflows and drafts); the user confirms the resolved `name@version`, source, and file before anything is deleted, so a client without elicitation cannot delete
- Returns the deleted workflow's `source`, plus a `notice` when another file declaring the same key now takes its place; fails with `cancelled`, `confirmation_invalid` (a prompt never issued, already answered, older than 10 minutes, or issued to another caller), `target_changed` (the file or its content changed after the user saw it), or `not_found`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Workflow library:

- YAML files under `categories/` and `temp/` are validated at index time; an invalid file is skipped and logged, never crashes the server
- In-memory index keyed by `name@version`, read from each file's content rather than its name and kept fresh by a debounced recursive watcher; a permanent workflow outranks a draft with the same key
- Versions are canonical semver everywhere: a leading `v`, surrounding whitespace, and build metadata are dropped, so `v1.0.0+build.5` is stored, keyed, and looked up as `1.0.0`
- Creates and deletes run one at a time, so each existence check holds until its write lands; filenames carry a hash of `name@version`, so keys whose slugs coincide never share a file
- An `_index.json` snapshot is written on every rebuild for external tooling and debugging

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
| `MCP_REQUEST_STATE_KEY` | Seals the `requestState` a confirmation round carries (≥ 32 bytes, the same on every instance, e.g. `openssl rand -base64 32`); any state the server did not seal is rejected before the handler runs. `workflow_delete`'s round carries its confirmation id, so set it for HTTP deployments. | unset |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log each failed tool call's arguments and result, redacted by key name and capped at `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` (default `16384`). A secret inside a free-form value is not redacted. | `false` |
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
