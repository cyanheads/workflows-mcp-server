/**
 * @fileoverview Defines the core logic for the workflow_return_list tool.
 * This tool is responsible for discovering, filtering, and returning a list
 * of available workflows by querying the in-memory WorkflowIndexService.
 * @module src/mcp-server/tools/workflowLister/logic
 */

import { z } from 'zod';
import {
  workflowIndexService,
  type WorkflowStep
} from '../../../services/workflow-indexer/index.js';
import { logger, type RequestContext } from '../../../utils/index.js';

// --- Zod Schemas ---

/**
 * Zod schema for validating input arguments for the `workflow_return_list` tool.
 * Defines the parameters for discovering and filtering available workflows.
 */
export const WorkflowListerInputSchema = z
  .object({
    category: z
      .string()
      .optional()
      .describe(
        'Optional. Filters workflows to a specific category. Case-insensitive. Example: "Image Processing"',
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe(
        'Optional. Filters workflows that contain ALL specified tags. Case-insensitive. Example: ["resize", "s3"]',
      ),
    includeTools: z
      .boolean()
      .optional()
      .describe(
        'Optional. If true, includes a list of unique tools used in each workflow, formatted as `server_name/tool_name`.',
      ),
  })
  .describe(
    'Defines the input schema for the `workflow_return_list` tool. Use its optional parameters to discover and filter available workflows based on their metadata.',
  );

/**
 * TypeScript type inferred from the input schema.
 */
export type WorkflowListerInput = z.infer<typeof WorkflowListerInputSchema>;

/**
 * Defines the summarized metadata structure returned by the tool.
 */
export type WorkflowSummary = {
  name: string;
  description: string;
  version: string;
  tools?: string[];
};

// --- Core Logic ---

/**
 * Processes the core logic for the `workflow_return_list` tool.
 * @param params - The validated input parameters.
 * @param context - The request context for logging.
 * @returns An array of summarized workflow metadata.
 */
export const processWorkflowLister = (
  params: WorkflowListerInput,
  context: RequestContext,
): WorkflowSummary[] => {
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

  // Map to summarized format
  return workflows.map(w => {
    const summary: WorkflowSummary = {
      name: w.name,
      description: w.description,
      version: w.version,
    };

    if (params.includeTools) {
      const toolSet = new Set<string>();
      w.steps.forEach((step: WorkflowStep) => {
        toolSet.add(`${step.server}/${step.tool}`);
      });
      summary.tools = Array.from(toolSet);
    }

    return summary;
  });
};
