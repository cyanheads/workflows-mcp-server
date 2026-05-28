# workflows-mcp-server - Directory Structure

Generated on: 2026-05-28 10:01:10

```text
workflows-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   └── ISSUE_TEMPLATE/
│       ├── bug_report.yml
│       ├── config.yml
│       └── feature_request.yml
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   └── template.md
├── docs/
│   ├── design.md
│   └── idea.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skills-sync.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   └── tree.ts
├── skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── migrate-mcp-ts-template/
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   └── tools/
│   │       └── definitions/
│   │           ├── index.ts
│   │           ├── workflow-create-temp.tool.ts
│   │           ├── workflow-create.tool.ts
│   │           ├── workflow-get.tool.ts
│   │           └── workflow-list.tool.ts
│   ├── services/
│   │   └── workflow-index/
│   │       ├── types.ts
│   │       └── workflow-index-service.ts
│   └── index.ts
├── tests/
│   ├── prompts/
│   ├── resources/
│   ├── services/
│   │   └── workflow-index-service.test.ts
│   └── tools/
│       ├── workflow-create-temp.tool.test.ts
│       ├── workflow-create.tool.test.ts
│       ├── workflow-get.tool.test.ts
│       └── workflow-list.tool.test.ts
├── workflows-yaml/
│   ├── categories/
│   │   ├── git_operations/
│   │   │   └── git-wrapup-workflow.yaml
│   │   ├── github_operations/
│   │   │   └── github-issue-to-branch-workflow.yaml
│   │   ├── project-chimera/
│   │   │   ├── project-chimera-phase-0-crucible-setup-foundational-scaffolding-workflow.yaml
│   │   │   ├── project-chimera-phase-1-subatomic-data-extraction-first-order-connections-workflow.yaml
│   │   │   ├── project-chimera-phase-2-latent-connection-discovery-second-order-analysis-workflow.yaml
│   │   │   └── project-chimera-phase-3-predictive-synthesis-continuous-intelligence-distillation-workflow.yaml
│   │   ├── project-sentinel/
│   │   │   ├── sentinel-phase0-detailed-workflow.yaml
│   │   │   ├── sentinel-phase1-detailed-workflow.yaml
│   │   │   ├── sentinel-phase2-detailed-workflow.yaml
│   │   │   ├── sentinel-phase3-detailed-workflow.yaml
│   │   │   ├── sentinel-phase4-detailed-workflow.yaml
│   │   │   ├── sentinel-phase5-detailed-workflow.yaml
│   │   │   ├── sentinel-phase6-detailed-workflow.yaml
│   │   │   └── sentinel-phase7-detailed-workflow.yaml
│   │   ├── project-vastmind/
│   │   │   ├── vastmind-phase0-detailed-workflow.yaml
│   │   │   ├── vastmind-phase1-detailed-workflow.yaml
│   │   │   ├── vastmind-phase2-detailed-workflow.yaml
│   │   │   ├── vastmind-phase3-detailed-workflow.yaml
│   │   │   └── vastmind-phase4-detailed-workflow.yaml
│   │   ├── research_operations/
│   │   │   └── pubmed-research-workflow.yaml
│   │   ├── research-operations/
│   │   │   └── iterative-research-and-report-generation-workflow.yaml
│   │   ├── research-visualization/
│   │   │   └── pubmed-research-with-cosmograph-visualization-workflow.yaml
│   │   ├── technological-velocity-trajectory/
│   │   │   └── monitor-huawei-and-nvidia-patents-on-justia-workflow.yaml
│   │   └── web_operations/
│   │       └── website-scraper-workflow.yaml
│   ├── temp/
│   └── global_instructions.md
├── .dockerignore
├── .env.example
├── .gitignore
├── .mcpbignore
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
