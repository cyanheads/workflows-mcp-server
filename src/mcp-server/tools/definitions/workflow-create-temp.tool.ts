/**
 * @fileoverview Tool definition for creating a temporary workflow.
 * @module mcp-server/tools/definitions/workflow-create-temp
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import * as semver from 'semver';
import type { ParsedWorkflow } from '@/services/workflow-index/types.js';
import { getWorkflowIndexService } from '@/services/workflow-index/workflow-index-service.js';

const StepInputSchema = z
  .object({
    server: z.string().min(1).describe('Target MCP server name.'),
    tool: z.string().min(1).describe('Target tool on the server.'),
    action: z.string().optional().describe('Sub-action or variant label.'),
    description: z.string().optional().describe('Why this step exists.'),
    name: z.string().optional().describe('Optional step name.'),
    params: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Key-value parameter map. May include {{input.foo}} placeholders, stored verbatim and resolved at execution time.',
      ),
    forEach: z
      .string()
      .optional()
      .describe('Iteration expression (opaque, not executed server-side).'),
  })
  .describe('A single workflow step with server, tool, and optional params/metadata.');

export const workflowCreateTemp = tool('workflow_create_temp', {
  title: 'Create Temporary Workflow',
  description:
    'Create a temporary workflow for one-shot plans, short-lived scaffolding, or drafts not meant for the permanent library. ' +
    'Temporary workflows are retrievable with workflow_get but never appear in workflow_list. ' +
    'Writing the same name and version overwrites the previous draft — there is no conflict check. ' +
    'Created and last-updated dates are stamped automatically.',
  annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },

  input: z.object({
    name: z.string().min(1).describe('Workflow name (human-readable).'),
    version: z
      .string()
      .refine((v) => semver.valid(v) !== null, {
        message: 'Version must be a valid semantic version (e.g. "1.0.0").',
      })
      .describe('Semver version string (e.g. "1.0.0"). Must be valid semver.'),
    description: z.string().min(1).describe('One-line description of what the workflow does.'),
    author: z.string().min(1).describe('Author name or team.'),
    tags: z.array(z.string()).optional().describe('Free-form tags.'),
    steps: z
      .array(StepInputSchema)
      .min(1)
      .describe('Ordered sequence of steps. Each step must have server and tool fields.'),
  }),

  output: z.object({
    status: z
      .literal('created')
      .describe('Confirms the temporary workflow was written to disk and indexed.'),
    filePath: z.string().describe('Absolute path where the workflow was written.'),
    key: z.string().describe('Index key for this workflow: name@version.'),
    created_date: z.string().describe('Date the workflow was created (YYYY-MM-DD).'),
    last_updated_date: z.string().describe('Date the workflow was last updated (YYYY-MM-DD).'),
  }),

  errors: [
    {
      reason: 'invalid_input',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The workflow name passed schema validation but slugifies to empty or exceeds the filename length limit.',
      recovery:
        'Provide a workflow name that contains alphanumeric characters and stays under 200 characters after slugification.',
    },
    {
      reason: 'write_failed',
      code: JsonRpcErrorCode.InternalError,
      when: 'Filesystem write error such as insufficient permissions or a full disk.',
      recovery:
        'Check that the workflows directory is writable and has sufficient disk space, then retry.',
    },
  ],

  async handler(input, ctx) {
    const svc = getWorkflowIndexService();

    const today = new Date().toISOString().slice(0, 10);
    const workflow: ParsedWorkflow = {
      name: input.name.trim(),
      version: input.version.trim(),
      description: input.description,
      author: input.author,
      ...(input.tags !== undefined && { tags: input.tags }),
      created_date: today,
      last_updated_date: today,
      temporary: true,
      steps: input.steps.map((s) => ({
        server: s.server,
        tool: s.tool,
        ...(s.action !== undefined && { action: s.action }),
        ...(s.description !== undefined && { description: s.description }),
        ...(s.name !== undefined && { name: s.name }),
        ...(s.params !== undefined && { params: s.params }),
        ...(s.forEach !== undefined && { forEach: s.forEach }),
      })),
    };

    let filePath: string;
    try {
      filePath = await svc.writeTemp(workflow);
    } catch (err: unknown) {
      const reason = (err as { _reason?: string })._reason;
      if (err instanceof Error && (reason === 'name_too_long' || reason === 'invalid_name')) {
        // Name-slug validation failures are bad input, not server faults.
        throw ctx.fail('invalid_input', err.message, { ...ctx.recoveryFor('invalid_input') });
      }
      ctx.log.error(
        'Failed to write temp workflow',
        err instanceof Error ? err : new Error(String(err)),
      );
      const safeMsg =
        err instanceof Error
          ? err.message.replace(/\s*open '.*?'/g, '').trim()
          : 'Unknown write error';
      throw ctx.fail('write_failed', `Failed to write temp workflow: ${safeMsg}`, {
        ...ctx.recoveryFor('write_failed'),
      });
    }

    ctx.log.info('workflow_create_temp completed', {
      name: workflow.name,
      version: workflow.version,
      filePath,
    });

    return {
      status: 'created' as const,
      filePath,
      key: `${workflow.name}@${workflow.version}`,
      created_date: today,
      last_updated_date: today,
    };
  },

  format(result) {
    return [
      {
        type: 'text',
        text: [
          `## Temporary Workflow Created`,
          `**Status:** ${result.status}`,
          `**Key:** ${result.key}`,
          `**File:** ${result.filePath}`,
          `**Created:** ${result.created_date}`,
          `**Updated:** ${result.last_updated_date}`,
          `> This workflow is temporary — excluded from workflow_list but accessible via workflow_get.`,
        ].join('\n'),
      },
    ];
  },
});
