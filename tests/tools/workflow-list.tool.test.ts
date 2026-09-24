/**
 * @fileoverview Tests for workflow_list tool.
 * @module tests/tools/workflow-list.tool.test
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the service module before importing the tool
vi.mock('@/services/workflow-index/workflow-index-service.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/services/workflow-index/workflow-index-service.js')>();
  return {
    ...actual,
    getWorkflowIndexService: vi.fn(),
  };
});

import { workflowList } from '@/mcp-server/tools/definitions/workflow-list.tool.js';
import {
  getWorkflowIndexService,
  WorkflowIndexService,
} from '@/services/workflow-index/workflow-index-service.js';

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wf-list-test-'));
}

async function writeWorkflow(
  dir: string,
  subDir: string,
  name: string,
  version: string,
  category: string,
  tags?: string[],
  fileName = name,
): Promise<void> {
  const catDir = path.join(dir, 'categories', subDir);
  await fs.mkdir(catDir, { recursive: true });

  const lines: string[] = [
    `name: ${name}`,
    `version: "${version}"`,
    `description: Description for ${name}`,
    `author: test-author`,
    `category: ${category}`,
  ];
  if (tags && tags.length > 0) {
    lines.push('tags:');
    for (const t of tags) lines.push(`  - ${t}`);
  }
  lines.push('steps:');
  lines.push('  - server: test-server');
  lines.push('    tool: test_tool');

  await fs.writeFile(path.join(catDir, `${fileName}.yaml`), `${lines.join('\n')}\n`, 'utf-8');
}

/** Rebuild the index after writing extra fixtures, then point the tool at it. */
async function reindex(svc: WorkflowIndexService): Promise<void> {
  await svc.init();
  vi.mocked(getWorkflowIndexService).mockReturnValue(svc);
}

