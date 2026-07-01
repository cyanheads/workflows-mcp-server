<div align="center">
  <h1>@cyanheads/workflows-mcp-server</h1>
  <p><b>Store, query, and create YAML workflow playbooks for LLM agents via MCP. STDIO or Streamable HTTP.</b>
  <div>4 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.4-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/workflows-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/workflows-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/workflows-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/workflows-mcp-server/releases/latest/download/workflows-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=workflows-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvd29ya2Zsb3dzLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22workflows-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fworkflows-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Tools

Four tools covering the full workflow library lifecycle — discovery, retrieval, and creation for both permanent and temporary workflows:

| Tool | Description |
|:-----|:------------|
| `workflow_list` | List all permanent workflows in the index, with optional category and tag filters. |
| `workflow_get` | Retrieve a complete workflow definition by name, with global instructions prepended. |
| `workflow_create` | Write a new permanent workflow YAML to the library. |
| `workflow_create_temp` | Write a temporary one-shot workflow, indexed but excluded from list results. |

### `workflow_list`

List permanent workflows from the in-memory index.

- Optional category filter (case-insensitive substring match)
- Optional tag filter (AND match — all listed tags must be present)
- Set `includeTools: true` to surface the unique `server/tool` pairs used across each workflow's steps
- Temporary workflows are excluded; results sorted by name then version descending

---

### `workflow_get`

Retrieve a complete workflow by name, including the global instructions document.

- Semver-aware: omit `version` to get the highest available match; specify a version for an exact lookup
- Returns the full workflow YAML structure with all steps and metadata
- Injects the `global_instructions.md` content as `globalInstructions` — apply these when executing the workflow; `null` when the file is absent
- Temporary workflows are accessible here even though excluded from `workflow_list`
- Template placeholders (`{{input.foo}}`, `{{steps.X.output.Y}}`) are returned verbatim — the server never interpolates them

---

### `workflow_create`

Write a new permanent workflow to the library.

- Workflow stored at `categories/<slugified-category>/<slugified-name>-workflow.yaml`
- Rejects if `name@version` already exists — bump the version to create a new revision
- Server stamps `created_date` and `last_updated_date` automatically
- Index and snapshot rebuilt after write; filesystem watcher also fires (idempotent, debounced)

---

### `workflow_create_temp`

Write a throwaway workflow to the `temp/` directory.

- No conflict check — temp workflows are intentionally ephemeral and overwriteable
- Indexed and accessible via `workflow_get` but excluded from `workflow_list` results
- Useful for one-shot plans, short-lived scaffolding, or session-specific orchestration steps

---

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

Workflow library:

- In-memory index keyed by `name@version`, built at startup from `workflows-yaml/categories/` recursively
- Semver-aware lookup — latest version returned when version is omitted
- Filesystem watcher (Node.js `fs.watch` recursive) rebuilds the index on any add/change/remove; debounced to avoid thrash
- YAML validated at index time — invalid files are skipped and logged, never crash the server
- `_index.json` snapshot written on every rebuild for external tooling and debugging
- Configurable `WORKFLOWS_DIR`, `GLOBAL_INSTRUCTIONS_PATH`, and debounce interval

Agent-friendly output:

- `workflow_get` always includes `globalInstructions` alongside the workflow — no second call needed
- Discriminated `source` field (`permanent` | `temp`) on every `workflow_get` response
- Typed error contracts with structured `reason` codes (`not_found`, `version_not_found`, `already_exists`, `index_unavailable`) so callers can branch on error type rather than parsing messages
- `workflow_list` with `includeTools: true` surfaces all MCP server/tool dependencies at a glance

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

- [Bun v1.3.2](https://bun.sh/) or higher (or Node.js v24+).
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

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/workflows-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

---

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and inits the workflow index service. |
| `src/config/` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools/` | Tool definitions (`*.tool.ts`). |
| `src/services/workflow-index/` | `WorkflowIndexService` — YAML parsing, index build, watcher, semver lookup, write helpers. |
| `tests/` | Unit and integration tests mirroring `src/`. |
| `workflows-yaml/` | Seed workflow library — `categories/` for permanent workflows, `temp/` for throwaway ones, `global_instructions.md` for agent-global guidance. |

---

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging
- Register new tools via the barrel in `src/mcp-server/tools/definitions/index.ts`
- Filesystem operations go through `WorkflowIndexService`, not directly in tool handlers

---

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

---

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
