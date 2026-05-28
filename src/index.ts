#!/usr/bin/env node
/**
 * @fileoverview workflows-mcp-server MCP server entry point.
 * @module index
 */

import * as path from 'node:path';
import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import { initWorkflowIndexService } from './services/workflow-index/workflow-index-service.js';

await createApp({
  tools: allToolDefinitions,
  resources: [],
  prompts: [],
  instructions:
    'A declarative workflow library. Use workflow_list to discover available workflows, ' +
    'workflow_get to retrieve a full workflow definition with global instructions, ' +
    'workflow_create to persist a new workflow, and workflow_create_temp to store a temporary one-shot plan.',

  setup(core) {
    const cfg = getServerConfig();

    // Resolve the workflows directory relative to CWD
    const workflowsDir = path.resolve(process.cwd(), cfg.workflowsDir);

    // Derive globalInstructionsPath: use explicit override, or default to
    // <workflowsDir>/global_instructions.md
    const globalInstructionsPath = cfg.globalInstructionsPath.trim()
      ? path.resolve(process.cwd(), cfg.globalInstructionsPath)
      : path.join(workflowsDir, 'global_instructions.md');

    initWorkflowIndexService(
      core.config,
      core.storage,
      workflowsDir,
      globalInstructionsPath,
      cfg.watcherDebounceMs,
    );
  },
});
