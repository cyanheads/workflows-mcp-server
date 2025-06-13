# workflows-mcp-server - Directory Structure

Generated on: 2025-06-13 13:10:07

```
workflows-mcp-server
├── .github
│   ├── workflows
│   │   └── publish.yml
│   └── FUNDING.yml
├── docs
│   └── tree.md
├── examples
│   └── pubmed-research-report-microglia-activation-in-neurodegeneration-2025-06-13.md
├── scripts
│   ├── clean.ts
│   ├── fetch-openapi-spec.ts
│   ├── make-executable.ts
│   ├── README.md
│   └── tree.ts
├── src
│   ├── config
│   │   └── index.ts
│   ├── mcp-server
│   │   ├── tools
│   │   │   ├── workflowInstructionsGetter
│   │   │   │   ├── index.ts
│   │   │   │   ├── logic.ts
│   │   │   │   └── registration.ts
│   │   │   └── workflowLister
│   │   │       ├── index.ts
│   │   │       ├── logic.ts
│   │   │       └── registration.ts
│   │   ├── transports
│   │   │   ├── authentication
│   │   │   │   ├── authContext.ts
│   │   │   │   ├── authMiddleware.ts
│   │   │   │   ├── authUtils.ts
│   │   │   │   ├── oauthMiddleware.ts
│   │   │   │   └── types.ts
│   │   │   ├── httpTransport.ts
│   │   │   └── stdioTransport.ts
│   │   ├── README.md
│   │   └── server.ts
│   ├── services
│   │   └── workflow-indexer
│   │       ├── index.ts
│   │       └── WorkflowIndexService.ts
│   ├── types-global
│   │   └── errors.ts
│   ├── utils
│   │   ├── internal
│   │   │   ├── errorHandler.ts
│   │   │   ├── index.ts
│   │   │   ├── logger.ts
│   │   │   └── requestContext.ts
│   │   ├── metrics
│   │   │   ├── index.ts
│   │   │   └── tokenCounter.ts
│   │   ├── network
│   │   │   ├── fetchWithTimeout.ts
│   │   │   └── index.ts
│   │   ├── parsing
│   │   │   ├── dateParser.ts
│   │   │   ├── index.ts
│   │   │   └── jsonParser.ts
│   │   ├── security
│   │   │   ├── idGenerator.ts
│   │   │   ├── index.ts
│   │   │   ├── rateLimiter.ts
│   │   │   └── sanitization.ts
│   │   └── index.ts
│   └── index.ts
├── workflows-yaml
│   ├── categories
│   │   ├── git_operations
│   │   │   └── git-wrapup-workflow.yaml
│   │   ├── github_operations
│   │   │   └── github-issue-to-branch-workflow.yaml
│   │   ├── research_operations
│   │   │   └── pubmed-research-workflow.yaml
│   │   └── web_operations
│   │       └── website-scraper-workflow.yaml
│   ├── _index.json
│   └── global_instructions.md
├── .clinerules
├── .dockerignore
├── .env.example
├── .gitignore
├── .ncurc.json
├── CHANGELOG.md
├── CLAUDE.md
├── Dockerfile
├── LICENSE
├── mcp.json
├── package-lock.json
├── package.json
├── README.md
├── repomix.config.json
├── smithery.yaml
├── tsconfig.json
├── tsconfig.typedoc.json
├── tsdoc.json
└── typedoc.json
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
