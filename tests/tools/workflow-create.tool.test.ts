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
    // Emitted by the yaml serializer — a semver string round-trips unquoted.
    expect(content).toContain('version: 1.0.0');
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

  it('throws invalid_input for whitespace-only category', async () => {
    const ctx = createMockContext({ errors: workflowCreate.errors });
    const input = workflowCreate.input.parse({ ...VALID_INPUT, category: '   ' });
    await expect(workflowCreate.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_input' },
    });
  });

  it('throws invalid_input when the name slugifies to empty', async () => {
    const ctx = createMockContext({ errors: workflowCreate.errors });
    const input = workflowCreate.input.parse({ ...VALID_INPUT, name: '!!!', version: '4.0.0' });
    await expect(workflowCreate.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_input' },
    });
  });

  // GH #7 — a duplicate name@version under a different category must conflict, not overwrite.
  it('throws already_exists for a duplicate name@version in a different category (GH #7)', async () => {
    const ctx1 = createMockContext({ errors: workflowCreate.errors });
    await workflowCreate.handler(
      workflowCreate.input.parse({ ...VALID_INPUT, category: 'Alpha Category' }),
      ctx1,
    );

    const ctx2 = createMockContext({ errors: workflowCreate.errors });
    await expect(
      workflowCreate.handler(
        workflowCreate.input.parse({ ...VALID_INPUT, category: 'Beta Category' }),
        ctx2,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Conflict,
      data: { reason: 'already_exists' },
    });

    // Only the first file was written; the index holds a single entry for the key.
    expect(svc.findByName('Standard Deploy')).toHaveLength(1);
  });

  // GH #8 — a successful create must round-trip through the same parser/indexer used at
  // startup. Coercion-prone strings previously emitted as booleans/numbers and vanished.
  it('round-trips coercion-prone strings and params keys through the index (GH #8)', async () => {
    const ctx = createMockContext({ errors: workflowCreate.errors });
    const input = workflowCreate.input.parse({
      ...VALID_INPUT,
      name: 'Coercion Edge',
      version: '5.0.0',
      description: 'true',
      author: '123',
      tags: ['false', '123'],
      steps: [{ server: 'srv', tool: 'tool', params: { 'bad: key': 'value' } }],
    });
    const result = await workflowCreate.handler(input, ctx);

    const entry = svc.index.get(result.key);
    expect(entry).toBeDefined();
    expect(entry?.workflow.description).toBe('true');
    expect(entry?.workflow.author).toBe('123');
    expect(entry?.workflow.tags).toEqual(['false', '123']);
    expect(entry?.workflow.steps[0]?.params).toEqual({ 'bad: key': 'value' });
  });

  // GH #9 — a start-anchored regex accepted "1.0.0junk"; full semver validation rejects it.
  it('rejects an invalid semver version at input validation (GH #9)', () => {
    const parsed = workflowCreate.input.safeParse({ ...VALID_INPUT, version: '1.0.0junk' });
    expect(parsed.success).toBe(false);
  });

  // GH #10 — a category with no slug-safe characters would write into the categories/ root.
  it('throws invalid_input when the category slugifies to empty (GH #10)', async () => {
    const ctx = createMockContext({ errors: workflowCreate.errors });
    const input = workflowCreate.input.parse({ ...VALID_INPUT, category: '!!!', version: '6.0.0' });
    await expect(workflowCreate.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_input' },
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
      filePath: '/tmp/wf/categories/deployment/standard-deploy-1-0-0-workflow.yaml',
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
