# MCP Workflow Orchestration Server

[![TypeScript](https://img.shields.io/badge/TypeScript-^5.8.3-blue.svg)](https://www.typescriptlang.org/)
[![Model Context Protocol](https://img.shields.io/badge/MCP%20SDK-^1.13.0-green.svg)](https://modelcontextprotocol.io/)
[![Version](https://img.shields.io/badge/Version-1.0.4-blue.svg)](./CHANGELOG.md)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![Status](https://img.shields.io/badge/Status-Active-green.svg)](https://github.com/cyanheads/workflows-mcp-server/issues)
[![GitHub](https://img.shields.io/github/stars/cyanheads/workflows-mcp-server?style=social)](https://github.com/cyanheads/workflows-mcp-server)

**Empower your AI agents with a powerful, declarative workflow engine.**

An MCP (Model Context Protocol) server that allows a Large Language Model (LLM) to discover, understand, and execute complex, multi-step workflows defined in simple YAML files.

Built on the [`cyanheads/mcp-ts-template`](https://github.com/cyanheads/mcp-ts-template), this server follows a modular architecture with robust error handling, logging, and security features.

## 🚀 Core Capabilities: Workflow Tools 🛠️

This server equips your AI with specialized tools to interact with the workflow engine:

| Tool Name                                                                         | Description                                                                 | Key Features                                                                                                                                                                              |
| :-------------------------------------------------------------------------------- | :-------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`workflow_return_list`](./src/mcp-server/tools/workflowLister/)                  | Discovers and lists available workflows.                                    | - `category`: Filter by a specific category.<br/>- `tags`: Filter by a list of tags.<br/>- `includeTools`: Optionally include a list of tools used in each workflow.                      |
| [`workflow_get_instructions`](./src/mcp-server/tools/workflowInstructionsGetter/) | Retrieves the complete definition for a single workflow.                    | - `name`: The exact name of the workflow.<br/>- `version`: The specific version to retrieve (defaults to latest).<br/>- Dynamically injects global instructions for consistent execution. |
| [`workflow_create_new`](./src/mcp-server/tools/workflowCreator/)                  | Creates a new, permanent workflow YAML file.                                | - Takes a structured JSON object matching the workflow schema.<br/>- Automatically categorizes and re-indexes workflows.                                                                  |
| [`workflow_create_temporary`](./src/mcp-server/tools/workflowTemporaryCreator/)   | Creates a temporary workflow that is not listed, but can be called by name. | - Ideal for defining multi-step plans for complex tasks.<br/>- Can be passed to other agents by name.                                                                                     |

---

## Table of Contents

| [Overview](#overview) | [Features](#features) | [Installation](#installation) |
| [Configuration](#configuration) | [Project Structure](#project-structure) |
| [Tools](#tools) | [Development](#development) | [License](#license) |

## Overview

The Workflow MCP Server acts as a powerful orchestration layer that helps your LLM agents manage complex workflows. This provides a structured way to perform 'short' multi-step tasks that would otherwise require hard-coded logic or extensive manual intervention.

It's as easy as telling your LLM "Use the workflows-mcp-server to create a new workflow that does X, Y, and Z, using the current tools you currently have access to" or "Find me a workflow that can help with task A". The server will handle the rest, allowing your agents to focus on higher-level reasoning and decision-making. The temporary workflows can be used to allow your LLM agent to "collect its thoughts" and create a structured temporary plan; even the act of defining a workflow can help the agent clarify its own understanding of the task at hand and improve tool use performance.

Instead of hard-coding multi-step logic, your tools can leverage this server to:

- **Automate complex processes**: Define a sequence of tool calls in a simple YAML file and execute it with a single command.
- **Promote reusability**: Create a library of common workflows that can be used across different agents and applications.
- **Improve agent reliability**: Provide agents with a clear, structured plan to follow, reducing errors and improving predictability.
- **Dynamically guide agent behavior**: Use global instructions to provide up-to-date, high-level strategy to all workflows without modifying them individually.

> **Developer Note**: This repository includes a [.clinerules](.clinerules) file that serves as a developer cheat sheet for your LLM coding agent with quick reference for the codebase patterns, file locations, and code snippets.

## Features

### Core Utilities

Leverages the robust utilities provided by the `mcp-ts-template`:

- **Logging**: Structured, configurable logging with sensitive data redaction.
- **Error Handling**: Centralized error processing and standardized error types (`McpError`).
- **Configuration**: Environment variable loading (`dotenv`) with comprehensive validation using Zod.
- **Input Validation/Sanitization**: Uses `zod` for schema validation.
- **Request Context**: Tracking and correlation of operations via unique request IDs.
- **Type Safety**: Strong typing enforced by TypeScript and Zod schemas.
- **HTTP Transport**: High-performance HTTP server using **Hono**, featuring session management and robust authentication.
- **Authentication**: Modular authentication layer supporting JWT and OAuth 2.1.

### Workflow Engine

- **YAML-based Workflows**: Define complex, multi-step workflows in a simple, human-readable format.
- **Dynamic Indexing**: Automatically discovers and indexes all workflow files on startup and watches for changes.
- **Global Instructions**: Dynamically injects a central set of instructions into every workflow, allowing for global strategy updates.
- **Temporary Workflows**: Create "hidden" workflows on the fly for complex tasks or for passing structured plans between agents.

## Installation

### Prerequisites

- [Node.js (>=20.0.0)](https://nodejs.org/)
- [npm](https://www.npmjs.com/) (comes with Node.js)

### MCP Client Settings

Add the following to your MCP client's configuration file (e.g., `cline_mcp_settings.json`). This configuration uses `npx` to run the server, which will automatically install the package if not already present:

```json
{
  "mcpServers": {
    "workflows-mcp-server": {
      "command": "npx",
      "args": ["workflows-mcp-server"],
      "env": {
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

## If running manually (not via MCP client) for development or testing

### Install via npm

```bash
npm install workflows-mcp-server
```

### Alternatively Install from Source

1. Clone the repository:

   ```bash
   git clone https://github.com/cyanheads/workflows-mcp-server.git
   cd workflows-mcp-server
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Build the project:
   ```bash
   npm run build
   ```

## Configuration

### Environment Variables

Configure the server using environment variables. These can be set in a `.env` file or directly in your shell.

| Variable              | Description                                                                      | Default       |
| :-------------------- | :------------------------------------------------------------------------------- | :------------ |
| `MCP_TRANSPORT_TYPE`  | Transport mechanism: `stdio` or `http`.                                          | `stdio`       |
| `MCP_HTTP_PORT`       | Port for the HTTP server (if `MCP_TRANSPORT_TYPE=http`).                         | `3010`        |
| `MCP_HTTP_HOST`       | Host address for the HTTP server (if `MCP_TRANSPORT_TYPE=http`).                 | `127.0.0.1`   |
| `MCP_ALLOWED_ORIGINS` | Comma-separated list of allowed origins for CORS (if `MCP_TRANSPORT_TYPE=http`). | (none)        |
| `MCP_LOG_LEVEL`       | Logging level (`debug`, `info`, `warning`, `error`).                             | `debug`       |
| `MCP_AUTH_MODE`       | Authentication mode for HTTP: `jwt` or `oauth`.                                  | `jwt`         |
| `MCP_AUTH_SECRET_KEY` | **Required for `jwt` auth in production.** Minimum 32-character secret key.      | (none)        |
| `NODE_ENV`            | Runtime environment (`development`, `production`).                               | `development` |

## Project Structure

The codebase follows a modular structure within the `src/` directory:

```
src/
├── index.ts              # Entry point: Initializes and starts the server
├── config/               # Configuration loading (env vars, package info)
│   └── index.ts
├── mcp-server/           # Core MCP server logic and capability registration
│   ├── server.ts         # Server setup, capability registration
│   ├── transports/       # Transport handling (stdio, http)
│   └── tools/            # MCP Tool implementations (subdirs per tool)
├── services/             # External service integrations
│   └── workflow-indexer/ # Discovers and indexes workflow YAML files
├── types-global/         # Shared TypeScript type definitions
└── utils/                # Common utility functions (logger, error handler, etc.)
```

For a detailed file tree, run `npm run tree` or see [docs/tree.md](docs/tree.md).

## Tools

The server provides a suite of tools for managing and executing workflows.

| Tool Name                   | Description                             | Key Arguments                         |
| :-------------------------- | :-------------------------------------- | :------------------------------------ |
| `workflow_return_list`      | Lists available workflows.              | `category?`, `tags?`, `includeTools?` |
| `workflow_get_instructions` | Retrieves a workflow definition.        | `name`, `version?`                    |
| `workflow_create_new`       | Creates a new, permanent workflow.      | A structured JSON object.             |
| `workflow_create_temporary` | Creates a temporary, unlisted workflow. | A structured JSON object.             |

## Development

### Build and Test

```bash
# Build the project (compile TS to JS in dist/ and make executable)
npm run build

# Test the server locally using the MCP inspector tool (stdio transport)
npm run inspector

# Clean build artifacts
npm run clean

# Generate a file tree representation for documentation
npm run tree

# Clean build artifacts and then rebuild the project
npm run rebuild

# Format code with Prettier
npm run format

# Start the server using stdio (default)
npm start

# Start the server using HTTP transport
npm run start:http
```

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

---

<div align="center">
Built with the <a href="https://modelcontextprotocol.io/">Model Context Protocol</a>
</div>
