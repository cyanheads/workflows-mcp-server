/**
 * @fileoverview Handles the registration of the `workflow_create_temporary` tool
 * with an MCP server instance.
 * @module src/mcp-server/tools/workflowTemporaryCreator/registration
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";
import {
  ErrorHandler,
  logger,
  RequestContext,
  requestContextService,
} from "../../../utils/index.js";
import type { WorkflowTemporaryCreatorInput } from "./logic.js";
import {
  processWorkflowTemporaryCreate,
  WorkflowTemporaryCreatorInputSchema,
} from "./logic.js";

/**
 * Registers the 'workflow_create_temporary' tool with the MCP server.
 *
 * @param server - The MCP server instance to register the tool with.
 * @returns A promise that resolves when tool registration is complete.
 */
export const registerWorkflowTemporaryCreatorTool = async (
  server: McpServer,
): Promise<void> => {
  const toolName = "workflow_create_temporary";
  const toolDescription =
    'Creates a new "temporary" workflow YAML file that is callable by name but excluded from the main workflow list. This is useful for if you need to collect your thoughts or define a multi-step process for a long-running or complex task, which can be used by itself or passed to another agent by supplying the workflow name.';

  const registrationContext: RequestContext =
    requestContextService.createRequestContext({
      operation: "RegisterTool",
      toolName: toolName,
      moduleName: "WorkflowTemporaryCreatorRegistration",
    });

  logger.info(
    `Attempting to register tool: '${toolName}'`,
    registrationContext,
  );

  await ErrorHandler.tryCatch(
    async () => {
      server.tool(
        toolName,
        toolDescription,
        WorkflowTemporaryCreatorInputSchema.shape,
        async (
          params: WorkflowTemporaryCreatorInput,
        ): Promise<CallToolResult> => {
          const handlerContext: RequestContext =
            requestContextService.createRequestContext({
              parentContext: registrationContext,
              operation: "HandleToolRequest",
              toolName: toolName,
              inputSummary: params,
            });

          logger.debug(`Handling '${toolName}' tool request.`, handlerContext);

          return await ErrorHandler.tryCatch(
            async () => {
              const responsePayload = await processWorkflowTemporaryCreate(
                params,
                handlerContext,
              );

              logger.debug(
                `'${toolName}' tool processed successfully.`,
                handlerContext,
              );

              return {
                content: [
                  {
                    type: "text",
                    text: `Success, file saved to ${responsePayload.filePath}. Here is the workflow that was created:\n\n---\n\n${responsePayload.yamlContent}`,
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
                const errorMessage = `Error processing '${toolName}' tool: ${error instanceof Error ? error.message : "An unknown error occurred"}`;
                return new McpError(
                  BaseErrorCode.INTERNAL_ERROR,
                  errorMessage,
                  {
                    ...handlerContext,
                    originalErrorName:
                      error instanceof Error ? error.name : typeof error,
                  },
                );
              },
            },
          );
        },
      );

      logger.info(
        `Tool '${toolName}' registered successfully.`,
        registrationContext,
      );
    },
    {
      operation: `RegisteringTool_${toolName}`,
      context: registrationContext,
      errorCode: BaseErrorCode.INITIALIZATION_FAILED,
      critical: true,
    },
  );
};
