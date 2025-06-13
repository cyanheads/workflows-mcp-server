/**
 * @fileoverview Defines the core logic for the workflow_get_instructions tool.
 * This tool retrieves a specific workflow by name and version, and dynamically
 * injects a set of global instructions into the returned definition.
 * @module src/mcp-server/tools/workflowInstructionsGetter/logic
 */

import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import {
  workflowIndexService,
  type Workflow,
} from '../../../services/workflow-indexer/index.js';
import { BaseErrorCode, McpError } from '../../../types-global/errors.js';
import { logger, type RequestContext } from '../../../utils/index.js';

/**
 * The final structure returned by the tool, including the injected instructions.
 */
type WorkflowWithInstructions = { instructions: string } & Workflow;

// --- Zod Schemas ---

export const WorkflowInstructionsGetterInputSchema = z
  .object({
    name: z
      .string()
      .min(1, 'Workflow name cannot be empty.')
      .describe(
        'Required. The exact, case-sensitive name of the workflow to retrieve. This name must match the `name` field in the workflow\'s YAML definition. Example: "Process and Archive New User Images"',
      ),
    version: z
      .string()
      .optional()
      .describe(
        'Optional. A specific semantic version (e.g., "1.2.0") to retrieve. This provides a safeguard to ensure you are running the exact version you expect. If omitted, the tool automatically finds and returns the latest available semantic version of the workflow.',
      ),
  })
  .describe(
    'Defines the input for retrieving a complete, executable workflow definition. This tool fetches a specific workflow by its `name` and optional `version`, then prepends a set of global instructions to it, making it ready for execution.',
  );

export type WorkflowInstructionsGetterInput = z.infer<
  typeof WorkflowInstructionsGetterInputSchema
>;

// --- Core Logic ---

// Resolve path relative to the current module file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WORKFLOWS_BASE_DIR = path.resolve(__dirname, '../../../../workflows-yaml');
const INSTRUCTIONS_FILE_PATH = path.join(
  WORKFLOWS_BASE_DIR,
  'global_instructions.md',
);

/**
 * Finds and reads the specified workflow file using the indexer.
 * If no version is specified, it finds the latest semantic version.
 * @param name - The name of the workflow.
 * @param version - The optional version string.
 * @param context - The request context.
 * @returns A promise that resolves to the parsed Workflow object.
 * @throws {McpError} If the workflow is not found or cannot be parsed.
 */
async function findAndParseWorkflow(
  name: string,
  version: string | undefined,
  context: RequestContext,
): Promise<Workflow> {
  const workflowMeta = workflowIndexService.findWorkflow(name, version, context);

  if (!workflowMeta) {
    const message = version
      ? `Workflow with name "${name}" and version "${version}" not found.`
      : `Workflow with name "${name}" not found.`;
    throw new McpError(BaseErrorCode.NOT_FOUND, message, context);
  }

  const absoluteFilePath = path.join(WORKFLOWS_BASE_DIR, workflowMeta.filePath);
  logger.debug(`Found workflow in index. Reading from: ${absoluteFilePath}`, context);

  try {
    const finalContent = await fs.readFile(absoluteFilePath, 'utf-8');
    return yaml.load(finalContent) as Workflow;
  } catch (error) {
    logger.error(`Failed to read or parse workflow file: ${absoluteFilePath}`, error as Error, context);
    throw new McpError(BaseErrorCode.INTERNAL_ERROR, `Could not read or parse workflow file: ${workflowMeta.filePath}`, { ...context, originalError: error });
  }
}

/**
 * Processes the core logic for the `workflow_get_instructions` tool.
 * @param params - The validated input parameters.
 * @param context - The request context.
 * @returns A promise that resolves to the full workflow definition with instructions.
 */
export const processWorkflowInstructionsGetter = async (
  params: WorkflowInstructionsGetterInput,
  context: RequestContext,
): Promise<WorkflowWithInstructions> => {
  logger.debug('Processing workflow_get_instructions logic.', {
    ...context,
    toolInput: params,
  });

  // 1. Read Global Instructions
  let instructions = '';
  try {
    instructions = await fs.readFile(INSTRUCTIONS_FILE_PATH, 'utf-8');
  } catch (error) {
    logger.error(
      `Critical error: Could not read global instructions file at ${INSTRUCTIONS_FILE_PATH}`,
      context,
    );
    throw new McpError(
      BaseErrorCode.CONFIGURATION_ERROR,
      'Global instructions file is missing or unreadable.',
      { ...context, originalError: error },
    );
  }

  // 2. Find and Parse the Workflow
  const workflow = await findAndParseWorkflow(
    params.name,
    params.version,
    context,
  );

  // 3. Merge and Return
  const response: WorkflowWithInstructions = {
    instructions: instructions.trim(),
    ...workflow,
  };

  logger.info(
    `Successfully retrieved and merged instructions for workflow: ${workflow.name} v${workflow.version}`,
    context,
  );
  return response;
};
