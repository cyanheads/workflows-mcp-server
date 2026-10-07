/**
 * @fileoverview Tool definition for creating a permanent workflow.
 * @module mcp-server/tools/definitions/workflow-create
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import * as semver from 'semver';
import type { ParsedWorkflow } from '@/services/workflow-index/types.js';
import {
  canonicalVersion,
  findWorkflowIssues,
  getWorkflowIndexService,
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

export const workflowCreate = tool('workflow_create', {
  title: 'Create Workflow',
  description:
    'Create and durably store a new permanent workflow. ' +
    'Rejects the write when the same name and version already exist, as a permanent workflow or a temporary draft — bump the version to store a revision alongside the existing one. ' +
    'Created and last-updated dates are stamped automatically. ' +
    'Template placeholders like {{input.foo}} in step params are stored verbatim, not resolved. ' +
    'New workflows appear in workflow_list and are retrievable with workflow_get.',
  annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },

  input: z.object({
    name: z
      .string()
      .min(1)
      .describe(
        'Workflow name (human-readable, e.g. "Standard Git Wrap-up"). Must not be blank or whitespace-only.',
      ),
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
    category: z
      .string()
      .min(1)
      .describe(
        'Category name (e.g. "Git Operations") used to group the workflow. Must not be blank or whitespace-only.',
      ),
    tags: z.array(z.string()).optional().describe('Free-form tags for filtering.'),
    steps: z
      .array(StepInputSchema)
      .min(1)
      .describe('Ordered sequence of steps. Each step must have server and tool fields.'),
  }),

  output: z.object({
    status: z.literal('created').describe('Confirms the workflow was written to disk and indexed.'),
    filePath: z.string().describe('Absolute path where the workflow was written.'),
    key: z
      .string()
      .describe('Index key for this workflow: name@version, with the version in canonical form.'),
    created_date: z.string().describe('Date the workflow was created (YYYY-MM-DD).'),
    last_updated_date: z.string().describe('Date the workflow was last updated (YYYY-MM-DD).'),
  }),

  errors: [
    {
      reason: 'invalid_input',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A field passed schema validation but is semantically invalid: a whitespace-only name, description, author, category, or step server/tool; a category that slugifies to empty; or a name or category that exceeds its filename length limit after slugification.',
      recovery:
        'Give every required text field visible content, use a category that contains alphanumeric characters, and keep the name to at most 200 characters and the category to at most 255 characters after slugification.',
    },
    {
      reason: 'already_exists',
      code: JsonRpcErrorCode.Conflict,
      when: 'This name@version is already indexed, as a permanent workflow or as a temporary draft from workflow_create_temp.',
      recovery:
        'Change the version field or use a different name; if a temporary draft holds this name and version, delete the draft with workflow_delete and retry.',
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
      version: canonicalVersion(input.version),
      description: input.description,
      author: input.author,
      category: input.category.trim(),
      ...(input.tags !== undefined && { tags: input.tags }),
      created_date: today,
      last_updated_date: today,
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

    // Apply the index's own schema before writing: Zod min(1) passes "   ", and a file the
    // index would skip at rebuild must never be written in the first place.
    const issues = findWorkflowIssues(workflow);
    if (issues) {
      throw ctx.fail('invalid_input', `Invalid workflow — ${issues}`);
    }

    let filePath: string;
    try {
      filePath = await svc.writePermanent(workflow);
    } catch (err: unknown) {
      const reason = (err as { _reason?: string })._reason;
      if (err instanceof Error && reason === 'already_exists') {
        throw ctx.fail('already_exists', err.message);
      }
      if (
        err instanceof Error &&
        (reason === 'name_too_long' || reason === 'invalid_name' || reason === 'invalid_category')
      ) {
        // Slug validation failures (name or category) are bad input, not server faults —
        // surface as ValidationError with the service's message (no path leak).
        throw ctx.fail('invalid_input', err.message);
      }
      ctx.log.error(
        'Failed to write workflow',
        err instanceof Error ? err : new Error(String(err)),
      );
      // Strip filesystem paths from the user-visible message.
      const safeMsg = err instanceof Error ? withoutFsPath(err.message) : 'Unknown write error';
      throw ctx.fail('write_failed', `Failed to write workflow: ${safeMsg}`);
    }

    ctx.log.info('workflow_create completed', {
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
          `## Workflow Created`,
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
