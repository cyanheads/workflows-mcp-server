/**
 * @fileoverview Defines the core logic for the workflow_return_list tool.
 * This tool is responsible for discovering, filtering, and returning a list
 * of available workflows by querying the in-memory WorkflowIndexService.
 * @module src/mcp-server/tools/workflowLister/logic
 */

import { z } from 'zod';
import {
  type WorkflowMetadata,
  workflowIndexService,
} from '../../../services/workflow-indexer/index.js';
import { logger, type RequestContext } from '../../../utils/index.js';

// --- Zod Schemas ---

/**
 * Zod schema for validating input arguments for the `workflow_return_list` tool.
 */
export const WorkflowListerInputSchema = z.object({
  category: z.string().optional().describe('Filter by a specific category.'),
  tags: z
    .array(z.string())
    .optional()
    .describe('Filter by workflows containing all specified tags.'),
}).describe('Input schema for listing and filtering workflows.');

/**
 * TypeScript type inferred from the input schema.
 */
export type WorkflowListerInput = z.infer<typeof WorkflowListerInputSchema>;

// --- Core Logic ---

/**
 * Processes the core logic for the `workflow_return_list` tool.
 * @param params - The validated input parameters.
 * @param context - The request context for logging.
 * @returns An array of workflow metadata.
 */
export const processWorkflowLister = (
  params: WorkflowListerInput,
  context: RequestContext,
): WorkflowMetadata[] => {
  logger.debug('Processing workflow_return_list logic with parameters.', {
    ...context,
    toolInput: params,
  });

  let workflows = workflowIndexService.getAllWorkflows(context);

  // Apply category filter
  if (params.category) {
    workflows = workflows.filter(
      w => w.category.toLowerCase() === params.category?.toLowerCase(),
    );
  }

  // Apply tags filter
  if (params.tags && params.tags.length > 0) {
    workflows = workflows.filter(w =>
      params.tags!.every(tag =>
        w.tags.map(t => t.toLowerCase()).includes(tag.toLowerCase()),
      ),
    );
  }

  logger.info(
    `Found ${workflows.length} workflows matching filter criteria.`,
    context,
  );
  return workflows;
};
