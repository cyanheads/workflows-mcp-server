# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-06-30

Completes library CRUD with a workflow_delete tool (by name + optional version) and adds a workflow_list keyword query filter over name and description. Tool descriptions rewritten client-facing, empty list results echo the applied filters, and the README documents the versioned per-name@version storage path.

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-06-30

Two first-run fixes: WorkflowIndexService.init() now creates a missing WORKFLOWS_DIR before rebuild/watch so the snapshot writes and the watcher stays live, and the bundled research-visualization seed workflow declares its category so it stops warning at boot and matches category-filtered workflow_list.

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-06-30 · 🛡️ Security

Security patch: clears 9 transitive bun audit advisories via the mcp-ts-core 0.10.10 bump, plus four workflow_create hardening fixes — cross-category duplicate guard, full semver validation, empty-slug category reject, and yaml.stringify serialization so created workflows round-trip through the index.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-06-11

Maintenance: @cyanheads/mcp-ts-core ^0.9.11 → ^0.10.6; bad-input write paths recode to ValidationError; server name/title identity; post-pack bundle cleaner; .mcpbignore dev-dir re-anchor.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-05-28 · ⚠️ Breaking

First real release — complete rewrite on @cyanheads/mcp-ts-core; 4 tools, YAML-backed index, filesystem watcher, semver-aware retrieval, scoped npm package @cyanheads/workflows-mcp-server

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-28

Initial release — workflow library MCP server with 4 tools, YAML-backed index, filesystem watcher, and semver-aware retrieval
