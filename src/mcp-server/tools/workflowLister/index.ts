/**
 * @fileoverview Barrel file for the workflowLister tool.
 * This file exports the main registration function for the tool, making it
 * easy to import and register with the MCP server from a single entry point.
 * @module src/mcp-server/tools/workflowLister/index
 */

export { registerWorkflowListerTool } from './registration.js';
