/**
 * @fileoverview Barrel export for all tool definitions.
 * @module mcp-server/tools/definitions/index
 */

export { workflowCreate } from './workflow-create.tool.js';
export { workflowCreateTemp } from './workflow-create-temp.tool.js';
export { workflowGet } from './workflow-get.tool.js';
export { workflowList } from './workflow-list.tool.js';

import { workflowCreate } from './workflow-create.tool.js';
import { workflowCreateTemp } from './workflow-create-temp.tool.js';
import { workflowGet } from './workflow-get.tool.js';
import { workflowList } from './workflow-list.tool.js';

export const allToolDefinitions = [workflowList, workflowGet, workflowCreate, workflowCreateTemp];
