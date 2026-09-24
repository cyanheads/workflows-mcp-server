#!/usr/bin/env node
/**
 * @fileoverview workflows-mcp-server MCP server entry point.
 * @module index
 */

import * as path from 'node:path';
import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { allToolDefinitions } from './mcp-server/tools/definitions/index.js';
import {
  initWorkflowIndexService,
  shutdownWorkflowIndexService,
} from './services/workflow-index/workflow-index-service.js';

await createApp({
  name: 'workflows-mcp-server',
  title: 'workflows-mcp-server',
  tools: allToolDefinitions,
  resources: [],
  prompts: [],
  instructions:
    'A declarative workflow library. Use workflow_list to discover available workflows, ' +
    'workflow_get to retrieve a full workflow definition with global instructions, ' +
    'workflow_create to persist a new workflow, workflow_create_temp to store a temporary draft ' +
    '(kept until deleted), and workflow_delete to remove a permanent workflow or a draft once the ' +
    'user confirms the prompt it shows.',

  /**
   * workflow_delete gates its unlink on a ctx.requestInput confirmation. A 2025-era HTTP client
   * answers that round only over a live session — under stateless serving the elicitation is
   * refused and no such client could ever delete. `require` makes HTTP startup with
   * MCP_SESSION_MODE=stateless fail with a ConfigurationError instead. Stdio is unaffected.
   */
  sessionMode: { default: 'stateful', require: 'stateful' },

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

  /** Releases the index service's fs.watch handle and its pending debounce timer. */
  teardown() {
    shutdownWorkflowIndexService();
  },
});
