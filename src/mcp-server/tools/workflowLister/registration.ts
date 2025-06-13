/**
 * @fileoverview Handles the registration of the `workflow_return_list` tool
 * with an MCP server instance.
 * @module src/mcp-server/tools/workflowLister/registration
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
import type { WorkflowListerInput } from './logic.js';
import { processWorkflowLister, WorkflowListerInputSchema } from './logic.js';

/**
 * Registers the 'workflow_return_list' tool with the MCP server.
 *
 * @param server - The MCP server instance to register the tool with.
 * @returns A promise that resolves when tool registration is complete.
 */
export const registerWorkflowListerTool = async (
  server: McpServer,
): Promise<void> => {
  const toolName = 'workflow_return_list';
  const toolDescription =
    'Discovers and lists available workflows. It provides a list of workflow metadata (name, description, version, etc.) to identify the correct automation to execute. Includes a filter to narrow the results by `category` or `tags` to find a specific workflow.';

  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: 'RegisterTool',
      toolName: toolName,
      moduleName: 'WorkflowListerRegistration',
    });

  logger.info(`Attempting to register tool: '${toolName}'`, registrationContext);

  await ErrorHandler.tryCatch(
    async () => {
      server.tool(
        toolName,
        toolDescription,
        WorkflowListerInputSchema.shape,
        async (params: WorkflowListerInput): Promise<CallToolResult> => {
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
              const responsePayload = await processWorkflowLister(
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
