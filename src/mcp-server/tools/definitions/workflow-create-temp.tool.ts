/**
 * @fileoverview Tool definition for creating a temporary workflow.
 * @module mcp-server/tools/definitions/workflow-create-temp
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import * as semver from 'semver';
import type { ParsedWorkflow } from '@/services/workflow-index/types.js';
import {
  canonicalVersion,
  findWorkflowIssues,
  getWorkflowIndexService,
  type TempWriteResult,
  withoutFsPath,
} from '@/services/workflow-index/workflow-index-service.js';

const StepInputSchema = z
  .object({
    server: z
      .string()
      .min(1)
      .describe('Target MCP server name. Must not be blank or whitespace-only.'),
    tool: z
      .string()
      .min(1)
      .describe('Target tool on the server. Must not be blank or whitespace-only.'),
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
    'Create a temporary workflow draft for a one-shot plan, scaffolding, or a draft not yet meant for the permanent library. ' +
    'Drafts are retrievable with workflow_get but never appear in workflow_list. ' +
    'A draft stays on disk until it is deleted with workflow_delete — nothing expires it. ' +
    'Writing a name and version that already has a draft overwrites that draft, keeps its created date, and reports status "overwritten"; ' +
    'a name and version held by a permanent workflow is rejected. ' +
    'Created and last-updated dates are stamped automatically.',
  annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },

  input: z.object({
    name: z
      .string()
      .min(1)
      .describe('Workflow name (human-readable). Must not be blank or whitespace-only.'),
    version: z
      .string()
      .refine((v) => semver.valid(v) !== null, {
        message: 'Version must be a valid semantic version (e.g. "1.0.0").',
      })
      .describe(
        'Semver version string (e.g. "1.0.0"). Must be valid semver. Stored in canonical form: surrounding whitespace, a leading "v", and build metadata are dropped, so "v1.0.0+build.5" is stored as "1.0.0".',
      ),
    description: z
      .string()
      .min(1)
      .describe(
        'One-line description of what the workflow does. Must not be blank or whitespace-only.',
      ),
    author: z
      .string()
      .min(1)
      .describe('Author name or team. Must not be blank or whitespace-only.'),
    tags: z.array(z.string()).optional().describe('Free-form tags.'),
    steps: z
      .array(StepInputSchema)
      .min(1)
      .describe('Ordered sequence of steps. Each step must have server and tool fields.'),
  }),

  output: z.object({
    status: z
      .enum(['created', 'overwritten'])
      .describe(
        'Outcome of the write: "created" for a new draft, "overwritten" when it replaced the existing draft with the same name and version. Either way the draft is on disk and indexed.',
      ),
    filePath: z.string().describe('Absolute path where the workflow was written.'),
    key: z
      .string()
      .describe('Index key for this workflow: name@version, with the version in canonical form.'),
    created_date: z
      .string()
      .describe(
        'Date the workflow was created (YYYY-MM-DD) — on an overwrite, the replaced draft’s original date.',
      ),
    last_updated_date: z.string().describe('Date the workflow was last updated (YYYY-MM-DD).'),
  }),

  enrichment: {
    notice: z
      .string()
      .describe(
        'Reminder that the workflow is a temporary draft: excluded from workflow_list, retrievable with workflow_get, kept until deleted with workflow_delete.',
      ),
  },

  errors: [
    {
      reason: 'invalid_input',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A field passed schema validation but is semantically invalid: a whitespace-only name, description, author, or step server/tool, or a name that exceeds the filename length limit after slugification.',
      recovery:
        'Give every required text field visible content and keep the workflow name to at most 200 characters after slugification.',
    },
    {
      reason: 'already_exists',
      code: JsonRpcErrorCode.Conflict,
      when: 'A permanent workflow already holds this name@version, and a temporary draft cannot share its key.',
      recovery:
        'Choose a different version or name for the draft, or read the existing permanent workflow with workflow_get.',
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
    const workflow = {
      name: input.name.trim(),
      version: canonicalVersion(input.version),
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
    } satisfies ParsedWorkflow;

    // Apply the index's own schema before writing: Zod min(1) passes "   ", and a file the
    // index would skip at rebuild must never be written in the first place.
    const issues = findWorkflowIssues(workflow);
    if (issues) {
      throw ctx.fail('invalid_input', `Invalid workflow — ${issues}`);
    }

    let written: TempWriteResult<typeof workflow>;
    try {
      written = await svc.writeTemp(workflow);
    } catch (err: unknown) {
      const reason = (err as { _reason?: string })._reason;
      if (err instanceof Error && reason === 'already_exists') {
        throw ctx.fail('already_exists', err.message);
      }
      if (err instanceof Error && (reason === 'name_too_long' || reason === 'invalid_name')) {
        // Name-slug validation failures are bad input, not server faults.
        throw ctx.fail('invalid_input', err.message);
      }
      ctx.log.error(
        'Failed to write temp workflow',
        err instanceof Error ? err : new Error(String(err)),
      );
      // Strip filesystem paths from the user-visible message.
      const safeMsg = err instanceof Error ? withoutFsPath(err.message) : 'Unknown write error';
      throw ctx.fail('write_failed', `Failed to write temp workflow: ${safeMsg}`);
    }

    ctx.log.info('workflow_create_temp completed', {
      name: workflow.name,
      version: workflow.version,
      filePath: written.filePath,
      status: written.status,
    });

    ctx.enrich.notice(
      'This workflow is a temporary draft — excluded from workflow_list, retrievable with workflow_get, and kept until deleted with workflow_delete.',
    );
    return {
      status: written.status,
      filePath: written.filePath,
      key: `${workflow.name}@${workflow.version}`,
      created_date: written.workflow.created_date,
      last_updated_date: written.workflow.last_updated_date,
    };
  },

  format(result) {
    return [
      {
        type: 'text',
        text: [
          `## Temporary Workflow ${result.status === 'created' ? 'Created' : 'Overwritten'}`,
          `**Status:** ${result.status}`,
          `**Key:** ${result.key}`,
          `**File:** ${result.filePath}`,
          `**Created:** ${result.created_date}`,
          `**Updated:** ${result.last_updated_date}`,
        ].join('\n'),
      },
    ];
  },
});
