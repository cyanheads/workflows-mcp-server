/**
 * @fileoverview Tests for workflow_create tool.
 * @module tests/tools/workflow-create.tool.test
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

import { workflowCreate } from '@/mcp-server/tools/definitions/workflow-create.tool.js';
import {
  getWorkflowIndexService,
  WorkflowIndexService,
} from '@/services/workflow-index/workflow-index-service.js';

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wf-create-test-'));
}

const VALID_INPUT = {
  name: 'Standard Deploy',
  version: '1.0.0',
  description: 'Deploy the app to production.',
  author: 'ops-team',
  category: 'Deployment',
  steps: [
    { server: 'deploy-server', tool: 'run_deploy', description: 'Run the deploy script' },
    { server: 'notify-server', tool: 'send_alert' },
  ],
};

describe('workflowCreate', () => {
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

  it('creates a workflow file and returns key/filePath/dates', async () => {
    const ctx = createMockContext({ errors: workflowCreate.errors });
    const input = workflowCreate.input.parse(VALID_INPUT);
    const result = await workflowCreate.handler(input, ctx);

    expect(result.key).toBe('Standard Deploy@1.0.0');
    expect(result.filePath).toContain('deployment');
    expect(result.filePath).toContain('.yaml');
    expect(result.created_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.last_updated_date).toBe(result.created_date);
  });

  it('the created file contains the expected YAML content', async () => {
    const ctx = createMockContext({ errors: workflowCreate.errors });
    const input = workflowCreate.input.parse(VALID_INPUT);
    const result = await workflowCreate.handler(input, ctx);

    const content = await fs.readFile(result.filePath, 'utf-8');
    expect(content).toContain('name: Standard Deploy');
    expect(content).toContain('version: "1.0.0"');
    expect(content).toContain('run_deploy');
  });

  it('slugifies the category for the directory path', async () => {
    const ctx = createMockContext({ errors: workflowCreate.errors });
    const input = workflowCreate.input.parse({
      ...VALID_INPUT,
      category: 'Git & GitHub Operations',
      version: '2.0.0',
    });
    const result = await workflowCreate.handler(input, ctx);
    expect(result.filePath).toContain('git-github-operations');
  });

  it('stores tags in the workflow when provided', async () => {
    const ctx = createMockContext({ errors: workflowCreate.errors });
    const input = workflowCreate.input.parse({ ...VALID_INPUT, tags: ['infra', 'prod'] });
    const result = await workflowCreate.handler(input, ctx);
    const content = await fs.readFile(result.filePath, 'utf-8');
    expect(content).toContain('infra');
    expect(content).toContain('prod');
  });

  // --- error paths ---

  it('throws already_exists when name@version already exists in the permanent index', async () => {
    const ctx = createMockContext({ errors: workflowCreate.errors });
    const input = workflowCreate.input.parse(VALID_INPUT);
    await workflowCreate.handler(input, ctx);

    const ctx2 = createMockContext({ errors: workflowCreate.errors });
    await expect(workflowCreate.handler(input, ctx2)).rejects.toMatchObject({
      code: JsonRpcErrorCode.Conflict,
      data: { reason: 'already_exists' },
    });
  });

  it('throws invalid_steps when steps array is empty (handler belt-and-suspenders)', async () => {
    // Zod schema has .min(1) so we manually bypass it to test the handler-level guard
    const ctx = createMockContext({ errors: workflowCreate.errors });
    const input = {
      ...(workflowCreate.input.parse(VALID_INPUT) as object),
      steps: [],
    } as Parameters<typeof workflowCreate.handler>[0];

    await expect(workflowCreate.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_steps' },
    });
  });

  it('throws invalid_steps when a step is missing the server field', async () => {
    const ctx = createMockContext({ errors: workflowCreate.errors });
    const input = {
      ...(workflowCreate.input.parse(VALID_INPUT) as object),
      steps: [{ server: '', tool: 'some_tool' }],
    } as Parameters<typeof workflowCreate.handler>[0];

    await expect(workflowCreate.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_steps' },
    });
  });

  it('preserves forEach field in the written YAML', async () => {
    const ctx = createMockContext({ errors: workflowCreate.errors });
    const input = workflowCreate.input.parse({
      ...VALID_INPUT,
      version: '3.0.0',
      steps: [
        {
          server: 'pubmed-server',
          tool: 'search_articles',
          forEach: '{{input.queries}}',
        },
      ],
    });
    const result = await workflowCreate.handler(input, ctx);
    const content = await fs.readFile(result.filePath, 'utf-8');
    expect(content).toContain('forEach');
    expect(content).toContain('{{input.queries}}');
  });

  // --- format ---

  it('formats output with key and file path', () => {
    const output = {
      filePath: '/tmp/wf/categories/deployment/standard-deploy-workflow.yaml',
      key: 'Standard Deploy@1.0.0',
      created_date: '2026-05-28',
      last_updated_date: '2026-05-28',
    };
    const blocks = workflowCreate.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Standard Deploy@1.0.0');
    expect(text).toContain('/tmp/wf/');
    expect(text).toContain('2026-05-28');
  });
});
