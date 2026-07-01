/**
 * @fileoverview Tool definition for deleting a permanent workflow by name and version.
 * @module mcp-server/tools/definitions/workflow-delete
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getWorkflowIndexService } from '@/services/workflow-index/workflow-index-service.js';

export const workflowDelete = tool('workflow_delete', {
  title: 'Delete Workflow',
  description:
    'Permanently remove a workflow from the library by name. When version is omitted, the latest version is deleted; ' +
    'pass a version to target a specific one. Only permanent workflows can be deleted — a temporary workflow is rejected, ' +
    'since temporary workflows are session-scoped and expire on their own. Deletion is irreversible: the workflow no longer ' +
    'appears in workflow_list and can no longer be retrieved with workflow_get.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },

  input: z.object({
    name: z.string().min(1).describe('Exact name of the workflow to delete.'),
    version: z
      .string()
      .optional()
      .describe(
        'Specific semver version to delete (e.g. "1.0.0"). Omit to delete the highest available version.',
      ),
  }),

  output: z.object({
    status: z.literal('deleted').describe('Confirms the workflow was removed from the library.'),
    name: z.string().describe('Name of the deleted workflow.'),
    version: z.string().describe('Version (semver) of the deleted workflow.'),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No permanent workflow matches the given name, or the given name and version.',
      recovery:
        'Use workflow_list to see available workflow names and versions, then retry; omit version to target the latest.',
    },
    {
      reason: 'temp_not_allowed',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The resolved workflow is temporary, and temporary workflows cannot be deleted.',
      recovery:
        'Leave temporary workflows to expire on their own — only permanent workflows can be deleted here.',
    },
    {
      reason: 'delete_failed',
      code: JsonRpcErrorCode.InternalError,
      when: 'Filesystem error while removing the workflow file, such as insufficient permissions.',
      recovery: 'Check that the workflows directory is writable, then retry the deletion.',
    },
    {
      reason: 'index_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The workflow index has not finished building yet.',
      recovery: 'Retry after the server has finished initializing its workflow index.',
    },
  ],

  async handler(input, ctx) {
    const svc = getWorkflowIndexService();
    if (!svc.ready) {
      throw ctx.fail('index_unavailable', 'Workflow index is not ready yet', {
        ...ctx.recoveryFor('index_unavailable'),
      });
    }

    let deleted: { name: string; version: string };
    try {
      deleted = await svc.deleteWorkflow(input.name, input.version);
    } catch (err: unknown) {
      const reason = (err as { _reason?: string })._reason;
      if (err instanceof Error && reason === 'not_found') {
        throw ctx.fail('not_found', err.message, { ...ctx.recoveryFor('not_found') });
      }
      if (err instanceof Error && reason === 'temp_not_allowed') {
        throw ctx.fail('temp_not_allowed', err.message, {
          ...ctx.recoveryFor('temp_not_allowed'),
        });
      }
      ctx.log.error(
        'Failed to delete workflow',
        err instanceof Error ? err : new Error(String(err)),
      );
      // Strip filesystem paths from the user-visible message.
      const safeMsg =
        err instanceof Error
          ? err.message.replace(/\s*unlink '.*?'/g, '').trim()
          : 'Unknown delete error';
      throw ctx.fail('delete_failed', `Failed to delete workflow: ${safeMsg}`, {
        ...ctx.recoveryFor('delete_failed'),
      });
    }

    ctx.log.info('workflow_delete completed', {
      name: deleted.name,
      version: deleted.version,
    });

    return {
      status: 'deleted' as const,
      name: deleted.name,
      version: deleted.version,
    };
  },

  format(result) {
    return [
      {
        type: 'text',
        text: [
          `## Workflow Deleted`,
          `**Status:** ${result.status}`,
          `**Name:** ${result.name}`,
          `**Version:** ${result.version}`,
        ].join('\n'),
      },
    ];
  },
});
