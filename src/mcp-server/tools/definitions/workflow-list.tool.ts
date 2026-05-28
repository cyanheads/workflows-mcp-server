/**
 * @fileoverview Tool definition for listing workflows from the index.
 * @module mcp-server/tools/definitions/workflow-list
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getWorkflowIndexService } from '@/services/workflow-index/workflow-index-service.js';

export const workflowList = tool('workflow_list', {
  title: 'List Workflows',
  description:
    'List all permanent workflows in the index. Supports optional filtering by category and tags (AND match). ' +
    'Set includeTools to true to surface the unique <server>/<tool> pairs used across each matching workflow. ' +
    'Temporary workflows are excluded from results.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    category: z
      .string()
      .optional()
      .describe(
        'Filter to workflows whose category contains this string (case-insensitive substring match). Omit to return all categories.',
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe(
        'Filter to workflows that have ALL of these tags (AND match). Omit to skip tag filtering.',
      ),
    includeTools: z
      .boolean()
      .optional()
      .describe(
        'When true, each result includes a unique list of server/tool pairs used across its steps.',
      ),
  }),

  output: z.object({
    workflows: z
      .array(
        z
          .object({
            name: z.string().describe('Workflow name.'),
            version: z.string().describe('Workflow version (semver).'),
            description: z.string().describe('One-line description of the workflow.'),
            author: z.string().describe('Workflow author.'),
            category: z.string().optional().describe('Workflow category.'),
            tags: z.array(z.string()).optional().describe('Tags associated with the workflow.'),
            tools: z
              .array(z.string())
              .optional()
              .describe(
                'Unique server/tool pairs used by this workflow (only present when includeTools is true).',
              ),
          })
          .describe('Summary of a single workflow entry.'),
      )
      .describe('Matching workflows, sorted by name then version descending.'),
    totalCount: z.number().describe('Total number of matching workflows.'),
  }),

  errors: [
    {
      reason: 'index_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The workflow index has not finished building yet.',
      recovery: 'Retry after the server has finished initializing its workflow index.',
    },
  ],

  handler(input, ctx) {
    const svc = getWorkflowIndexService();
    if (!svc.ready) {
      throw ctx.fail('index_unavailable', 'Workflow index is not ready yet', {
        ...ctx.recoveryFor('index_unavailable'),
      });
    }

    const { category, tags, includeTools } = input;
    const results: {
      name: string;
      version: string;
      description: string;
      author: string;
      category?: string;
      tags?: string[];
      tools?: string[];
    }[] = [];

    for (const entry of svc.index.values()) {
      // Exclude temp workflows
      if (entry.isTemp) continue;

      const wf = entry.workflow;

      // Category filter (case-insensitive substring)
      if (category?.trim()) {
        if (!wf.category?.toLowerCase().includes(category.toLowerCase())) continue;
      }

      // Tags filter (AND match, case-insensitive)
      if (tags && tags.length > 0) {
        const wfTagsLower = (wf.tags ?? []).map((t) => t.toLowerCase());
        const allMatch = tags.every((t) => wfTagsLower.includes(t.toLowerCase()));
        if (!allMatch) continue;
      }

      const item: (typeof results)[number] = {
        name: wf.name,
        version: wf.version,
        description: wf.description,
        author: wf.author,
        ...(wf.category !== undefined && { category: wf.category }),
        ...(wf.tags !== undefined && { tags: wf.tags }),
      };

      if (includeTools) {
        const toolPairs = new Set<string>();
        for (const step of wf.steps) {
          toolPairs.add(`${step.server}/${step.tool}`);
        }
        item.tools = [...toolPairs].sort();
      }

      results.push(item);
    }

    // Sort by name then version descending
    results.sort((a, b) => {
      const nameCmp = a.name.localeCompare(b.name);
      if (nameCmp !== 0) return nameCmp;
      // semver descending (higher version first)
      const av = a.version.match(/^(\d+)\.(\d+)\.(\d+)/);
      const bv = b.version.match(/^(\d+)\.(\d+)\.(\d+)/);
      if (av && bv) {
        for (let i = 1; i <= 3; i++) {
          const diff = Number(bv[i]) - Number(av[i]);
          if (diff !== 0) return diff;
        }
      }
      return 0;
    });

    ctx.log.info('workflow_list completed', {
      category: category ?? null,
      tags: tags ?? null,
      resultCount: results.length,
    });

    return { workflows: results, totalCount: results.length };
  },

  format(result) {
    if (result.totalCount === 0) {
      return [
        {
          type: 'text',
          text: `No workflows found matching the applied filters.\n**Total:** ${result.totalCount}`,
        },
      ];
    }

    const lines: string[] = [`**Total workflows:** ${result.totalCount}\n`];
    for (const wf of result.workflows) {
      lines.push(`## ${wf.name} v${wf.version}`);
      lines.push(`**Author:** ${wf.author}`);
      if (wf.category) lines.push(`**Category:** ${wf.category}`);
      if (wf.tags && wf.tags.length > 0) lines.push(`**Tags:** ${wf.tags.join(', ')}`);
      lines.push(wf.description);
      if (wf.tools && wf.tools.length > 0) {
        lines.push(`**Tools used:** ${wf.tools.join(', ')}`);
      }
      lines.push('');
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
