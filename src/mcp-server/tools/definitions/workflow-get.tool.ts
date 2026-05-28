/**
 * @fileoverview Tool definition for retrieving a complete workflow definition by name.
 * @module mcp-server/tools/definitions/workflow-get
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { ParsedWorkflow } from '@/services/workflow-index/types.js';
import { getWorkflowIndexService } from '@/services/workflow-index/workflow-index-service.js';

const StepOutputSchema = z.object({
  server: z.string().describe('Target MCP server name.'),
  tool: z.string().describe('Target tool on the server.'),
  action: z.string().optional().describe('Sub-action or variant label.'),
  description: z.string().optional().describe('Why this step exists.'),
  name: z.string().optional().describe('Step name (if provided in the workflow).'),
  params: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Key-value parameter map; may contain {{input.foo}} placeholders.'),
  forEach: z
    .string()
    .optional()
    .describe('Iteration expression (opaque string, not executed server-side).'),
});

const WorkflowOutputSchema = z.object({
  name: z.string().describe('Workflow name.'),
  version: z.string().describe('Workflow version (semver).'),
  description: z.string().describe('One-line description.'),
  author: z.string().describe('Workflow author.'),
  category: z.string().optional().describe('Workflow category.'),
  tags: z.array(z.string()).optional().describe('Tags associated with the workflow.'),
  created_date: z.string().optional().describe('Creation date (YYYY-MM-DD).'),
  last_updated_date: z.string().optional().describe('Last updated date (YYYY-MM-DD).'),
  temporary: z.boolean().optional().describe('True if this is a temporary workflow.'),
  steps: z
    .array(
      StepOutputSchema.describe(
        'A single step in the workflow: server, tool, and optional params/metadata.',
      ),
    )
    .describe('Ordered steps the consuming agent should execute.'),
});

export const workflowGet = tool('workflow_get', {
  title: 'Get Workflow',
  description:
    'Retrieve a complete workflow definition by name. When version is omitted, returns the highest semver match. ' +
    'Also returns the global instructions text from global_instructions.md (null when the file is absent). ' +
    'Template placeholders like {{input.foo}} in step params are opaque strings — the server returns them verbatim. ' +
    'Temporary workflows are accessible here but excluded from workflow_list.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  input: z.object({
    name: z.string().min(1).describe('Exact workflow name to retrieve.'),
    version: z
      .string()
      .optional()
      .describe(
        'Specific semver version to retrieve (e.g. "1.0.0"). Omit to get the highest available version.',
      ),
  }),

  output: z.object({
    workflow: WorkflowOutputSchema.describe('The complete workflow definition.'),
    globalInstructions: z
      .string()
      .nullable()
      .describe(
        'Content of the global_instructions.md file. Null when the file does not exist. Apply these instructions when executing the workflow.',
      ),
    source: z
      .enum(['permanent', 'temp'])
      .describe('Whether this is a permanent or temporary workflow.'),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No workflow matches the given name.',
      recovery: 'Use workflow_list to discover available workflow names and verify spelling.',
    },
    {
      reason: 'version_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Name exists but the specific version does not.',
      recovery: 'Omit version to get the latest, or use workflow_list to see available versions.',
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

    const entry = svc.findWorkflow(input.name, input.version);

    if (!entry) {
      // Distinguish "name exists, version doesn't" from "name doesn't exist"
      const nameMatches = svc.findByName(input.name);
      if (input.version && nameMatches.length > 0) {
        const available = nameMatches
          .map((e) => e.workflow.version)
          .sort()
          .join(', ');
        throw ctx.fail(
          'version_not_found',
          `Workflow "${input.name}" does not have version "${input.version}". Available: ${available}`,
          { ...ctx.recoveryFor('version_not_found') },
        );
      }
      throw ctx.fail('not_found', `No workflow named "${input.name}" found`, {
        ...ctx.recoveryFor('not_found'),
      });
    }

    const globalInstructions = await svc.readGlobalInstructions();

    ctx.log.info('workflow_get completed', {
      name: entry.workflow.name,
      version: entry.workflow.version,
      isTemp: entry.isTemp,
    });

    return {
      workflow: entry.workflow as unknown as z.infer<typeof WorkflowOutputSchema>,
      globalInstructions,
      source: (entry.isTemp ? 'temp' : 'permanent') as 'temp' | 'permanent',
    };
  },

  format(result) {
    const wf = result.workflow as ParsedWorkflow;
    const lines: string[] = [];

    lines.push(`# ${wf.name} v${wf.version}`);
    lines.push(`**Source:** ${result.source} | **Author:** ${wf.author}`);
    if (wf.category) lines.push(`**Category:** ${wf.category}`);
    if (wf.temporary) lines.push('**Temporary:** yes');
    if (wf.tags && wf.tags.length > 0) lines.push(`**Tags:** ${wf.tags.join(', ')}`);
    if (wf.created_date) lines.push(`**Created:** ${wf.created_date}`);
    if (wf.last_updated_date) lines.push(`**Updated:** ${wf.last_updated_date}`);
    lines.push('');
    lines.push(wf.description);
    lines.push('');

    if (result.globalInstructions) {
      lines.push('## Global Instructions');
      lines.push(result.globalInstructions);
      lines.push('');
    } else {
      lines.push('> **Note:** No global_instructions.md file found.');
      lines.push('');
    }

    lines.push(`## Steps (${wf.steps.length})`);
    wf.steps.forEach((step, i) => {
      lines.push(`### Step ${i + 1}: ${step.name ?? step.action ?? step.tool}`);
      lines.push(`**Server:** ${step.server} | **Tool:** ${step.tool}`);
      if (step.action) lines.push(`**Action:** ${step.action}`);
      if (step.description) lines.push(step.description);
      if (step.forEach) lines.push(`**For each:** ${step.forEach}`);
      if (step.params && Object.keys(step.params).length > 0) {
        lines.push('**Params:**');
        for (const [k, v] of Object.entries(step.params)) {
          lines.push(`  - \`${k}\`: ${JSON.stringify(v)}`);
        }
      }
      lines.push('');
    });

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
