# workflows-mcp-server - Directory Structure

Generated on: 2025-06-21 08:09:03

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
│   │   │   ├── workflowCreator
│   │   │   │   ├── index.ts
│   │   │   │   ├── logic.ts
│   │   │   │   └── registration.ts
│   │   │   ├── workflowInstructionsGetter
│   │   │   │   ├── index.ts
│   │   │   │   ├── logic.ts
│   │   │   │   └── registration.ts
│   │   │   ├── workflowLister
│   │   │   │   ├── index.ts
│   │   │   │   ├── logic.ts
│   │   │   │   └── registration.ts
│   │   │   └── workflowTemporaryCreator
│   │   │       ├── index.ts
│   │   │       ├── logic.ts
│   │   │       └── registration.ts
│   │   ├── transports
│   │   │   ├── auth
│   │   │   │   ├── core
│   │   │   │   │   ├── authContext.ts
│   │   │   │   │   ├── authTypes.ts
│   │   │   │   │   └── authUtils.ts
│   │   │   │   ├── strategies
│   │   │   │   │   ├── jwt
│   │   │   │   │   │   └── jwtMiddleware.ts
│   │   │   │   │   └── oauth
│   │   │   │   │       └── oauthMiddleware.ts
│   │   │   │   └── index.ts
│   │   │   ├── httpErrorHandler.ts
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
│   │   ├── research-operations
│   │   │   └── iterative-research-and-report-generation-workflow.yaml
│   │   ├── research-visualization
│   │   │   └── pubmed-research-with-cosmograph-visualization-workflow.yaml
│   │   ├── testing
│   │   │   ├── final-response-test-workflow-workflow.yaml
│   │   │   └── permanent-overwrite-test-workflow.yaml
│   │   └── web_operations
│   │       └── website-scraper-workflow.yaml
│   ├── temp
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
