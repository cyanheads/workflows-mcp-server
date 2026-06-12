/**
 * @fileoverview Tests for workflow_create_temp tool.
 * @module tests/tools/workflow-create-temp.tool.test
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/workflow-index/workflow-index-service.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/services/workflow-index/workflow-index-service.js')>();
  return {
    ...actual,
    getWorkflowIndexService: vi.fn(),
  };
});

import { workflowCreateTemp } from '@/mcp-server/tools/definitions/workflow-create-temp.tool.js';
import {
  getWorkflowIndexService,
  WorkflowIndexService,
} from '@/services/workflow-index/workflow-index-service.js';

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wf-create-temp-test-'));
}

const VALID_INPUT = {
  name: 'Quick Research Plan',
  version: '1.0.0',
  description: 'A temporary plan for research.',
  author: 'agent',
  steps: [{ server: 'pubmed-server', tool: 'search_articles', description: 'Search PubMed' }],
};

describe('workflowCreateTemp', () => {
  let dir: string;
  let svc: WorkflowIndexService;

  beforeEach(async () => {
    dir = await mkTmpDir();
    svc = new WorkflowIndexService(dir, path.join(dir, 'global_instructions.md'), 10);
    await svc.init();
    vi.mocked(getWorkflowIndexService).mockReturnValue(svc);
  });

  afterEach(async () => {
    svc.shutdown();
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  // --- happy path ---

  it('creates a temp workflow file under temp/ and returns key/filePath', async () => {
    const ctx = createMockContext({ errors: workflowCreateTemp.errors });
    const input = workflowCreateTemp.input.parse(VALID_INPUT);
    const result = await workflowCreateTemp.handler(input, ctx);

    expect(result.key).toBe('Quick Research Plan@1.0.0');
    expect(result.filePath).toContain('temp');
    expect(result.filePath).toContain('.yaml');
    expect(result.created_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('file contains temporary: true', async () => {
    const ctx = createMockContext({ errors: workflowCreateTemp.errors });
    const input = workflowCreateTemp.input.parse(VALID_INPUT);
    const result = await workflowCreateTemp.handler(input, ctx);
    const content = await fs.readFile(result.filePath, 'utf-8');
    expect(content).toContain('temporary: true');
  });

  it('does not require a category field', async () => {
    // Temp workflows have no category field — confirm the input has no category
    expect('category' in VALID_INPUT).toBe(false);
    const ctx = createMockContext({ errors: workflowCreateTemp.errors });
    const input = workflowCreateTemp.input.parse(VALID_INPUT);
    const result = await workflowCreateTemp.handler(input, ctx);
    expect(result.key).toContain('@');
  });

  it('allows writing the same name@version twice (no conflict check for temp)', async () => {
    const ctx1 = createMockContext({ errors: workflowCreateTemp.errors });
    const input = workflowCreateTemp.input.parse(VALID_INPUT);
    const result1 = await workflowCreateTemp.handler(input, ctx1);

    const ctx2 = createMockContext({ errors: workflowCreateTemp.errors });
    const result2 = await workflowCreateTemp.handler(input, ctx2);

    // Both writes resolve to the same path (second overwrites)
    expect(result1.key).toBe(result2.key);
    expect(result2.filePath).toBe(result1.filePath);
  });

  it('stores optional tags in the file', async () => {
    const ctx = createMockContext({ errors: workflowCreateTemp.errors });
    const input = workflowCreateTemp.input.parse({
      ...VALID_INPUT,
      tags: ['short-lived', 'research'],
    });
    const result = await workflowCreateTemp.handler(input, ctx);
    const content = await fs.readFile(result.filePath, 'utf-8');
    expect(content).toContain('short-lived');
    expect(content).toContain('research');
  });

  // --- error paths ---

  it('throws invalid_input for a name that slugifies to empty string', async () => {
    const ctx = createMockContext({ errors: workflowCreateTemp.errors });
    // Bypass Zod min(1) to exercise the service-level invalid_name guard
    const input = {
      ...(workflowCreateTemp.input.parse(VALID_INPUT) as object),
      name: '   ',
    } as Parameters<typeof workflowCreateTemp.handler>[0];
    await expect(workflowCreateTemp.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_input' },
    });
  });

  it('preserves forEach field in the written YAML', async () => {
    const ctx = createMockContext({ errors: workflowCreateTemp.errors });
    const input = workflowCreateTemp.input.parse({
      ...VALID_INPUT,
      steps: [
        {
          server: 'pubmed-server',
          tool: 'search_articles',
          forEach: '{{input.ids}}',
        },
      ],
    });
    const result = await workflowCreateTemp.handler(input, ctx);
    const content = await fs.readFile(result.filePath, 'utf-8');
    expect(content).toContain('forEach');
    expect(content).toContain('{{input.ids}}');
  });

  // --- format ---

  it('formats output with key, file path, and temp note', () => {
    const output = {
      filePath: '/tmp/workflows/temp/quick-research-plan-1-0-0-workflow.yaml',
      key: 'Quick Research Plan@1.0.0',
      created_date: '2026-05-28',
      last_updated_date: '2026-05-28',
    };
    const blocks = workflowCreateTemp.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Quick Research Plan@1.0.0');
    expect(text).toContain('/tmp/workflows/temp/');
    expect(text).toContain('temporary');
  });
});
