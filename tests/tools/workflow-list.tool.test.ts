/**
 * @fileoverview Tests for workflow_list tool.
 * @module tests/tools/workflow-list.tool.test
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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

  await fs.writeFile(path.join(catDir, `${name}.yaml`), `${lines.join('\n')}\n`, 'utf-8');
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
    await fs.rm(dir, { recursive: true, force: true });
  });

  // --- happy paths ---

  it('returns all permanent workflows when no filters are applied', () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    const input = workflowList.input.parse({});
    const result = workflowList.handler(input, ctx);
    expect(result.totalCount).toBe(3);
    expect(result.workflows).toHaveLength(3);
    // Temp workflow is excluded
    expect(result.workflows.every((w) => w.name !== 'temp-plan')).toBe(true);
  });

  it('filters by category (case-insensitive substring)', () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    const input = workflowList.input.parse({ category: 'git' });
    const result = workflowList.handler(input, ctx);
    expect(result.totalCount).toBe(2);
    expect(result.workflows.every((w) => w.category?.toLowerCase().includes('git'))).toBe(true);
  });

  it('filters by tags (AND match)', () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    const input = workflowList.input.parse({ tags: ['git', 'daily'] });
    const result = workflowList.handler(input, ctx);
    expect(result.totalCount).toBe(1);
    expect(result.workflows[0].name).toBe('git-wrap-up');
  });

  it('returns empty array when no workflows match filters', () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    const input = workflowList.input.parse({ tags: ['nonexistent-tag'] });
    const result = workflowList.handler(input, ctx);
    expect(result.totalCount).toBe(0);
    expect(result.workflows).toHaveLength(0);
  });

  it('tag filtering is case-insensitive (regression: fix #4)', () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    // Stored tags are lowercase "git" — filter with uppercase "GIT" should still match
    const inputUpper = workflowList.input.parse({ tags: ['GIT'] });
    const resultUpper = workflowList.handler(inputUpper, ctx);
    expect(resultUpper.totalCount).toBe(2);

    const inputMixed = workflowList.input.parse({ tags: ['Git', 'Daily'] });
    const resultMixed = workflowList.handler(inputMixed, ctx);
    expect(resultMixed.totalCount).toBe(1);
    expect(resultMixed.workflows[0].name).toBe('git-wrap-up');
  });

  it('includes tools list when includeTools is true', () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    const input = workflowList.input.parse({ category: 'git', includeTools: true });
    const result = workflowList.handler(input, ctx);
    for (const wf of result.workflows) {
      expect(Array.isArray(wf.tools)).toBe(true);
      expect(wf.tools!.every((t) => t.includes('/'))).toBe(true);
    }
  });

  it('does not include tools list when includeTools is false', () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    const input = workflowList.input.parse({ includeTools: false });
    const result = workflowList.handler(input, ctx);
    expect(result.workflows.every((w) => w.tools === undefined)).toBe(true);
  });

  it('ignores blank category string (whitespace only)', () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    const input = workflowList.input.parse({ category: '   ' });
    const result = workflowList.handler(input, ctx);
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

  it('returns workflow when tag filter uses an empty tags array (no filter applied)', () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    // tags: [] means no tag filter — all permanent workflows should return
    const input = workflowList.input.parse({ tags: [] });
    const result = workflowList.handler(input, ctx);
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
    const result = workflowList.handler(input, ctx);
    expect(result.workflows).toHaveLength(1);
    const tools = result.workflows[0].tools!;
    // Should deduplicate: only 2 unique server/tool pairs, not 3
    expect(tools).toHaveLength(2);
    expect(tools).toContain('search-server/search_articles');
    expect(tools).toContain('notify-server/send_alert');
  });

  // --- format ---

  it('formats output with workflow names and authors', () => {
    const ctx = createMockContext({ errors: workflowList.errors });
    const input = workflowList.input.parse({});
    const result = workflowList.handler(input, ctx);
    const blocks = workflowList.format!(result);
    expect(blocks[0].type).toBe('text');
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('git-wrap-up');
    expect(text).toContain('test-author');
  });

  it('formats empty result message', () => {
    const blocks = workflowList.format!({ workflows: [], totalCount: 0 });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No workflows found');
  });
});
