# Changelog

All notable changes to this project will be documented in this file.

## [1.0.4] - 2025-06-21

### Added

- **Temporary Workflow Creator**: Introduced `workflow_create_temporary` tool to create workflows that are callable by name but not listed in the main index, useful for complex, multi-step tasks. Useful for allowing an agent to collect its thoughts and create a structured plan of tools and actions it needs to take; or for creating temporary workflows callable by name, which can be passed onto other agents in multi-agent orchestrated systems.
- **HTTP Error Handler**: Implemented a centralized `httpErrorHandler` to standardize error responses for the HTTP transport.

### Changed

- **Authentication Refactor**: Refactored the authentication middleware into a modular structure with strategies for JWT and OAuth, improving separation of concerns.
- **Workflow Creator Tool**: The `workflow_create_new` tool now checks for existing files to prevent accidental overwrites and returns the created YAML content in its response.
- **Dependencies**: Updated dependencies to their latest versions.

### Removed

- **Old Authentication Files**: Deleted the previous monolithic authentication files in favor of the new modular structure.

## [1.0.3] - 2025-06-14

### Added

- **Workflow Creator Tool**: Introduced a new `workflow_create_new` tool that allows for the dynamic creation of new workflow YAML files via a structured input. This tool automatically handles file creation, proper categorization, and re-indexing of available workflows.

### Changed

- **Dependencies**: Updated various dependencies to their latest versions for improved performance and security. This includes an update to `@modelcontextprotocol/sdk` and the removal of several unused packages.

## [1.0.2] - 2025-06-13

### Added

- **New Workflows**: Introduced three new workflows for common operations:
  - `GitHub Issue to Branch`: Automates the creation of a Git branch from a GitHub issue.
  - `Comprehensive PubMed Research`: Performs a deep, multi-stage search on PubMed and generates a structured report.
  - `Website Content Scraper`: Scrapes and archives the main content of a URL.
- **Example Report**: Added an example output file (`pubmed-research-report-microglia-activation-in-neurodegeneration-2025-06-13.md`) to the `examples/` directory to demonstrate the research workflow's capabilities.

### Changed

- **Git Wrapup Workflow**: Updated the `git-wrapup-workflow.yaml` to use the `filesystem-mcp-server` for updating the `CHANGELOG.md`, replacing the previous `obsidian-mcp-server` dependency. This makes the workflow more generic and portable.
- **`.gitignore`**: Modified the `.gitignore` file to stop ignoring the `examples/` directory, allowing example outputs to be committed to the repository.

## [1.0.1] - 2025-06-13

### Added

- **Tool Discovery in Workflows**: The `workflow_return_list` tool now supports an `includeTools` option, which returns a list of unique tools (`server_name/tool_name`) used within each workflow. This enhances the agent's ability to understand the capabilities of a workflow at a glance.

### Changed

- **Improved Tool Descriptions**: Enhanced the Zod schema descriptions for `workflow_return_list` and `workflow_get_instructions` to be more detailed and provide clearer examples, improving their usability for the agent.
- **Workflow Metadata Typing**: The `WorkflowMetadata` type in `WorkflowIndexService` now includes the `steps` array, ensuring that the full workflow definition is available during indexing.

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
