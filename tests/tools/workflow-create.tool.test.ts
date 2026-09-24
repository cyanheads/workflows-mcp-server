/**
 * @fileoverview Tests for workflow_create tool.
 * @module tests/tools/workflow-create.tool.test
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';

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
  slugify,
  WorkflowIndexService,
} from '@/services/workflow-index/workflow-index-service.js';

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wf-create-test-'));
}

/** Readable slugs plus the first 8 hex characters of SHA-256 over the stored `name@version`. */
function fileNameFor(name: string, version: string, nameSlug = slugify(name)): string {
  const hash = createHash('sha256').update(`${name}@${version}`).digest('hex').slice(0, 8);
  return `${nameSlug}-${slugify(version)}-${hash}-workflow.yaml`;
}

type ErrorEnvelope = {
  error: { code: number; message: string; data: { reason: string; recovery?: { hint: string } } };
};

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
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
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

  it('accepts a name that slugifies to empty under a placeholder name segment (GH #29)', async () => {
    const ctx = createMockContext({ errors: workflowCreate.errors });
    const input = workflowCreate.input.parse({ ...VALID_INPUT, name: '!!!', version: '4.0.0' });
    const result = await workflowCreate.handler(input, ctx);
    expect(result.key).toBe('!!!@4.0.0');
    expect(path.basename(result.filePath)).toBe(fileNameFor('!!!', '4.0.0', 'workflow'));
    expect(svc.findWorkflow('!!!', '4.0.0')?.filePath).toBe(result.filePath);
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

  // --- canonical version (GH #26) ---

  it.each([
    ['v1.0.0', '1.0.0'],
    [' 1.0.0 ', '1.0.0'],
    ['1.0.0+build.5', '1.0.0'],
    ['v2.0.0-rc.1', '2.0.0-rc.1'],
  ])(
    'persists the tolerated spelling %j as the canonical version (GH #26)',
    async (version, canonical) => {
      const result = await runToolContract(workflowCreate, { ...VALID_INPUT, version });
      expect(result.isError).toBeFalsy();

      const key = `Standard Deploy@${canonical}`;
      const structured = result.structuredContent as { key: string; filePath: string };
      expect(structured.key).toBe(key);
      expect((result.content[0] as { text: string }).text).toContain(`**Key:** ${key}`);

      // Written YAML, index key, and filename all carry the canonical form.
      const written = parseYaml(await fs.readFile(structured.filePath, 'utf-8')) as {
        version: string;
      };
      expect(written.version).toBe(canonical);
      expect(path.basename(structured.filePath)).toBe(fileNameFor('Standard Deploy', canonical));
      expect([...svc.index.keys()]).toEqual([key]);
      expect(svc.findWorkflow('Standard Deploy', canonical)?.filePath).toBe(structured.filePath);
    },
  );

  it('conflicts when a tolerated spelling canonicalizes to an existing version (GH #26)', async () => {
    const ctx = createMockContext({ errors: workflowCreate.errors });
    await workflowCreate.handler(workflowCreate.input.parse(VALID_INPUT), ctx);

    const ctx2 = createMockContext({ errors: workflowCreate.errors });
    await expect(
      workflowCreate.handler(
        workflowCreate.input.parse({ ...VALID_INPUT, version: 'v1.0.0' }),
        ctx2,
      ),
    ).rejects.toMatchObject({
      code: JsonRpcErrorCode.Conflict,
      data: { reason: 'already_exists' },
      message: 'Workflow "Standard Deploy@1.0.0" already exists',
    });
    expect(svc.findByName('Standard Deploy')).toHaveLength(1);
  });

  // --- blank required text (GH #22) ---

  it.each([
    ['name', { name: '   ' }],
    ['description', { description: '   ' }],
    ['author', { author: '\t' }],
    ['category', { category: '  ' }],
    ['steps.0.server', { steps: [{ server: '   ', tool: 'run_deploy' }] }],
    [
      'steps.1.tool',
      {
        steps: [
          { server: 'deploy-server', tool: 'run_deploy' },
          { server: 'notify-server', tool: '  ' },
        ],
      },
    ],
  ])(
    'rejects a whitespace-only %s as invalid_input and writes nothing (GH #22)',
    async (field, override) => {
      const result = await runToolContract(workflowCreate, { ...VALID_INPUT, ...override });

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as ErrorEnvelope;
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('invalid_input');
      expect(error.message).toContain(field);
      expect((result.content[0] as { text: string }).text).toContain(field);

      expect(svc.index.size).toBe(0);
      await expect(fs.stat(path.join(dir, 'categories'))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  // --- one index entry per key across sources (GH #19) ---

  it('rejects a key a temp draft holds with already_exists pointing at workflow_delete (GH #19)', async () => {
    await svc.writeTemp({
      name: 'Standard Deploy',
      version: '1.0.0',
      description: 'draft',
      author: 'agent',
      temporary: true,
      steps: [{ server: 'deploy-server', tool: 'run_deploy' }],
    });

    const result = await runToolContract(workflowCreate, VALID_INPUT);

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as ErrorEnvelope;
    expect(error.code).toBe(JsonRpcErrorCode.Conflict);
    expect(error.data.reason).toBe('already_exists');
    expect(error.message).toContain('Standard Deploy@1.0.0');
    expect(error.data.recovery?.hint).toContain('workflow_delete');
    expect((result.content[0] as { text: string }).text).toContain('workflow_delete');

    await expect(fs.stat(path.join(dir, 'categories'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(svc.findWorkflow('Standard Deploy', '1.0.0')?.isTemp).toBe(true);
  });

  // --- slug-colliding keys and non-ASCII names (GH #21, #29) ---

  it.each([
    ['Slug A+B', '1.0.0', 'Slug A B', '1.0.0'],
    ['Deploy', '1.0.0', 'deploy', '1.0.0'],
    ['Café Plan', '1.0.0', 'Caf Plan', '1.0.0'],
    ['Semver Slug Collision', '1.0.0-alpha', 'Semver Slug Collision', '1.0.0+alpha'],
    ['RC Probe', '1.0.0-RC1', 'RC Probe', '1.0.0-rc1'],
  ])(
    'creates %j@%s and %j@%s as two workflows (GH #21)',
    async (nameA, versionA, nameB, versionB) => {
      const first = await runToolContract(workflowCreate, {
        ...VALID_INPUT,
        name: nameA,
        version: versionA,
      });
      const second = await runToolContract(workflowCreate, {
        ...VALID_INPUT,
        name: nameB,
        version: versionB,
      });

      expect(first.isError).toBeFalsy();
      expect(second.isError).toBeFalsy();
      const a = first.structuredContent as { key: string; filePath: string };
      const b = second.structuredContent as { key: string; filePath: string };
      expect(b.filePath).not.toBe(a.filePath);
      expect(svc.index.get(a.key)?.filePath).toBe(a.filePath);
      expect(svc.index.get(b.key)?.filePath).toBe(b.filePath);
    },
  );

  it('creates, resolves, and indexes a name written entirely in a non-Latin script (GH #29)', async () => {
    const result = await runToolContract(workflowCreate, {
      ...VALID_INPUT,
      name: 'Рабочий процесс',
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { key: string; filePath: string };
    expect(structured.key).toBe('Рабочий процесс@1.0.0');
    expect((result.content[0] as { text: string }).text).toContain(
      '**Key:** Рабочий процесс@1.0.0',
    );
    expect(path.basename(structured.filePath)).toBe(
      fileNameFor('Рабочий процесс', '1.0.0', 'workflow'),
    );
    expect(svc.findWorkflow('Рабочий процесс')?.filePath).toBe(structured.filePath);
  });

  // --- serialized writes (GH #30) ---

  it('lets exactly one of two parallel creates of one key into different categories succeed (GH #30)', async () => {
    const results = await Promise.all([
      runToolContract(workflowCreate, { ...VALID_INPUT, category: 'alpha' }),
      runToolContract(workflowCreate, { ...VALID_INPUT, category: 'beta' }),
    ]);

    const [first, second] = results;
    expect(Boolean(first.isError)).toBe(false);
    expect(Boolean(second.isError)).toBe(true);
    expect((second.structuredContent as ErrorEnvelope).error.data.reason).toBe('already_exists');
    const files = (await fs.readdir(path.join(dir, 'categories'), { recursive: true })).filter(
      (f) => f.endsWith('.yaml'),
    );
    expect(files).toHaveLength(1);
  });

  // --- slug length bounds (GH #31) ---

  it('rejects a category whose slug exceeds 255 characters as invalid_input and writes nothing (GH #31)', async () => {
    const result = await runToolContract(workflowCreate, {
      ...VALID_INPUT,
      category: 'c'.repeat(300),
    });

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as ErrorEnvelope;
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data.reason).toBe('invalid_input');
    expect(error.message).toContain('at most 255 characters');
    expect(error.message).not.toContain(dir);
    expect(error.data.recovery?.hint).toContain('255');
    expect((result.content[0] as { text: string }).text).toContain('at most 255 characters');
    expect(svc.index.size).toBe(0);
    await expect(fs.stat(path.join(dir, 'categories'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    [255, false],
    [256, true],
  ])('treats a %i-character category slug as over the limit: %s (GH #31)', async (length, over) => {
    const result = await runToolContract(workflowCreate, {
      ...VALID_INPUT,
      category: 'c'.repeat(length),
    });

    expect(Boolean(result.isError)).toBe(over);
    if (over) {
      expect((result.structuredContent as ErrorEnvelope).error.data.reason).toBe('invalid_input');
    } else {
      const { filePath } = result.structuredContent as { filePath: string };
      expect(path.basename(path.dirname(filePath))).toBe('c'.repeat(255));
      expect(svc.findWorkflow('Standard Deploy', '1.0.0')?.filePath).toBe(filePath);
    }
  });

  it.each([
    [200, false],
    [201, true],
  ])('treats a %i-character name slug as over the limit: %s', async (length, over) => {
    const result = await runToolContract(workflowCreate, {
      ...VALID_INPUT,
      name: 'n'.repeat(length),
    });

    expect(Boolean(result.isError)).toBe(over);
    if (over) {
      const { error } = result.structuredContent as ErrorEnvelope;
      expect(error.data.reason).toBe('invalid_input');
      expect(error.message).toContain('at most 200 characters');
      expect(error.data.recovery?.hint).toContain('at most 200 characters');
    }
  });

  // --- write_failed never names an absolute path (GH #31) ---

  describe('write_failed under a workflows root whose path contains a quote', () => {
    let root: string;
    let quotedSvc: WorkflowIndexService;

    beforeEach(async () => {
      root = path.join(dir, "Casey's workflows");
      quotedSvc = new WorkflowIndexService(root, path.join(root, 'global_instructions.md'), 10);
      await quotedSvc.init();
      vi.mocked(getWorkflowIndexService).mockReturnValue(quotedSvc);
    });

    afterEach(async () => {
      quotedSvc.shutdown();
      await fs.chmod(path.join(root, 'categories', 'deployment'), 0o755).catch(() => undefined);
    });

    it('strips the path from a failed mkdir (GH #31)', async () => {
      await fs.mkdir(path.join(root, 'categories'), { recursive: true });
      // A regular file where the category directory belongs makes the mkdir fail.
      await fs.writeFile(path.join(root, 'categories', 'deployment'), 'not a directory', 'utf-8');

      const result = await runToolContract(workflowCreate, VALID_INPUT);

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as ErrorEnvelope;
      expect(error.code).toBe(JsonRpcErrorCode.InternalError);
      expect(error.data.reason).toBe('write_failed');
      expect(error.message).toMatch(/^Failed to write workflow: E[A-Z]+: [^',]+$/);
      const text = (result.content[0] as { text: string }).text;
      for (const surface of [error.message, text]) {
        expect(surface).not.toContain(root);
        expect(surface).not.toContain('workflows/');
        expect(surface).not.toContain('mkdir');
      }
    });

    it('strips the path from a failed open (GH #31)', async () => {
      const categoryDir = path.join(root, 'categories', 'deployment');
      await fs.mkdir(categoryDir, { recursive: true });
      await fs.chmod(categoryDir, 0o555);

      const result = await runToolContract(workflowCreate, VALID_INPUT);

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as ErrorEnvelope;
      expect(error.data.reason).toBe('write_failed');
      expect(error.message).toBe('Failed to write workflow: EACCES: permission denied');
      expect((result.content[0] as { text: string }).text).not.toContain('workflows/');
    });
  });

  // --- format ---

  it('formats output with key and file path', () => {
    const output = {
      status: 'created' as const,
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
