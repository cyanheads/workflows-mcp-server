/**
 * @fileoverview Tool definition for listing workflows from the index.
 * @module mcp-server/tools/definitions/workflow-list
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import * as semver from 'semver';
import { getWorkflowIndexService } from '@/services/workflow-index/workflow-index-service.js';

export const workflowList = tool('workflow_list', {
  title: 'List Workflows',
  description:
    'List permanent workflows, optionally narrowed by category (case-insensitive substring), tags (AND match), ' +
    'and a keyword query matched against workflow names and descriptions. Filters combine with AND. ' +
    'Set includeTools to true to surface the unique <server>/<tool> pairs used across each matching workflow. ' +
    'Temporary workflows are never included.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Keyword filter matched case-insensitively against each workflow name and description. A workflow matches if either field contains the query. Leading and trailing whitespace is ignored. Omit to skip keyword filtering.',
      ),
    category: z
      .string()
      .optional()
      .describe(
        'Filter to workflows whose category contains this string (case-insensitive substring match). Leading and trailing whitespace is ignored. Omit to return all categories.',
      ),
    tags: z
      .array(z.string())
      .optional()
      .describe(
        'Filter to workflows that have ALL of these tags (AND match, case-insensitive, each tag trimmed of leading and trailing whitespace). Omit to skip tag filtering.',
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
      .describe(
        'Matching workflows, sorted by name, then by semver precedence descending (a release before its prereleases).',
      ),
    totalCount: z.number().describe('Total number of matching workflows.'),
  }),

  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when no workflows match — echoes the applied filters and suggests how to broaden.',
      ),
  },

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
      throw ctx.fail('index_unavailable', 'Workflow index is not ready yet');
    }

    const { includeTools } = input;
    // Trim once so matching and the empty-result echo use the same values. A blank query or
    // category means "no filter"; a blank tag stays in the AND set and matches nothing.
    const query = input.query?.trim() || undefined;
    const category = input.category?.trim() || undefined;
    const tags = input.tags?.map((t) => t.trim());
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

      // Keyword filter (case-insensitive substring across name OR description)
      if (query) {
        const q = query.toLowerCase();
        if (!wf.name.toLowerCase().includes(q) && !wf.description.toLowerCase().includes(q)) {
          continue;
        }
      }

      // Category filter (case-insensitive substring)
      if (category) {
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

    // Sort by name, then by semver precedence descending — the same order findWorkflow() uses to
    // pick the latest. Every indexed version is valid semver, so rcompare cannot throw.
    results.sort((a, b) => a.name.localeCompare(b.name) || semver.rcompare(a.version, b.version));

    if (results.length === 0) {
      const applied: string[] = [];
      if (query) applied.push(`query "${query}"`);
      if (category) applied.push(`category "${category}"`);
      if (tags && tags.length > 0) applied.push(`tags [${tags.map((t) => `"${t}"`).join(', ')}]`);
      ctx.enrich.notice(
        applied.length > 0
          ? `No permanent workflows matched ${applied.join(', ')}. Remove or broaden a filter, or call again with no filters to list the full library.`
          : 'No permanent workflows are available yet. Create one with workflow_create.',
      );
    }

    ctx.log.info('workflow_list completed', {
      query: query ?? null,
      category: category ?? null,
      tags: tags ?? null,
      resultCount: results.length,
    });

    return { workflows: results, totalCount: results.length };
  },

  format(result) {
    // Empty result: the applied-filter echo + broadening hint ride the enrichment notice trailer.
    const lines: string[] = [`**Total workflows:** ${result.totalCount}`];
    if (result.totalCount === 0) {
      return [{ type: 'text', text: lines.join('\n') }];
    }

    lines.push('');
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
