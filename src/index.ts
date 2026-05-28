#!/usr/bin/env node
/**
 * @fileoverview workflows-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';

await createApp({
  tools: [],
  resources: [],
  prompts: [],
  // instructions: 'Server-level orientation forwarded to the model on every initialize.\n' +
  //   '- Use shortcut `X` for the most common case\n' +
  //   '- Tools require auth via the `inventory:read` scope',
});
