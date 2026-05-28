/**
 * @fileoverview Tool definition for creating a temporary workflow.
 * @module mcp-server/tools/definitions/workflow-create-temp
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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
        'Key-value parameter map. May include {{input.foo}} placeholders for the consuming agent to resolve.',
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
    'Write a temporary workflow to the temp/ directory. ' +
    'Temporary workflows are indexed and retrievable via workflow_get but excluded from workflow_list results. ' +
    'No conflict check — temp is throwaway. Useful for one-shot plans, passing plans between agents by name, ' +
    'or scaffolding during reasoning chains. The server stamps created_date and last_updated_date automatically.',
  annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },

  input: z.object({
    name: z.string().min(1).describe('Workflow name (human-readable).'),
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+/)
      .describe('Semver version string (e.g. "1.0.0").'),
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
      reason: 'invalid_steps',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Steps array is empty or a step is missing required server/tool fields.',
      recovery: 'Each step must have server and tool fields; provide at least one step.',
    },
    {
      reason: 'write_failed',
      code: JsonRpcErrorCode.InternalError,
      when: 'Filesystem write error (permissions, disk full).',
      recovery: 'Check that the workflows directory is writable and has sufficient disk space.',
    },
  ],

  async handler(input, ctx) {
    const svc = getWorkflowIndexService();

    // Validate steps
    if (input.steps.length === 0) {
      throw ctx.fail('invalid_steps', 'At least one step is required', {
        ...ctx.recoveryFor('invalid_steps'),
      });
    }
    for (const step of input.steps) {
      if (!step.server || !step.tool) {
        throw ctx.fail('invalid_steps', 'Each step must have server and tool fields', {
          ...ctx.recoveryFor('invalid_steps'),
        });
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const workflow: ParsedWorkflow = {
      name: input.name,
      version: input.version,
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
      ctx.log.error(
        'Failed to write temp workflow',
        err instanceof Error ? err : new Error(String(err)),
      );
      throw ctx.fail('write_failed', `Failed to write temp workflow: ${String(err)}`, {
        ...ctx.recoveryFor('write_failed'),
      });
    }

    ctx.log.info('workflow_create_temp completed', {
      name: input.name,
      version: input.version,
      filePath,
    });

    return {
      status: 'created' as const,
      filePath,
      key: `${input.name}@${input.version}`,
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