/** `## <name> v<version>` headings from the format() text, in render order. */
function renderedHeadings(text: string): string[] {
  return [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]!);
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('workflowList', () => {
  let dir: string;
  let svc: WorkflowIndexService;

  beforeEach(async () => {
    dir = await mkTmpDir();

    // Populate fixture data
    await writeWorkflow(dir, 'git', 'git-wrap-up', '1.0.0', 'Git', ['git', 'daily']);
    await writeWorkflow(dir, 'git', 'git-branch', '1.0.0', 'Git', ['git']);
    await writeWorkflow(dir, 'research', 'search-pubmed', '1.0.0', 'Research', ['research']);
    // Temp workflow — should NOT appear in list
    const tempDir = path.join(dir, 'temp');
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'temp-plan.yaml'),
      'name: temp-plan\nversion: "1.0.0"\ndescription: temp\nauthor: bot\ntemporary: true\nsteps:\n  - server: s\n    tool: t\n',
      'utf-8',
    );

    svc = new WorkflowIndexService(dir, path.join(dir, 'global_instructions.md'), 10);
    await svc.init();
    vi.mocked(getWorkflowIndexService).mockReturnValue(svc);
  });

  afterEach(async () => {
    svc.shutdown();
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  // --- happy paths ---

  it('returns all permanent workflows when no filters are applied', async () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    const input = workflowList.input.parse({});
    const result = await workflowList.handler(input, ctx);
    expect(result.totalCount).toBe(3);
    expect(result.workflows).toHaveLength(3);
    // Temp workflow is excluded
    expect(result.workflows.every((w) => w.name !== 'temp-plan')).toBe(true);
  });

  it('filters by category (case-insensitive substring)', async () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    const input = workflowList.input.parse({ category: 'git' });
    const result = await workflowList.handler(input, ctx);
    expect(result.totalCount).toBe(2);
    expect(result.workflows.every((w) => w.category?.toLowerCase().includes('git'))).toBe(true);
  });

  it('filters by tags (AND match)', async () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    const input = workflowList.input.parse({ tags: ['git', 'daily'] });
    const result = await workflowList.handler(input, ctx);
    expect(result.totalCount).toBe(1);
    expect(result.workflows[0]!.name).toBe('git-wrap-up');
  });

  it('returns empty array when no workflows match filters', async () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    const input = workflowList.input.parse({ tags: ['nonexistent-tag'] });
    const result = await workflowList.handler(input, ctx);
    expect(result.totalCount).toBe(0);
    expect(result.workflows).toHaveLength(0);
  });

  it('tag filtering is case-insensitive (regression: fix #4)', async () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    // Stored tags are lowercase "git" — filter with uppercase "GIT" should still match
    const inputUpper = workflowList.input.parse({ tags: ['GIT'] });
    const resultUpper = await workflowList.handler(inputUpper, ctx);
    expect(resultUpper.totalCount).toBe(2);

    const inputMixed = workflowList.input.parse({ tags: ['Git', 'Daily'] });
    const resultMixed = await workflowList.handler(inputMixed, ctx);
    expect(resultMixed.totalCount).toBe(1);
    expect(resultMixed.workflows[0]!.name).toBe('git-wrap-up');
  });

  it('includes tools list when includeTools is true', async () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    const input = workflowList.input.parse({ category: 'git', includeTools: true });
    const result = await workflowList.handler(input, ctx);
    for (const wf of result.workflows) {
      expect(Array.isArray(wf.tools)).toBe(true);
      expect(wf.tools!.every((t) => t.includes('/'))).toBe(true);
    }
  });

  it('does not include tools list when includeTools is false', async () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    const input = workflowList.input.parse({ includeTools: false });
    const result = await workflowList.handler(input, ctx);
    expect(result.workflows.every((w) => w.tools === undefined)).toBe(true);
  });

  it('ignores blank category string (whitespace only)', async () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    const input = workflowList.input.parse({ category: '   ' });
    const result = await workflowList.handler(input, ctx);
    // Blank category is treated as "no filter" — returns all permanent
    expect(result.totalCount).toBe(3);
  });

  it('throws index_unavailable when service is not ready', () => {
    // Mark service as not ready
    Object.defineProperty(svc, '_ready', { value: false, writable: true });
    const ctx = createMockContext({ errors: workflowList.errors });
    const input = workflowList.input.parse({});
    expect(() => workflowList.handler(input, ctx)).toThrow();
  });

  it('returns workflow when tag filter uses an empty tags array (no filter applied)', async () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    // tags: [] means no tag filter — all permanent workflows should return
    const input = workflowList.input.parse({ tags: [] });
    const result = await workflowList.handler(input, ctx);
    expect(result.totalCount).toBe(3);
  });

  it('deduplicates tools when a step server/tool pair appears more than once', async () => {
    // Write a workflow with two steps pointing to the same server/tool
    const catDir = path.join(dir, 'categories', 'dedup-test');
    await fs.mkdir(catDir, { recursive: true });
    await fs.writeFile(
      path.join(catDir, 'dup-tools.yaml'),
      `${[
        'name: dup-tools-wf',
        'version: "1.0.0"',
        'description: Workflow with duplicate tool steps',
        'author: tester',
        'category: Dedup Test',
        'steps:',
        '  - server: search-server',
        '    tool: search_articles',
        '  - server: search-server',
        '    tool: search_articles',
        '  - server: notify-server',
        '    tool: send_alert',
      ].join('\n')}\n`,
      'utf-8',
    );
    // Rebuild the service with the new file
    await svc.init();
    vi.mocked(getWorkflowIndexService).mockReturnValue(svc);

    const ctx = createMockContext({ errors: workflowList.errors });
    const input = workflowList.input.parse({ category: 'Dedup Test', includeTools: true });
    const result = await workflowList.handler(input, ctx);
    expect(result.workflows).toHaveLength(1);
    const tools = result.workflows[0]!.tools!;
    // Should deduplicate: only 2 unique server/tool pairs, not 3
    expect(tools).toHaveLength(2);
    expect(tools).toContain('search-server/search_articles');
    expect(tools).toContain('notify-server/send_alert');
  });

  // --- query filter (fix #4) ---

  it('filters by query matching the workflow name', async () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    const input = workflowList.input.parse({ query: 'pubmed' });
    const result = await workflowList.handler(input, ctx);
    expect(result.totalCount).toBe(1);
    expect(result.workflows[0]!.name).toBe('search-pubmed');
  });

  it('filters by query matching the description but not the name', async () => {
    // A workflow whose distinctive token lives only in the description, not the name.
    const catDir = path.join(dir, 'categories', 'ops');
    await fs.mkdir(catDir, { recursive: true });
    await fs.writeFile(
      path.join(catDir, 'housekeeping.yaml'),
      `${[
        'name: housekeeping',
        'version: "1.0.0"',
        'description: Rotate the nightly backups and prune old logs',
        'author: ops',
        'category: Ops',
        'steps:',
        '  - server: s',
        '    tool: t',
      ].join('\n')}\n`,
      'utf-8',
    );
    await svc.init();
    vi.mocked(getWorkflowIndexService).mockReturnValue(svc);

    const ctx = createMockContext({ errors: workflowList.errors });
    const input = workflowList.input.parse({ query: 'nightly' });
    const result = await workflowList.handler(input, ctx);
    expect(result.totalCount).toBe(1);
    expect(result.workflows[0]!.name).toBe('housekeeping');
  });

  it('query matching is case-insensitive', async () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    const input = workflowList.input.parse({ query: 'PUBMED' });
    const result = await workflowList.handler(input, ctx);
    expect(result.totalCount).toBe(1);
    expect(result.workflows[0]!.name).toBe('search-pubmed');
  });

  it('combines query with the category filter (AND)', async () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    // 'branch' matches git-branch by name; category 'Git' keeps it — search-pubmed is excluded.
    const input = workflowList.input.parse({ query: 'branch', category: 'Git' });
    const result = await workflowList.handler(input, ctx);
    expect(result.totalCount).toBe(1);
    expect(result.workflows[0]!.name).toBe('git-branch');
  });

  it('combines query with the tags filter (AND)', async () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    // Both git-* names match 'git', but only git-wrap-up carries the 'daily' tag.
    const input = workflowList.input.parse({ query: 'git', tags: ['daily'] });
    const result = await workflowList.handler(input, ctx);
    expect(result.totalCount).toBe(1);
    expect(result.workflows[0]!.name).toBe('git-wrap-up');
  });

  it('treats an empty or whitespace-only query as no filter', async () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    expect(
      (await workflowList.handler(workflowList.input.parse({ query: '' }), ctx)).totalCount,
    ).toBe(3);
    expect(
      (await workflowList.handler(workflowList.input.parse({ query: '   ' }), ctx)).totalCount,
    ).toBe(3);
  });

  // --- format ---

  it('formats output with workflow names and authors', async () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    const input = workflowList.input.parse({});
    const result = await workflowList.handler(input, ctx);
    const blocks = workflowList.format!(result);
    expect(blocks[0]!.type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('git-wrap-up');
    expect(text).toContain('test-author');
  });

  it('formats empty result with the total count', () => {
    const blocks = workflowList.format!({ workflows: [], totalCount: 0 });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Total workflows:** 0');
  });

  // --- empty-result enrichment (fix #13) ---

  it('emits an empty-result notice echoing the applied filters', async () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    const input = workflowList.input.parse({ query: 'zzz-nomatch', tags: ['nonexistent-tag'] });
    const result = await workflowList.handler(input, ctx);
    expect(result.totalCount).toBe(0);

    const enrichment = getEnrichment(ctx) as { notice?: string };
    expect(enrichment.notice).toBeDefined();
    expect(enrichment.notice).toContain('zzz-nomatch');
    expect(enrichment.notice).toContain('nonexistent-tag');
  });

  it('does not emit an empty-result notice when workflows match', async () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    const result = await workflowList.handler(workflowList.input.parse({}), ctx);
    expect(result.totalCount).toBe(3);
    expect((getEnrichment(ctx) as { notice?: string }).notice).toBeUndefined();
  });

  // --- padded filter values (GH #15) ---

  it('trims a padded query before matching (GH #15)', async () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    const result = await workflowList.handler(workflowList.input.parse({ query: ' pubmed ' }), ctx);
    expect(result.totalCount).toBe(1);
    expect(result.workflows[0]!.name).toBe('search-pubmed');
  });

  it('trims a padded category before matching (GH #15)', async () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    const result = await workflowList.handler(
      workflowList.input.parse({ category: '  Git  ' }),
      ctx,
    );
    expect(result.totalCount).toBe(2);
    expect(result.workflows.map((w) => w.name)).toEqual(['git-branch', 'git-wrap-up']);
  });

  it('trims each padded tag before the case-insensitive AND match (GH #15)', async () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    const single = await workflowList.handler(workflowList.input.parse({ tags: [' git '] }), ctx);
    expect(single.totalCount).toBe(2);

    const both = await workflowList.handler(
      workflowList.input.parse({ tags: [' GIT', 'Daily  '] }),
      ctx,
    );
    expect(both.totalCount).toBe(1);
    expect(both.workflows[0]!.name).toBe('git-wrap-up');
  });

  it('keeps a whitespace-only tag as an AND term that matches nothing (GH #15)', async () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    const mixed = await workflowList.handler(
      workflowList.input.parse({ tags: ['git', '   '] }),
      ctx,
    );
    expect(mixed.totalCount).toBe(0);

    const blankOnly = await workflowList.handler(workflowList.input.parse({ tags: [' '] }), ctx);
    expect(blankOnly.totalCount).toBe(0);
  });

  it('echoes the trimmed filter values in the empty-result notice (GH #15)', async () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    const result = await workflowList.handler(
      workflowList.input.parse({
        query: '  zzz-nomatch  ',
        category: '  Nowhere ',
        tags: ['  nonexistent-tag  '],
      }),
      ctx,
    );
    expect(result.totalCount).toBe(0);

    const { notice } = getEnrichment(ctx) as { notice?: string };
    expect(notice).toContain('query "zzz-nomatch"');
    expect(notice).toContain('category "Nowhere"');
    expect(notice).toContain('"nonexistent-tag"');
    expect(notice).not.toContain(' nonexistent-tag ');
  });

  // --- version ordering (GH #28) ---

  it('sorts by name, then plain x.y.z versions numerically descending, on both surfaces', async () => {
    await writeWorkflow(dir, 'probe', 'sort-probe', '1.2.0', 'Probe', undefined, 'a');
    await writeWorkflow(dir, 'probe', 'sort-probe', '10.0.0', 'Probe', undefined, 'b');
    await writeWorkflow(dir, 'probe', 'sort-probe', '2.0.0', 'Probe', undefined, 'c');
    await reindex(svc);

    const result = await runToolContract(workflowList, {});
    const structured = result.structuredContent as {
      workflows: { name: string; version: string }[];
    };
    const expected = [
      'git-branch v1.0.0',
      'git-wrap-up v1.0.0',
      'search-pubmed v1.0.0',
      'sort-probe v10.0.0',
      'sort-probe v2.0.0',
      'sort-probe v1.2.0',
    ];
    expect(structured.workflows.map((w) => `${w.name} v${w.version}`)).toEqual(expected);
    expect(renderedHeadings((result.content[0] as { text: string }).text)).toEqual(expected);
  });

  it('orders a release before its prereleases, and prereleases by precedence (GH #28)', async () => {
    await writeWorkflow(dir, 'probe', 'prerelease-probe', '1.0.0-alpha', 'Probe', undefined, 'a');
    await writeWorkflow(dir, 'probe', 'prerelease-probe', '1.0.0-alpha.1', 'Probe', undefined, 'b');
    await writeWorkflow(dir, 'probe', 'prerelease-probe', '1.0.0-beta', 'Probe', undefined, 'c');
    await writeWorkflow(dir, 'probe', 'prerelease-probe', '1.0.0', 'Probe', undefined, 'd');
    await writeWorkflow(dir, 'probe', 'prerelease-probe', '0.9.0', 'Probe', undefined, 'e');
    await reindex(svc);

    /**
     * The index iterates in readdir order, which differs between filesystems. Re-insert the probe
     * entries in fixed orders — ascending precedence (the exact reverse of the expected result) and
     * an interleaving — so the result matches only when the tool itself sorts.
     */
    for (const insertion of [
      ['0.9.0', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta', '1.0.0'],
      ['1.0.0-alpha.1', '0.9.0', '1.0.0', '1.0.0-alpha', '1.0.0-beta'],
    ]) {
      const keys = insertion.map((v) => `prerelease-probe@${v}`);
      for (const key of keys) {
        const entry = svc.index.get(key);
        if (!entry) throw new Error(`fixture ${key} is not indexed`);
        svc.index.delete(key);
        svc.index.set(key, entry);
      }
      expect([...svc.index.keys()].filter((k) => k.startsWith('prerelease-probe@'))).toEqual(keys);

      const result = await runToolContract(workflowList, { query: 'prerelease-probe' });
      const structured = result.structuredContent as { workflows: { version: string }[] };
      const expected = ['1.0.0', '1.0.0-beta', '1.0.0-alpha.1', '1.0.0-alpha', '0.9.0'];
      expect(structured.workflows.map((w) => w.version)).toEqual(expected);
      expect(renderedHeadings((result.content[0] as { text: string }).text)).toEqual(
        expected.map((v) => `prerelease-probe v${v}`),
      );
    }
  });
});
