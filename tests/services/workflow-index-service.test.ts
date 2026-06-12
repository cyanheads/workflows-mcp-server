/**
 * @fileoverview Tests for WorkflowIndexService — index build, lookup, write, and snapshot.
 * @module tests/services/workflow-index-service.test
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { slugify, WorkflowIndexService } from '@/services/workflow-index/workflow-index-service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorkflowYaml(overrides: Record<string, unknown> = {}): string {
  const base = {
    name: 'test-workflow',
    version: '1.0.0',
    description: 'A test workflow',
    author: 'tester',
    category: 'testing',
    steps: [{ server: 'my-server', tool: 'my_tool' }],
    ...overrides,
  };

  const lines: string[] = [];
  lines.push(`name: ${base.name}`);
  lines.push(`version: "${base.version}"`);
  lines.push(`description: ${base.description}`);
  lines.push(`author: ${base.author}`);
  if (base.category) lines.push(`category: ${base.category}`);
  if (base.temporary) lines.push('temporary: true');
  if (Array.isArray(base.tags)) {
    lines.push('tags:');
    for (const t of base.tags as string[]) lines.push(`  - ${t}`);
  }
  lines.push('steps:');
  for (const step of base.steps as Array<{ server: string; tool: string }>) {
    lines.push(`  - server: ${step.server}`);
    lines.push(`    tool: ${step.tool}`);
  }
  return `${lines.join('\n')}\n`;
}

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'workflows-test-'));
}

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe('slugify', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(slugify('Git Operations')).toBe('git-operations');
  });

  it('replaces underscores with hyphens', () => {
    expect(slugify('web_operations')).toBe('web-operations');
  });

  it('collapses multiple separators', () => {
    expect(slugify('a  b--c')).toBe('a-b-c');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('-hello-world-')).toBe('hello-world');
  });

  it('preserves clean kebab-case', () => {
    expect(slugify('project-chimera')).toBe('project-chimera');
  });

  it('handles all-non-alphanumeric input by returning empty string', () => {
    // A string with only special chars collapses to nothing after stripping
    expect(slugify('---')).toBe('');
  });

  it('slugifies category with special chars (& and spaces)', () => {
    expect(slugify('Git & GitHub Operations')).toBe('git-github-operations');
  });

  it('handles leading/trailing whitespace', () => {
    expect(slugify('  git ops  ')).toBe('git-ops');
  });
});

// ---------------------------------------------------------------------------
// WorkflowIndexService — index build
// ---------------------------------------------------------------------------

describe('WorkflowIndexService', () => {
  let dir: string;
  let svc: WorkflowIndexService;

  beforeEach(async () => {
    dir = await mkTmpDir();
    svc = new WorkflowIndexService(dir, path.join(dir, 'global_instructions.md'), 10);
  });

  afterEach(async () => {
    svc.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  });

  // --- init / build ---

  it('builds index from YAML files in categories/', async () => {
    const catDir = path.join(dir, 'categories', 'testing');
    await fs.mkdir(catDir, { recursive: true });
    await fs.writeFile(path.join(catDir, 'test-workflow.yaml'), makeWorkflowYaml(), 'utf-8');

    await svc.init();

    expect(svc.ready).toBe(true);
    expect(svc.index.size).toBe(1);
    expect(svc.index.has('test-workflow@1.0.0')).toBe(true);
  });

  it('marks files under temp/ as isTemp=true', async () => {
    const tempDir = path.join(dir, 'temp');
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'temp-wf.yaml'),
      makeWorkflowYaml({ name: 'temp-wf', temporary: true }),
      'utf-8',
    );

    await svc.init();

    const entry = svc.index.get('temp-wf@1.0.0');
    expect(entry?.isTemp).toBe(true);
  });

  it('skips invalid YAML files without crashing', async () => {
    const catDir = path.join(dir, 'categories', 'bad');
    await fs.mkdir(catDir, { recursive: true });
    await fs.writeFile(path.join(catDir, 'bad.yaml'), 'not: valid: yaml: [[[', 'utf-8');
    await fs.writeFile(
      path.join(catDir, 'good.yaml'),
      makeWorkflowYaml({ name: 'good-wf' }),
      'utf-8',
    );

    await svc.init();

    expect(svc.ready).toBe(true);
    expect(svc.index.size).toBe(1);
    expect(svc.index.has('good-wf@1.0.0')).toBe(true);
  });

  it('skips files that fail WorkflowSchema validation', async () => {
    const catDir = path.join(dir, 'categories', 'partial');
    await fs.mkdir(catDir, { recursive: true });
    // Missing required `steps` field
    await fs.writeFile(
      path.join(catDir, 'no-steps.yaml'),
      'name: no-steps\nversion: "1.0.0"\ndescription: no steps\nauthor: me\n',
      'utf-8',
    );

    await svc.init();

    expect(svc.index.size).toBe(0);
  });

  it('writes index snapshot to _index.json', async () => {
    const catDir = path.join(dir, 'categories', 'testing');
    await fs.mkdir(catDir, { recursive: true });
    await fs.writeFile(path.join(catDir, 'wf.yaml'), makeWorkflowYaml(), 'utf-8');

    await svc.init();
    // Give snapshot write a moment (it's async fire-and-forget)
    await new Promise((r) => setTimeout(r, 50));

    const snapshot = JSON.parse(await fs.readFile(path.join(dir, '_index.json'), 'utf-8')) as {
      count: number;
      entries: Record<string, unknown>;
    };
    expect(snapshot.count).toBe(1);
    expect(Object.keys(snapshot.entries)).toContain('test-workflow@1.0.0');
  });

  // --- semver lookup ---

  it('returns the highest semver when version is omitted', async () => {
    const catDir = path.join(dir, 'categories', 'testing');
    await fs.mkdir(catDir, { recursive: true });
    await fs.writeFile(
      path.join(catDir, 'wf-v1.yaml'),
      makeWorkflowYaml({ version: '1.0.0' }),
      'utf-8',
    );
    await fs.writeFile(
      path.join(catDir, 'wf-v2.yaml'),
      makeWorkflowYaml({ version: '2.0.0' }),
      'utf-8',
    );

    await svc.init();

    const entry = svc.findWorkflow('test-workflow');
    expect(entry?.workflow.version).toBe('2.0.0');
  });

  it('returns the specific version when requested', async () => {
    const catDir = path.join(dir, 'categories', 'testing');
    await fs.mkdir(catDir, { recursive: true });
    await fs.writeFile(
      path.join(catDir, 'wf-v1.yaml'),
      makeWorkflowYaml({ version: '1.0.0' }),
      'utf-8',
    );
    await fs.writeFile(
      path.join(catDir, 'wf-v2.yaml'),
      makeWorkflowYaml({ version: '2.0.0' }),
      'utf-8',
    );

    await svc.init();

    const entry = svc.findWorkflow('test-workflow', '1.0.0');
    expect(entry?.workflow.version).toBe('1.0.0');
  });

  it('returns undefined for unknown name', async () => {
    await svc.init();
    expect(svc.findWorkflow('nonexistent')).toBeUndefined();
  });

  // --- readGlobalInstructions ---

  it('returns null when global_instructions.md is missing', async () => {
    await svc.init();
    const instructions = await svc.readGlobalInstructions();
    expect(instructions).toBeNull();
  });

  it('returns file contents when global_instructions.md exists', async () => {
    await fs.writeFile(path.join(dir, 'global_instructions.md'), 'Follow these steps.', 'utf-8');
    await svc.init();
    const instructions = await svc.readGlobalInstructions();
    expect(instructions).toBe('Follow these steps.');
  });

  // --- snapshot content ---

  it('snapshot entries include isTemp flag and category for permanent workflows', async () => {
    const catDir = path.join(dir, 'categories', 'testing');
    await fs.mkdir(catDir, { recursive: true });
    await fs.writeFile(
      path.join(catDir, 'wf.yaml'),
      makeWorkflowYaml({ category: 'testing' }),
      'utf-8',
    );

    await svc.init();
    await new Promise((r) => setTimeout(r, 50));

    const snapshot = JSON.parse(await fs.readFile(path.join(dir, '_index.json'), 'utf-8')) as {
      count: number;
      entries: Record<string, { isTemp: boolean; category?: string }>;
    };
    const entry = snapshot.entries['test-workflow@1.0.0'];
    expect(entry).toBeDefined();
    expect(entry.isTemp).toBe(false);
    expect(entry.category).toBe('testing');
  });

  // --- forEach round-trip ---

  it('round-trips forEach field through write and re-index', async () => {
    await svc.init();

    await svc.writePermanent({
      name: 'foreach-wf',
      version: '1.0.0',
      description: 'Workflow with forEach',
      author: 'tester',
      category: 'testing',
      steps: [
        {
          server: 'my-server',
          tool: 'process_item',
          forEach: '{{input.items}}',
        },
      ],
    });

    const entry = svc.index.get('foreach-wf@1.0.0');
    expect(entry?.workflow.steps[0]?.forEach).toBe('{{input.items}}');
  });

  // --- omitted tags ---

  it('loads a workflow without a tags field (tags is optional)', async () => {
    const catDir = path.join(dir, 'categories', 'testing');
    await fs.mkdir(catDir, { recursive: true });
    // No tags key at all — schema marks it optional, so this should load
    await fs.writeFile(
      path.join(catDir, 'no-tags.yaml'),
      'name: no-tags-wf\nversion: "1.0.0"\ndescription: No tags\nauthor: me\ncategory: testing\nsteps:\n  - server: s\n    tool: t\n',
      'utf-8',
    );

    await svc.init();

    const entry = svc.index.get('no-tags-wf@1.0.0');
    expect(entry).toBeDefined();
    expect(entry?.workflow.tags).toBeUndefined();
    expect(entry?.workflow.steps.length).toBe(1);
  });

  it('loads a workflow where tags: has no items (YAML parses as null)', async () => {
    const catDir = path.join(dir, 'categories', 'testing');
    await fs.mkdir(catDir, { recursive: true });
    // YAML `tags:` with no items parses as null — schema must coerce to undefined, not reject
    await fs.writeFile(
      path.join(catDir, 'null-tags.yaml'),
      'name: null-tags-wf\nversion: "1.0.0"\ndescription: Null tags\nauthor: me\ncategory: testing\ntags:\nsteps:\n  - server: s\n    tool: t\n',
      'utf-8',
    );

    await svc.init();

    const entry = svc.index.get('null-tags-wf@1.0.0');
    expect(entry).toBeDefined();
    expect(entry?.workflow.tags).toBeUndefined();
    expect(entry?.workflow.steps.length).toBe(1);
  });

  // --- writePermanent ---

  it('writes a permanent workflow file and adds it to the index', async () => {
    await svc.init();

    const filePath = await svc.writePermanent({
      name: 'new-workflow',
      version: '1.0.0',
      description: 'A new workflow',
      author: 'me',
      category: 'Git Operations',
      steps: [{ server: 'git-server', tool: 'git_commit' }],
    });

    expect(filePath).toContain('git-operations');
    expect(filePath).toContain('new-workflow-1-0-0-workflow.yaml');
    expect(svc.index.has('new-workflow@1.0.0')).toBe(true);
  });

  it('rejects duplicate permanent workflow', async () => {
    await svc.init();
    const wf = {
      name: 'dup-wf',
      version: '1.0.0',
      description: 'dup',
      author: 'me',
      category: 'testing',
      steps: [{ server: 'srv', tool: 'tool' }],
    };
    await svc.writePermanent(wf);

    await expect(svc.writePermanent(wf)).rejects.toMatchObject({
      message: expect.stringContaining('already exists'),
    });
  });

  // --- writeTemp ---

  it('writes a temp workflow and marks it as isTemp', async () => {
    await svc.init();

    await svc.writeTemp({
      name: 'my-plan',
      version: '1.0.0',
      description: 'short-lived plan',
      author: 'agent',
      temporary: true,
      steps: [{ server: 'srv', tool: 'do_thing' }],
    });

    const entry = svc.index.get('my-plan@1.0.0');
    expect(entry?.isTemp).toBe(true);
  });

  // --- multi-version coexistence (regression: fix #1) ---

  it('preserves all 3 version files on disk when creating 3 versions of the same workflow', async () => {
    await svc.init();

    const base = {
      name: 'multi-ver-wf',
      description: 'Multi-version test',
      author: 'tester',
      category: 'testing',
      steps: [{ server: 'srv', tool: 'tool' }],
    };

    await svc.writePermanent({ ...base, version: '1.0.0' });
    await svc.writePermanent({ ...base, version: '1.0.2' });
    await svc.writePermanent({ ...base, version: '2.0.0' });

    // All 3 entries present in index
    expect(svc.index.has('multi-ver-wf@1.0.0')).toBe(true);
    expect(svc.index.has('multi-ver-wf@1.0.2')).toBe(true);
    expect(svc.index.has('multi-ver-wf@2.0.0')).toBe(true);

    // All 3 files exist on disk
    const catDir = path.join(dir, 'categories', 'testing');
    const files = await fs.readdir(catDir);
    expect(files).toContain('multi-ver-wf-1-0-0-workflow.yaml');
    expect(files).toContain('multi-ver-wf-1-0-2-workflow.yaml');
    expect(files).toContain('multi-ver-wf-2-0-0-workflow.yaml');

    // Lookup by version returns the correct workflow
    expect(svc.findWorkflow('multi-ver-wf', '1.0.0')?.workflow.version).toBe('1.0.0');
    expect(svc.findWorkflow('multi-ver-wf', '1.0.2')?.workflow.version).toBe('1.0.2');
    expect(svc.findWorkflow('multi-ver-wf', '2.0.0')?.workflow.version).toBe('2.0.0');
  });

  // --- TOCTOU race / EEXIST guard (regression: fix #3) ---

  it('rejects duplicate permanent workflow via EEXIST on second concurrent-style write', async () => {
    await svc.init();
    const wf = {
      name: 'eexist-test',
      version: '1.0.0',
      description: 'eexist test',
      author: 'me',
      category: 'testing',
      steps: [{ server: 'srv', tool: 'tool' }],
    };
    await svc.writePermanent(wf);

    // Second write of same version must fail with already_exists
    const err = await svc.writePermanent(wf).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { _reason?: string })._reason).toBe('already_exists');
  });

  // --- empty-slug guard (regression: fix #8) ---

  it('rejects a name that slugifies to empty string', async () => {
    await svc.init();
    const wf = {
      name: '   ', // whitespace-only slugifies to empty
      version: '1.0.0',
      description: 'empty slug test',
      author: 'me',
      category: 'testing',
      steps: [{ server: 'srv', tool: 'tool' }],
    };
    const err = await svc.writePermanent(wf).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { _reason?: string })._reason).toBe('invalid_name');
  });

  // --- name length guard (regression: fix #7) ---

  it('rejects a name that produces a slug exceeding MAX_NAME_SLUG_LENGTH', async () => {
    await svc.init();
    const wf = {
      name: 'a'.repeat(210), // 210 chars > MAX_NAME_SLUG_LENGTH of 200
      version: '1.0.0',
      description: 'too long',
      author: 'me',
      category: 'testing',
      steps: [{ server: 'srv', tool: 'tool' }],
    };
    const err = await svc.writePermanent(wf).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { _reason?: string })._reason).toBe('name_too_long');
  });

  // --- permanent vs temp separation ---

  it('findByName returns only entries matching the name', async () => {
    const catDir = path.join(dir, 'categories', 'testing');
    await fs.mkdir(catDir, { recursive: true });
    await fs.writeFile(
      path.join(catDir, 'wf-v1.yaml'),
      makeWorkflowYaml({ version: '1.0.0' }),
      'utf-8',
    );
    await fs.writeFile(
      path.join(catDir, 'wf-v2.yaml'),
      makeWorkflowYaml({ version: '2.0.0' }),
      'utf-8',
    );
    await fs.writeFile(
      path.join(catDir, 'other.yaml'),
      makeWorkflowYaml({ name: 'other-wf' }),
      'utf-8',
    );

    await svc.init();

    const matches = svc.findByName('test-workflow');
    expect(matches).toHaveLength(2);
    for (const m of matches) {
      expect(m.workflow.name).toBe('test-workflow');
    }
  });
});
