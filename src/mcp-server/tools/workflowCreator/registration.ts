/**
 * @fileoverview Handles the registration of the `workflow_create_new` tool
 * with an MCP server instance.
 * @module src/mcp-server/tools/workflowCreator/registration
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
import type { WorkflowCreatorInput } from './logic.js';
import { processWorkflowCreate, WorkflowCreatorInputSchema } from './logic.js';

/**
 * Registers the 'workflow_create_new' tool with the MCP server.
 *
 * @param server - The MCP server instance to register the tool with.
 * @returns A promise that resolves when tool registration is complete.
 */
export const registerWorkflowCreatorTool = async (
  server: McpServer,
): Promise<void> => {
  const toolName = 'workflow_create_new';
  const toolDescription =
    'Creates a new workflow YAML file from a structured input. It places the file in the correct category directory and automatically triggers a re-indexing of available workflows.';

  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: 'RegisterTool',
      toolName: toolName,
      moduleName: 'WorkflowCreatorRegistration',
    });

  logger.info(`Attempting to register tool: '${toolName}'`, registrationContext);

  await ErrorHandler.tryCatch(
    async () => {
      server.tool(
        toolName,
        toolDescription,
        WorkflowCreatorInputSchema.shape,
        async (params: WorkflowCreatorInput): Promise<CallToolResult> => {
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
              const responsePayload = await processWorkflowCreate(
                params,
                handlerContext,
              );

              logger.debug(`'${toolName}' tool processed successfully.`, handlerContext);

              return {
                content: [
                  {
                    type: 'text',
                    text: `Successfully created workflow file at: ${responsePayload.filePath}`,
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
