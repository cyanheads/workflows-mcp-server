/**
 * @fileoverview Tool definition for deleting a workflow — permanent or temporary draft — by name
 * and version, after the user confirms the resolved target.
 * @module mcp-server/tools/definitions/workflow-delete
 */

import { inputRequired, tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import * as semver from 'semver';
import {
  canonicalVersion,
  type DeletedWorkflow,
  getWorkflowIndexService,
  withoutFsPath,
} from '@/services/workflow-index/workflow-index-service.js';

/** The user's answer to the confirmation prompt. */
const ConfirmSchema = z.object({
  confirm: z.boolean().describe('Set to true to delete the workflow named above.'),
});

export const workflowDelete = tool('workflow_delete', {
  title: 'Delete Workflow',
  description:
    'Remove a workflow — a permanent workflow or a temporary draft — from the library by name. When version is omitted, ' +
    'the highest version across both is selected; pass a version to target a specific one. Before anything is deleted, the ' +
    'user is asked to confirm the resolved workflow (name@version, whether it is permanent or temporary, and its file). ' +
    'Each prompt is valid for one answer within 10 minutes, and the file is deleted only if it is unchanged since the user ' +
    'saw it; a declined confirmation deletes nothing, and a client that cannot show the prompt cannot delete. Deletion is ' +
    'irreversible: the file is removed, and the workflow no longer appears in workflow_list or workflow_get — unless another ' +
    'file declares the same name and version, in which case that copy takes its place and the result carries a notice naming it. ' +
    'Deleting a draft frees its name and version for workflow_create.',
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },

  input: z.object({
    name: z
      .string()
      .min(1)
      .refine((v) => v.trim().length > 0, { message: 'Name must not be blank or whitespace-only.' })
      .describe(
        'Exact name of the workflow to delete. Leading and trailing whitespace is ignored; a blank name is rejected.',
      ),
    version: z
      .string()
      // An empty string reads as omitted, for form-based clients that send "" for an unset field.
      .refine((v) => v === '' || semver.valid(v) !== null, {
        message: 'Version must be a valid semantic version (e.g. "1.0.0").',
      })
      .optional()
      .describe(
        'Specific semver version to delete (e.g. "1.0.0"). Must be valid semver; surrounding whitespace, a leading "v", and build metadata are ignored, so "v1.0.0" deletes 1.0.0. Omit to delete the highest available version, permanent or temporary.',
      ),
  }),

  output: z.object({
    status: z.literal('deleted').describe('Confirms the workflow was removed from the library.'),
    name: z.string().describe('Name of the deleted workflow.'),
    version: z.string().describe('Version (semver) of the deleted workflow.'),
    source: z
      .enum(['permanent', 'temp'])
      .describe('Whether the deleted workflow was a permanent workflow or a temporary draft.'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Present when another file declares the same name and version: names that file, relative to the workflows directory, which workflow_get now returns for the key.',
      ),
  },

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No permanent workflow or temporary draft matches the given name, or the given name and version.',
      recovery:
        'Use workflow_list to see permanent workflow names and versions (temporary drafts are not listed; use the key workflow_create_temp returned), then retry; omit version to target the latest.',
    },
    {
      reason: 'cancelled',
      code: JsonRpcErrorCode.InvalidRequest,
      when: 'The user answered the confirmation with confirm set to false, declined it, or cancelled it.',
      recovery:
        'Nothing was deleted. Leave the workflow in place unless the user asks again to delete it.',
      severity: 'notice',
    },
    {
      reason: 'confirmation_invalid',
      code: JsonRpcErrorCode.InvalidRequest,
      when: 'The answering call does not carry a confirmation this server issued and has not yet redeemed: it is missing, unknown, already used, or older than 10 minutes.',
      recovery:
        'Nothing was deleted. Call workflow_delete again with only name and version so the user is asked to confirm; each prompt accepts one answer within 10 minutes.',
    },
    {
      reason: 'target_changed',
      code: JsonRpcErrorCode.Conflict,
      when: 'Between the confirmation prompt and the answer, the name and version came to resolve to a different workflow or file than the one the user confirmed, or that file’s content changed.',
      recovery:
        'Nothing was deleted. Call workflow_delete again so the user confirms the current target; pass version to pin one.',
    },
    {
      reason: 'delete_failed',
      code: JsonRpcErrorCode.InternalError,
      when: 'Filesystem error while reading the workflow file for the prompt or removing it, such as insufficient permissions.',
      recovery:
        'Check that the workflow file is readable and the workflows directory is writable, then retry the deletion.',
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
    /**
     * `requestState` round-trips through the client, so it carries only the id of a confirmation
     * the service holds. Redeem it before anything else: an id works once, whatever this round
     * turns out to be, and a replayed, expired, or invented one yields nothing.
     */
    const confirmed = svc.takeDeleteConfirmation(ctx.inputs.state());
    if (!svc.ready) {
      throw ctx.fail('index_unavailable', 'Workflow index is not ready yet', {
        ...ctx.recoveryFor('index_unavailable'),
      });
    }

    const name = input.name.trim();
    const version = input.version ? canonicalVersion(input.version) : undefined;

    // First round: resolve the target and ask the user to confirm exactly that file. The prompt
    // runs outside the service's mutation queue, so nothing is held while the user decides.
    if (ctx.inputs.view('confirm').kind === 'missing') {
      let issued: Awaited<ReturnType<typeof svc.requestDeleteConfirmation>>;
      try {
        issued = await svc.requestDeleteConfirmation(name, version);
      } catch (err: unknown) {
        if (err instanceof Error && (err as { _reason?: string })._reason === 'not_found') {
          throw ctx.fail('not_found', err.message, { ...ctx.recoveryFor('not_found') });
        }
        ctx.log.error(
          'Failed to read workflow for confirmation',
          err instanceof Error ? err : new Error(String(err)),
        );
        const safeMsg = err instanceof Error ? withoutFsPath(err.message) : 'Unknown read error';
        throw ctx.fail('delete_failed', `Failed to read workflow for confirmation: ${safeMsg}`, {
          ...ctx.recoveryFor('delete_failed'),
        });
      }
      const { target } = issued;
      return ctx.requestInput({
        inputRequests: {
          confirm: inputRequired.elicit({
            message: `Delete workflow "${target.name}@${target.version}" (${target.source}) at ${target.path} in the workflows directory? This cannot be undone.`,
            requestedSchema: ConfirmSchema,
          }),
        },
        requestState: issued.id,
      });
    }

    // Anything but an accepted `confirm: true` is final: declined, cancelled, false, or malformed.
    const answer = ctx.inputs.accepted('confirm', ConfirmSchema);
    if (!answer?.confirm) {
      throw ctx.fail('cancelled', 'Deletion cancelled by the user — nothing was deleted.', {
        ...ctx.recoveryFor('cancelled'),
      });
    }

    if (!confirmed) {
      throw ctx.fail(
        'confirmation_invalid',
        'This answer does not match a pending confirmation prompt from this server — nothing was deleted.',
        { ...ctx.recoveryFor('confirmation_invalid') },
      );
    }

    let deleted: DeletedWorkflow;
    try {
      deleted = await svc.deleteWorkflow(name, version, confirmed);
    } catch (err: unknown) {
      const reason = (err as { _reason?: string })._reason;
      if (err instanceof Error && reason === 'not_found') {
        throw ctx.fail('not_found', err.message, { ...ctx.recoveryFor('not_found') });
      }
      if (err instanceof Error && reason === 'target_changed') {
        throw ctx.fail('target_changed', `${err.message} — nothing was deleted.`, {
          ...ctx.recoveryFor('target_changed'),
        });
      }
      ctx.log.error(
        'Failed to delete workflow',
        err instanceof Error ? err : new Error(String(err)),
      );
      // Strip filesystem paths from the user-visible message.
      const safeMsg = err instanceof Error ? withoutFsPath(err.message) : 'Unknown delete error';
      throw ctx.fail('delete_failed', `Failed to delete workflow: ${safeMsg}`, {
        ...ctx.recoveryFor('delete_failed'),
      });
    }

    ctx.log.info('workflow_delete completed', {
      name: deleted.name,
      version: deleted.version,
      source: confirmed.source,
    });

    if (deleted.nowIndexedPath) {
      ctx.enrich.notice(
        `Another file also declares ${deleted.name}@${deleted.version}: workflow_get now returns the copy at ${deleted.nowIndexedPath} in the workflows directory.`,
      );
    }
    return {
      status: 'deleted' as const,
      name: deleted.name,
      version: deleted.version,
      // The service deleted only after matching the entry to `confirmed` field by field.
      source: confirmed.source,
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
          `**Source:** ${result.source}`,
        ].join('\n'),
      },
    ];
  },
});
