/**
 * @fileoverview Handles the registration of the `workflow_get_instructions` tool
 * with an MCP server instance.
 * @module src/mcp-server/tools/workflowInstructionsGetter/registration
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { BaseErrorCode, McpError } from '../../../types-global/errors.js';
import {
  ErrorHandler,
  logger,
  RequestContext,
  requestContextService,
} from '../../../utils/index.js';
import type { WorkflowInstructionsGetterInput } from './logic.js';
import { processWorkflowInstructionsGetter, WorkflowInstructionsGetterInputSchema } from './logic.js';

/**
 * Registers the 'workflow_get_instructions' tool with the MCP server.
 *
 * @param server - The MCP server instance to register the tool with.
 * @returns A promise that resolves when tool registration is complete.
 */
export const registerWorkflowInstructionsGetterTool = async (
  server: McpServer,
): Promise<void> => {
  const toolName = 'workflow_get_instructions';
  const toolDescription =
    "Retrieves the complete definition for a single workflow by its unique `name`. It provides the workflow's steps, parameters, and metadata to perform the defined automation. The definition is augmented with global instructions to provide the full context required for execution. View workflows as instructions to follow, adjusting to your specific task needs, environment, and relevant data. This tool is to be used in conjunction with your other available tools & resources.";

  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: 'RegisterTool',
      toolName: toolName,
      moduleName: 'WorkflowInstructionsGetterRegistration',
    });

  logger.info(`Attempting to register tool: '${toolName}'`, registrationContext);

  await ErrorHandler.tryCatch(
    async () => {
      server.tool(
        toolName,
        toolDescription,
        WorkflowInstructionsGetterInputSchema.shape,
        async (params: WorkflowInstructionsGetterInput): Promise<CallToolResult> => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentContext: registrationContext,
              operation: 'HandleToolRequest',
              toolName: toolName,
              inputSummary: params,
            });

          logger.debug(`Handling '${toolName}' tool request.`, handlerContext);

          return await ErrorHandler.tryCatch(
            async () => {
              const responsePayload = await processWorkflowInstructionsGetter(
                params,
                handlerContext,
              );

              logger.debug(`'${toolName}' tool processed successfully.`, handlerContext);

              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify(responsePayload, null, 2),
                  },
                ],
                isError: false,
              };
            },
            {
              operation: `ExecutingCoreLogicFor_${toolName}`,
              context: handlerContext,
              input: params,
              errorMapper: (error: unknown): McpError => {
                if (error instanceof McpError) return error;
                const errorMessage = `Error processing '${toolName}' tool: ${error instanceof Error ? error.message : 'An unknown error occurred'}`;
                return new McpError(
                  BaseErrorCode.INTERNAL_ERROR,
                  errorMessage,
                  {
                    ...handlerContext,
                    originalErrorName: error instanceof Error ? error.name : typeof error,
                  },
                );
              },
            },
          );
        },
      );

      logger.info(`Tool '${toolName}' registered successfully.`, registrationContext);
    },
    {
      operation: `RegisteringTool_${toolName}`,
      context: registrationContext,
      errorCode: BaseErrorCode.INITIALIZATION_FAILED,
      critical: true,
    },
  );
};
