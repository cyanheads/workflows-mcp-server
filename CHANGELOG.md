# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - 2025-06-13

### BREAKING CHANGE

- **Project Refactor**: The project has been fundamentally refactored from a generic MCP TypeScript template (`mcp-ts-template`) into a dedicated `workflows-mcp-server`. This change establishes a new purpose and feature set for the repository.

### Added

- **Workflow Engine**: Introduced a core workflow engine that discovers, indexes, and executes multi-step workflows defined in YAML files (`workflows-yaml/`).
- **Workflow Indexing Service**: Added `WorkflowIndexService` (`src/services/workflow-indexer/`) to automatically discover and index all workflow YAML files on startup and watch for changes.
- **Workflow Tools**: Implemented two primary tools for interacting with workflows:
  - `workflow_return_list`: Lists available workflows with filtering by category and tags.
  - `workflow_get_instructions`: Retrieves a specific workflow definition and dynamically injects global instructions.
- **Global Instructions**: Added a `global_instructions.md` file to provide consistent, high-level guidance to the LLM for all workflows.

### Removed

- **Generic Template Components**: Removed all components related to the old `mcp-ts-template`, including:
  - The generic MCP client implementation (`src/mcp-client/`).
  - Example tools (`echoTool`, `catFactFetcher`, `imageTest`) and resources (`echoResource`).
  - Unnecessary services (`DuckDB`, `OpenRouterProvider`, `Supabase`).
  - Outdated documentation and API references.

### Changed

- **Configuration**: Updated `package.json`, `README.md`, and `.clinerules` to reflect the new project name, purpose, and version (1.0.0).
- **Server Logic**: Modified `src/mcp-server/server.ts` to register the new workflow-specific tools.
- **Authentication**: Simplified `authMiddleware.ts` by migrating from `jsonwebtoken` to `jose` for JWT verification, improving security and modernizing the implementation.
