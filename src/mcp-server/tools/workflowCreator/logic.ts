/**
 * @fileoverview Defines the core logic for the workflow_create_new tool.
 * This tool generates a new workflow YAML file from a structured input.
 * @module src/mcp-server/tools/workflowCreator/logic
 */

import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { BaseErrorCode, McpError } from '../../../types-global/errors.js';
import { logger, type RequestContext } from '../../../utils/index.js';
import { workflowIndexService } from '../../../services/workflow-indexer/index.js';

// --- Zod Schemas ---

const StepSchema = z.object({
  server: z.string().describe('The MCP server to target for this step.'),
  tool: z.string().describe('The tool on the server to execute.'),
  action: z.string().optional().describe('The specific action to perform with the tool.'),
  description: z.string().optional().describe('A description of what this step accomplishes.'),
  params: z.record(z.any()).describe('A key-value map of parameters for the tool.'),
});

export const WorkflowCreatorInputSchema = z
  .object({
    name: z
      .string()
      .min(1, 'Workflow name cannot be empty.')
      .describe('The user-friendly name of the workflow.'),
    version: z
      .string()
      .default('1.0.0')
      .describe('Semantic versioning for the workflow.'),
    description: z
      .string()
      .min(1, 'Description cannot be empty.')
      .describe('A brief, clear description of what the workflow accomplishes.'),
    author: z
      .string()
      .min(1, 'Author cannot be empty.')
      .describe('The author or team responsible for the workflow.'),
    category: z
      .string()
      .min(1, 'Category cannot be empty.')
      .describe('The category to place the workflow under (e.g., "Research Operations").'),
    tags: z
      .array(z.string())
      .optional()
      .describe('A list of specific tags for filtering.'),
    steps: z
      .array(StepSchema)
      .min(1, 'A workflow must have at least one step.')
      .describe('The sequence of steps to be executed.'),
  })
  .describe('Defines the structured input for creating a new workflow YAML file.');

export type WorkflowCreatorInput = z.infer<typeof WorkflowCreatorInputSchema>;

// --- Core Logic ---

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKFLOWS_BASE_DIR = path.resolve(__dirname, '../../../../workflows-yaml');

const slugify = (text: string): string => {
  return text
    .toString()
    .toLowerCase()
    .replace(/\s+/g, '-') // Replace spaces with -
    .replace(/[^\w-]+/g, '') // Remove all non-word chars
    .replace(/--+/g, '-') // Replace multiple - with single -
    .replace(/^-+/, '') // Trim - from start of text
    .replace(/-+$/, ''); // Trim - from end of text
};

/**
 * Processes the core logic for the `workflow_create_new` tool.
 * @param params - The validated input parameters.
 * @param context - The request context.
 * @returns A promise that resolves to the path of the newly created workflow file.
 */
export const processWorkflowCreate = async (
  params: WorkflowCreatorInput,
  context: RequestContext,
): Promise<{ filePath: string }> => {
  logger.debug('Processing workflow_create_new logic.', {
    ...context,
    toolInput: params,
  });

  const { category, name, ...workflowData } = params;
  const today = new Date().toISOString().split('T')[0];

  const workflowObject = {
    name,
    ...workflowData,
    created_date: today,
    last_updated_date: today,
    category,
  };

  const yamlContent = yaml.dump(workflowObject, {
    indent: 2,
    lineWidth: -1, // No line wrapping
  });

  const fileName = `${slugify(name)}-workflow.yaml`;
  const categoryDir = path.join(WORKFLOWS_BASE_DIR, 'categories', slugify(category));
  const filePath = path.join(categoryDir, fileName);

  try {
    await fs.mkdir(categoryDir, { recursive: true });
    await fs.writeFile(filePath, yamlContent, 'utf-8');
    logger.info(`Successfully created workflow file at: ${filePath}`, context);

    // Trigger re-indexing after creating a new file
    await workflowIndexService.buildIndex(context);

    return { filePath };
  } catch (error) {
    logger.error(`Failed to create workflow file at: ${filePath}`, error as Error, context);
    throw new McpError(BaseErrorCode.INTERNAL_ERROR, `Could not create workflow file: ${filePath}`, { ...context, originalError: error });
  }
};
