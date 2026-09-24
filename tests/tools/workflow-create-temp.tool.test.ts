/**
 * @fileoverview Tests for workflow_create_temp tool.
 * @module tests/tools/workflow-create-temp.tool.test
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

import { workflowCreateTemp } from '@/mcp-server/tools/definitions/workflow-create-temp.tool.js';
import {
  getWorkflowIndexService,
  slugify,
  WorkflowIndexService,
} from '@/services/workflow-index/workflow-index-service.js';

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wf-create-temp-test-'));
}

/** Readable slugs plus the first 8 hex characters of SHA-256 over the stored `name@version`. */
function fileNameFor(name: string, version: string, nameSlug = slugify(name)): string {
  const hash = createHash('sha256').update(`${name}@${version}`).digest('hex').slice(0, 8);
  return `${nameSlug}-${slugify(version)}-${hash}-workflow.yaml`;
}

const TEMP_NOTICE =
  'This workflow is a temporary draft — excluded from workflow_list, retrievable with workflow_get, and kept until deleted with workflow_delete.';

type Success = {
  status: string;
  key: string;
  filePath: string;
  created_date: string;
  last_updated_date: string;
  notice: string;
};

type ErrorEnvelope = {
  error: { code: number; message: string; data: { reason: string } };
};

/** Every text block of a tool result, joined. */
function allText(content: unknown[]): string {
  return content.map((block) => (block as { text?: string }).text ?? '').join('\n');
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
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
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

  it('overwrites the draft on a second write of the same name@version and reports it (GH #20)', async () => {
    const ctx1 = createMockContext({ errors: workflowCreateTemp.errors });
    const input = workflowCreateTemp.input.parse(VALID_INPUT);
    const result1 = await workflowCreateTemp.handler(input, ctx1);

    const ctx2 = createMockContext({ errors: workflowCreateTemp.errors });
    const result2 = await workflowCreateTemp.handler(input, ctx2);

    // Both writes resolve to the same path (second overwrites)
    expect(result1.key).toBe(result2.key);
    expect(result2.filePath).toBe(result1.filePath);
    expect(result1.status).toBe('created');
    expect(result2.status).toBe('overwritten');
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

  // GH #9 — full semver validation rejects suffixed versions like "1.0.0junk".
  it('rejects an invalid semver version at input validation (GH #9)', () => {
    const parsed = workflowCreateTemp.input.safeParse({ ...VALID_INPUT, version: '1.0.0junk' });
    expect(parsed.success).toBe(false);
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

  // --- canonical version (GH #26) ---

  it.each([
    ['v1.0.0', '1.0.0'],
    ['1.0.0+build.5', '1.0.0'],
  ])(
    'persists the tolerated spelling %j as the canonical version (GH #26)',
    async (version, canonical) => {
      const result = await runToolContract(workflowCreateTemp, { ...VALID_INPUT, version });
      expect(result.isError).toBeFalsy();

      const key = `Quick Research Plan@${canonical}`;
      const structured = result.structuredContent as { key: string; filePath: string };
      expect(structured.key).toBe(key);
      expect((result.content[0] as { text: string }).text).toContain(`**Key:** ${key}`);

      const written = parseYaml(await fs.readFile(structured.filePath, 'utf-8')) as {
        version: string;
      };
      expect(written.version).toBe(canonical);
      expect(path.basename(structured.filePath)).toBe(
        fileNameFor('Quick Research Plan', canonical),
      );
      expect([...svc.index.keys()]).toEqual([key]);
      expect(svc.findWorkflow('Quick Research Plan', canonical)?.isTemp).toBe(true);
    },
  );

  it('overwrites the same draft when a tolerated spelling canonicalizes to it (GH #26)', async () => {
    const ctx = createMockContext({ errors: workflowCreateTemp.errors });
    const first = await workflowCreateTemp.handler(
      workflowCreateTemp.input.parse(VALID_INPUT),
      ctx,
    );
    const second = await workflowCreateTemp.handler(
      workflowCreateTemp.input.parse({ ...VALID_INPUT, version: 'v1.0.0' }),
      ctx,
    );

    expect(second.key).toBe(first.key);
    expect(second.filePath).toBe(first.filePath);
    expect(svc.findByName('Quick Research Plan')).toHaveLength(1);
  });

  // --- blank required text (GH #22) ---

  it.each([
    ['name', { name: '   ' }],
    ['description', { description: '   ' }],
    ['author', { author: ' \n ' }],
    ['steps.0.server', { steps: [{ server: '   ', tool: 'search_articles' }] }],
    [
      'steps.1.tool',
      {
        steps: [
          { server: 'pubmed-server', tool: 'search_articles' },
          { server: 'pubmed-server', tool: '   ' },
        ],
      },
    ],
  ])(
    'rejects a whitespace-only %s as invalid_input and writes nothing (GH #22)',
    async (field, override) => {
      const result = await runToolContract(workflowCreateTemp, { ...VALID_INPUT, ...override });

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as ErrorEnvelope;
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data.reason).toBe('invalid_input');
      expect(error.message).toContain(field);
      expect((result.content[0] as { text: string }).text).toContain(field);

      expect(svc.index.size).toBe(0);
      await expect(fs.stat(path.join(dir, 'temp'))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  // --- created vs overwritten, temporary notice in enrichment (GH #20) ---

  it('reports created then overwritten on both surfaces, with the temporary notice once (GH #20)', async () => {
    const first = await runToolContract(workflowCreateTemp, VALID_INPUT);
    const second = await runToolContract(workflowCreateTemp, {
      ...VALID_INPUT,
      description: 'Revised plan.',
    });

    for (const [result, status] of [
      [first, 'created'],
      [second, 'overwritten'],
    ] as const) {
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as Success;
      expect(structured.status).toBe(status);
      expect(structured.notice).toBe(TEMP_NOTICE);
      expect(structured.key).toBe('Quick Research Plan@1.0.0');
      expect(structured.filePath).toContain(path.join(dir, 'temp'));
      expect(structured.created_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(structured.last_updated_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      const text = allText(result.content);
      expect(text).toContain(`**Status:** ${status}`);
      expect(text.split(TEMP_NOTICE)).toHaveLength(2);
    }
    expect((second.structuredContent as Success).filePath).toBe(
      (first.structuredContent as Success).filePath,
    );
    expect(await fs.readdir(path.join(dir, 'temp'))).toHaveLength(1);
  });

  it('keeps the replaced draft’s created_date and file when overwriting an older-named draft (GH #20, #21)', async () => {
    const tempDir = path.join(dir, 'temp');
    await fs.mkdir(tempDir, { recursive: true });
    const legacyPath = path.join(tempDir, 'quick-research-plan-1-0-0-workflow.yaml');
    await fs.writeFile(
      legacyPath,
      JSON.stringify({
        name: 'Quick Research Plan',
        version: '1.0.0',
        description: 'Original plan.',
        author: 'agent',
        temporary: true,
        created_date: '2020-01-01',
        last_updated_date: '2020-01-01',
        steps: [{ server: 'pubmed-server', tool: 'search_articles' }],
      }),
      'utf-8',
    );
    svc.shutdown();
    svc = new WorkflowIndexService(dir, path.join(dir, 'global_instructions.md'), 10);
    await svc.init();
    vi.mocked(getWorkflowIndexService).mockReturnValue(svc);

    const result = await runToolContract(workflowCreateTemp, VALID_INPUT);

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Success;
    const today = new Date().toISOString().slice(0, 10);
    expect(structured).toMatchObject({
      status: 'overwritten',
      filePath: legacyPath,
      created_date: '2020-01-01',
      last_updated_date: today,
    });
    expect(allText(result.content)).toContain('**Created:** 2020-01-01');
    expect(await fs.readdir(tempDir)).toEqual(['quick-research-plan-1-0-0-workflow.yaml']);
    const written = parseYaml(await fs.readFile(legacyPath, 'utf-8')) as {
      created_date: string;
      last_updated_date: string;
      description: string;
    };
    expect(written).toMatchObject({
      created_date: '2020-01-01',
      last_updated_date: today,
      description: VALID_INPUT.description,
    });
  });

  // --- one index entry per key across sources (GH #19) ---

  it('rejects a key a permanent workflow holds with already_exists and writes nothing (GH #19)', async () => {
    const permanentPath = await svc.writePermanent({
      name: 'Quick Research Plan',
      version: '1.0.0',
      description: 'The permanent plan.',
      author: 'agent',
      category: 'research',
      steps: [{ server: 'pubmed-server', tool: 'search_articles' }],
    });

    const result = await runToolContract(workflowCreateTemp, VALID_INPUT);

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as ErrorEnvelope;
    expect(error.code).toBe(JsonRpcErrorCode.Conflict);
    expect(error.data.reason).toBe('already_exists');
    expect(error.message).toContain('Quick Research Plan@1.0.0');
    expect((result.content[0] as { text: string }).text).toContain('already exists');

    expect(await fs.readdir(path.join(dir, 'temp')).catch(() => [])).toEqual([]);
    expect(svc.findWorkflow('Quick Research Plan', '1.0.0')).toMatchObject({
      isTemp: false,
      filePath: permanentPath,
    });
  });

  // --- non-ASCII names (GH #29) ---

  it('creates a draft whose name has no ASCII letters or digits (GH #29)', async () => {
    const result = await runToolContract(workflowCreateTemp, {
      ...VALID_INPUT,
      name: '日本語ワークフロー',
    });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as Success;
    expect(structured.key).toBe('日本語ワークフロー@1.0.0');
    expect(path.basename(structured.filePath)).toBe(
      fileNameFor('日本語ワークフロー', '1.0.0', 'workflow'),
    );
    expect(svc.findWorkflow('日本語ワークフロー')?.isTemp).toBe(true);
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
      await fs.chmod(path.join(root, 'temp'), 0o755).catch(() => undefined);
    });

    it('strips the path from a failed mkdir (GH #31)', async () => {
      // A regular file where temp/ belongs makes the mkdir fail.
      await fs.writeFile(path.join(root, 'temp'), 'not a directory', 'utf-8');

      const result = await runToolContract(workflowCreateTemp, VALID_INPUT);

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as ErrorEnvelope;
      expect(error.code).toBe(JsonRpcErrorCode.InternalError);
      expect(error.data.reason).toBe('write_failed');
      expect(error.message).toMatch(/^Failed to write temp workflow: E[A-Z]+: [^',]+$/);
      const text = allText(result.content);
      for (const surface of [error.message, text]) {
        expect(surface).not.toContain(root);
        expect(surface).not.toContain('workflows/');
        expect(surface).not.toContain('mkdir');
      }
    });

    it('strips the path from a failed open (GH #31)', async () => {
      await fs.mkdir(path.join(root, 'temp'), { recursive: true });
      await fs.chmod(path.join(root, 'temp'), 0o555);

      const result = await runToolContract(workflowCreateTemp, VALID_INPUT);

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as ErrorEnvelope;
      expect(error.data.reason).toBe('write_failed');
      expect(error.message).toBe('Failed to write temp workflow: EACCES: permission denied');
      expect(allText(result.content)).not.toContain('workflows/');
    });
  });

  // --- name slug bound ---

  it.each([
    [200, false],
    [201, true],
  ])('treats a %i-character name slug as over the limit: %s', async (length, over) => {
    const result = await runToolContract(workflowCreateTemp, {
      ...VALID_INPUT,
      name: 'n'.repeat(length),
    });

    expect(Boolean(result.isError)).toBe(over);
    if (over) {
      const { error } = result.structuredContent as ErrorEnvelope & {
        error: { data: { recovery?: { hint: string } } };
      };
      expect(error.data.reason).toBe('invalid_input');
      expect(error.message).toContain('at most 200 characters');
      expect(error.data.recovery?.hint).toContain('at most 200 characters');
    }
  });

  // --- format ---

  it('formats output with key, file path, and status, leaving the temp note to enrichment (GH #20)', () => {
    const output = {
      status: 'created' as const,
      filePath: '/tmp/workflows/temp/quick-research-plan-1-0-0-workflow.yaml',
      key: 'Quick Research Plan@1.0.0',
      created_date: '2026-05-28',
      last_updated_date: '2026-05-28',
    };
    const blocks = workflowCreateTemp.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Quick Research Plan@1.0.0');
    expect(text).toContain('/tmp/workflows/temp/');
    expect(text).toContain('**Status:** created');
    expect(text).not.toContain(TEMP_NOTICE);

    const overwritten = workflowCreateTemp.format!({ ...output, status: 'overwritten' });
    expect((overwritten[0] as { text: string }).text).toContain('**Status:** overwritten');
  });
});
