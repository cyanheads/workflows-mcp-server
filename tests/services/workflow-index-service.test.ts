/**
 * @fileoverview Tests for WorkflowIndexService — index build, lookup, write, and snapshot.
 * @module tests/services/workflow-index-service.test
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { ParsedWorkflow } from '@/services/workflow-index/types.js';
import {
  type ConfirmedTarget,
  type DeleteCaller,
  getWorkflowIndexService,
  initWorkflowIndexService,
  shutdownWorkflowIndexService,
  slugify,
  WorkflowIndexService,
  withoutFsPath,
} from '@/services/workflow-index/workflow-index-service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The two ref'd handles `shutdown()` releases. Read directly because neither has a public
 * accessor and the service exposes no test-only surface to add one.
 */
type ServiceInternals = {
  _watcherController?: AbortController;
  _debounceTimer?: ReturnType<typeof setTimeout>;
};

function makeWorkflowYaml(overrides: Record<string, unknown> = {}): string {
  const base = {
    name: 'test-workflow',
    version: '1.0.0',
    description: 'A test workflow',
    author: 'tester',
    category: 'testing',
    steps: [{ server: 'my-server', tool: 'my_tool' }],
    ...overrides,
  } as {
    name: string;
    version: string;
    description: string;
    author: string;
    category?: string;
    temporary?: boolean;
    tags?: string[];
    steps: Array<{ server: string; tool: string }>;
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

/**
 * The filename the write path gives a stored key: the readable slugs plus the first 8 hex
 * characters of SHA-256 over `name@version`. `nameSlug` overrides the name part for names that
 * slugify to nothing.
 */
function fileNameFor(name: string, version: string, nameSlug = slugify(name)): string {
  const hash = createHash('sha256').update(`${name}@${version}`).digest('hex').slice(0, 8);
  return `${nameSlug}-${slugify(version)}-${hash}-workflow.yaml`;
}

/** A valid permanent workflow for write-path tests. */
function permanentWorkflow(overrides: Partial<ParsedWorkflow> = {}): ParsedWorkflow {
  return {
    name: 'fixture-wf',
    version: '1.0.0',
    description: 'fixture',
    author: 'me',
    category: 'testing',
    steps: [{ server: 'srv', tool: 'tool' }],
    ...overrides,
  };
}

/** A valid temporary workflow (no category) for write-path tests. */
function tempWorkflow(overrides: Partial<ParsedWorkflow> = {}): ParsedWorkflow {
  return {
    name: 'fixture-wf',
    version: '1.0.0',
    description: 'fixture',
    author: 'agent',
    temporary: true,
    steps: [{ server: 'srv', tool: 'tool' }],
    ...overrides,
  };
}

/** Workflow files anywhere under a directory, relative to it; empty when it does not exist. */
async function yamlFilesUnder(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { recursive: true }).catch(() => [] as string[]);
  return entries.filter((f) => /\.ya?ml$/.test(f)).sort();
}

/** Poll a sync/async predicate until it returns true or the timeout elapses. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
  stepMs = 20,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return predicate();
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
// withoutFsPath (GH #31)
// ---------------------------------------------------------------------------

describe('withoutFsPath', () => {
  it.each([
    [
      "ENAMETOOLONG: name too long, mkdir '/abs/workflows/categories/ccc'",
      'ENAMETOOLONG: name too long',
    ],
    ["EACCES: permission denied, open '/abs/workflows/temp/x.yaml'", 'EACCES: permission denied'],
    [
      "ENOENT: no such file or directory, unlink '/abs/Casey's vault/x.yaml'",
      'ENOENT: no such file or directory',
    ],
    [
      "ENOENT: no such file or directory, rename '/abs/a' -> '/abs/b'",
      'ENOENT: no such file or directory',
    ],
    ['ENOSPC: no space left on device, write', 'ENOSPC: no space left on device, write'],
    ['Something else went wrong', 'Something else went wrong'],
  ])('reduces %j to %j', (message, expected) => {
    expect(withoutFsPath(message)).toBe(expected);
  });

  it('strips the path from a real error raised by the filesystem', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "quote's-"));
    try {
      const err = await fs.mkdir(path.join(root, 'c'.repeat(300))).catch((e: unknown) => e);
      expect((err as Error).message).toContain(root);
      expect(withoutFsPath((err as Error).message)).toBe('ENAMETOOLONG: name too long');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
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
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  /** The caller every confirmation here is issued to and, unless a test says otherwise, redeemed by. */
  const CALLER: DeleteCaller = { tenantId: 'default', clientId: '', subject: '' };

  /** Issue a delete confirmation to {@link CALLER}. */
  const request = (name: string, version: string | undefined) =>
    svc.requestDeleteConfirmation(name, version, CALLER);

  /** Redeem a delete confirmation as `caller`. */
  const take = (id: unknown, caller: DeleteCaller = CALLER) =>
    svc.takeDeleteConfirmation(id, caller);

  /** Issue and redeem a delete confirmation for whatever the name (and version) resolves to now. */
  const confirm = async (name: string, version?: string): Promise<ConfirmedTarget> => {
    const { id } = await request(name, version);
    const confirmed = take(id);
    if (!confirmed) throw new Error(`confirmation ${id} was not redeemable`);
    return confirmed;
  };

  /** Delete whatever the name (and version) resolves to right now, confirming that target. */
  const deleteResolved = async (name: string, version?: string) =>
    svc.deleteWorkflow(name, version, await confirm(name, version));

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

  // GH #9 — an invalid-semver file must be skipped at build so latest-version lookup can
  // never feed an invalid version to semver.rcompare (which throws "Invalid Version").
  it('skips a hand-placed invalid-semver file and finds the valid version (GH #9)', async () => {
    const catDir = path.join(dir, 'categories', 'testing');
    await fs.mkdir(catDir, { recursive: true });
    await fs.writeFile(
      path.join(catDir, 'valid.yaml'),
      makeWorkflowYaml({ name: 'Semver Edge', version: '1.0.0' }),
      'utf-8',
    );
    await fs.writeFile(
      path.join(catDir, 'invalid.yaml'),
      makeWorkflowYaml({ name: 'Semver Edge', version: '1.0.0junk' }),
      'utf-8',
    );

    await svc.init();

    expect(svc.index.has('Semver Edge@1.0.0')).toBe(true);
    expect(svc.index.has('Semver Edge@1.0.0junk')).toBe(false);

    // Latest-version lookup no longer crashes and returns the valid version.
    const entry = svc.findWorkflow('Semver Edge');
    expect(entry?.workflow.version).toBe('1.0.0');
  });

  // --- duplicate keys ---

  it('collapses two files with the same name@version to one entry and warns', async () => {
    const warn = vi.spyOn(logger, 'warning');
    const catDir = path.join(dir, 'categories', 'testing');
    await fs.mkdir(catDir, { recursive: true });
    const first = path.join(catDir, 'a.yaml');
    const second = path.join(catDir, 'b.yaml');
    await fs.writeFile(first, makeWorkflowYaml({ name: 'Dup Key' }), 'utf-8');
    await fs.writeFile(second, makeWorkflowYaml({ name: 'Dup Key' }), 'utf-8');

    await svc.init();

    expect(svc.findByName('Dup Key')).toHaveLength(1);
    expect([first, second]).toContain(svc.index.get('Dup Key@1.0.0')?.filePath);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Duplicate workflow key "Dup Key@1.0.0"'),
    );
  });

  // --- version canonicalization (GH #16, #26) ---

  it('indexes a hand-authored non-canonical version under its canonical key (GH #26)', async () => {
    const catDir = path.join(dir, 'categories', 'testing');
    await fs.mkdir(catDir, { recursive: true });
    await fs.writeFile(
      path.join(catDir, 'v-prefixed.yaml'),
      makeWorkflowYaml({ name: 'Spelled', version: 'v1.0.0' }),
      'utf-8',
    );
    await fs.writeFile(
      path.join(catDir, 'build-meta.yaml'),
      makeWorkflowYaml({ name: 'Spelled', version: '2.0.0+build.5' }),
      'utf-8',
    );

    await svc.init();

    expect([...svc.index.keys()].sort()).toEqual(['Spelled@1.0.0', 'Spelled@2.0.0']);
    expect(svc.index.get('Spelled@1.0.0')?.workflow.version).toBe('1.0.0');
    expect(svc.index.get('Spelled@2.0.0')?.workflow.version).toBe('2.0.0');
    expect(svc.findWorkflow('Spelled')?.workflow.version).toBe('2.0.0');
  });

  it('collapses on-disk spellings of one canonical version to one entry with a warning (GH #26)', async () => {
    const warn = vi.spyOn(logger, 'warning');
    const catDir = path.join(dir, 'categories', 'testing');
    await fs.mkdir(catDir, { recursive: true });
    await fs.writeFile(
      path.join(catDir, 'plain.yaml'),
      makeWorkflowYaml({ name: 'Collide', version: '1.0.0' }),
      'utf-8',
    );
    await fs.writeFile(
      path.join(catDir, 'prefixed.yaml'),
      makeWorkflowYaml({ name: 'Collide', version: 'v1.0.0' }),
      'utf-8',
    );

    await svc.init();

    expect(svc.findByName('Collide')).toHaveLength(1);
    expect(svc.index.has('Collide@1.0.0')).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Duplicate workflow key "Collide@1.0.0"'),
    );
  });

  // --- blank required text (GH #22) ---

  it.each([
    ['name', { name: '   ' }],
    ['category', { category: '   ' }],
    ['description', { description: '   ' }],
    ['author', { author: '\t ' }],
    ['steps.0.server', { steps: [{ server: '   ', tool: 't' }] }],
    [
      'steps.1.tool',
      {
        steps: [
          { server: 's', tool: 't' },
          { server: 's', tool: '   ' },
        ],
      },
    ],
  ])(
    'skips a hand-authored file whose %s is whitespace-only, with a warning (GH #22)',
    async (field, override) => {
      const warn = vi.spyOn(logger, 'warning');
      const catDir = path.join(dir, 'categories', 'testing');
      await fs.mkdir(catDir, { recursive: true });
      const base = {
        name: 'Blank Probe',
        version: '1.0.0',
        description: 'blank field probe',
        author: 'me',
        category: 'testing',
        steps: [{ server: 's', tool: 't' }],
        ...override,
      };
      // JSON is valid YAML, and keeps whitespace-only scalars quoted so they parse as strings.
      const badPath = path.join(catDir, 'blank.yaml');
      await fs.writeFile(badPath, JSON.stringify(base), 'utf-8');
      await fs.writeFile(
        path.join(catDir, 'good.yaml'),
        makeWorkflowYaml({ name: 'Good Sibling' }),
        'utf-8',
      );

      await svc.init();

      expect(svc.index.size).toBe(1);
      expect(svc.index.has('Good Sibling@1.0.0')).toBe(true);
      const skipWarning = warn.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.includes(`Invalid workflow schema at ${badPath}`));
      expect(skipWarning).toContain(field);
    },
  );

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

  // GH #11 — a missing WORKFLOWS_DIR must be created at init so the snapshot lands and the
  // watcher can attach, instead of leaving the server "ready" but silently un-watched. Live
  // watcher event delivery is timing-dependent under parallel FS load, so it's proven in the
  // field-test; here we lock the deterministic startup effects that were broken before the fix.
  it('creates a missing workflow root, writes the snapshot, and reports ready (GH #11)', async () => {
    const missingRoot = path.join(dir, 'nested', 'missing-root');
    // Precondition: the root does not exist yet.
    await expect(fs.stat(missingRoot)).rejects.toMatchObject({ code: 'ENOENT' });

    const missingSvc = new WorkflowIndexService(
      missingRoot,
      path.join(missingRoot, 'global_instructions.md'),
      10,
    );
    try {
      await missingSvc.init();

      // Root created and service ready — no ENOENT swallowed at startup.
      expect((await fs.stat(missingRoot)).isDirectory()).toBe(true);
      expect(missingSvc.ready).toBe(true);

      // Snapshot lands (would ENOENT on <root>/_index.json before the fix — one of the two
      // documented symptoms). The write is async fire-and-forget, so poll for it.
      const snapshotPath = path.join(missingRoot, '_index.json');
      const snapshotWritten = await waitFor(() =>
        fs.stat(snapshotPath).then(
          () => true,
          () => false,
        ),
      );
      expect(snapshotWritten).toBe(true);

      const snapshot = JSON.parse(await fs.readFile(snapshotPath, 'utf-8')) as { count: number };
      expect(snapshot.count).toBe(0);
    } finally {
      missingSvc.shutdown();
    }
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
    expect(snapshot.entries['test-workflow@1.0.0']).toMatchObject({
      isTemp: false,
      category: 'testing',
    });
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
    expect(filePath).toContain(fileNameFor('new-workflow', '1.0.0'));
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

  // --- deleteWorkflow ---

  it('deletes a permanent workflow file and removes it from the index', async () => {
    await svc.init();
    const filePath = await svc.writePermanent({
      name: 'delete-me',
      version: '1.0.0',
      description: 'to be deleted',
      author: 'me',
      category: 'testing',
      steps: [{ server: 'srv', tool: 'tool' }],
    });
    expect(svc.index.has('delete-me@1.0.0')).toBe(true);

    const deleted = await deleteResolved('delete-me', '1.0.0');
    expect(deleted).toEqual({ name: 'delete-me', version: '1.0.0' });
    expect(svc.index.has('delete-me@1.0.0')).toBe(false);
    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('deleteWorkflow deletes the latest version when version is omitted', async () => {
    await svc.init();
    const base = {
      name: 'multi-del',
      description: 'multi version delete',
      author: 'me',
      category: 'testing',
      steps: [{ server: 'srv', tool: 'tool' }],
    };
    await svc.writePermanent({ ...base, version: '1.0.0' });
    await svc.writePermanent({ ...base, version: '2.0.0' });

    const deleted = await deleteResolved('multi-del');
    expect(deleted.version).toBe('2.0.0');
    expect(svc.index.has('multi-del@2.0.0')).toBe(false);
    expect(svc.index.has('multi-del@1.0.0')).toBe(true);
  });

  it('deleteWorkflow throws tagged not_found for an unknown name', async () => {
    await svc.init();
    const err = await deleteResolved('nope').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { _reason?: string })._reason).toBe('not_found');
  });

  it('deleteWorkflow deletes a temp workflow and keeps temp/ (GH #18)', async () => {
    await svc.init();
    const draft = await svc.writeTemp({
      name: 'temp-del',
      version: '1.0.0',
      description: 'temp',
      author: 'agent',
      temporary: true,
      steps: [{ server: 'srv', tool: 'tool' }],
    });

    const deleted = await deleteResolved('temp-del');
    expect(deleted).toEqual({ name: 'temp-del', version: '1.0.0' });
    // The draft is gone from the index and from disk; the emptied temp/ directory stays.
    expect(svc.index.has('temp-del@1.0.0')).toBe(false);
    await expect(fs.stat(draft.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(path.join(dir, 'temp'))).toEqual([]);
  });

  // --- delete targets (GH #17, #18) ---

  it('names the confirmation target by key, source, and path relative to the root (GH #17)', async () => {
    await svc.init();
    const permanent = await svc.writePermanent(permanentWorkflow({ name: 'Target Probe' }));
    const draft = await svc.writeTemp(tempWorkflow({ name: 'Target Probe', version: '2.0.0' }));

    expect((await request('Target Probe', '1.0.0')).target).toEqual({
      name: 'Target Probe',
      version: '1.0.0',
      source: 'permanent',
      path: path.relative(dir, permanent),
    });
    // An omitted version resolves to the highest version across both sources.
    expect((await request('Target Probe', undefined)).target).toEqual({
      name: 'Target Probe',
      version: '2.0.0',
      source: 'temp',
      path: path.join('temp', path.basename(draft.filePath)),
    });
  });

  it('deletes the temp draft when it is the highest version across sources (GH #18)', async () => {
    await svc.init();
    const permanent = await svc.writePermanent(
      permanentWorkflow({ name: 'Mixed', version: '1.0.0' }),
    );
    const draft = await svc.writeTemp(tempWorkflow({ name: 'Mixed', version: '2.0.0' }));

    await expect(deleteResolved('Mixed')).resolves.toEqual({ name: 'Mixed', version: '2.0.0' });

    await expect(fs.stat(draft.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(permanent)).isFile()).toBe(true);
    expect(svc.findWorkflow('Mixed')).toMatchObject({
      workflow: { version: '1.0.0' },
      isTemp: false,
    });
  });

  it('keeps a temp draft across a restart on the same directory (GH #18)', async () => {
    await svc.init();
    const draft = await svc.writeTemp(tempWorkflow({ name: 'Survivor' }));
    svc.shutdown();

    svc = new WorkflowIndexService(dir, path.join(dir, 'global_instructions.md'), 10);
    await svc.init();

    expect(svc.findWorkflow('Survivor', '1.0.0')).toMatchObject({
      isTemp: true,
      filePath: draft.filePath,
    });
  });

  it('refuses with target_changed when a higher version appeared after the confirmation (GH #17)', async () => {
    await svc.init();
    const v1 = await svc.writePermanent(permanentWorkflow({ name: 'Moving', version: '1.0.0' }));
    const confirmed = await confirm('Moving');
    const v2 = await svc.writePermanent(permanentWorkflow({ name: 'Moving', version: '2.0.0' }));

    const err = await svc.deleteWorkflow('Moving', undefined, confirmed).catch((e: unknown) => e);

    expect((err as { _reason?: string })._reason).toBe('target_changed');
    expect((await fs.stat(v1)).isFile()).toBe(true);
    expect((await fs.stat(v2)).isFile()).toBe(true);
    expect(svc.findByName('Moving')).toHaveLength(2);
  });

  it('refuses with target_changed when the same key now lives in a different file (GH #17)', async () => {
    await svc.init();
    const original = await svc.writePermanent(permanentWorkflow({ name: 'Relocated' }));
    const confirmed = await confirm('Relocated', '1.0.0');
    const movedDir = path.join(dir, 'categories', 'elsewhere');
    const moved = path.join(movedDir, path.basename(original));
    await fs.mkdir(movedDir, { recursive: true });
    await fs.rename(original, moved);
    // Any write rebuilds the index, which picks up the relocated file.
    await svc.writePermanent(permanentWorkflow({ name: 'Unrelated' }));
    expect(svc.findWorkflow('Relocated', '1.0.0')?.filePath).toBe(moved);

    const err = await svc.deleteWorkflow('Relocated', '1.0.0', confirmed).catch((e: unknown) => e);

    expect((err as { _reason?: string })._reason).toBe('target_changed');
    expect((await fs.stat(moved)).isFile()).toBe(true);
  });

  it('refuses with target_changed when a draft was replaced by a permanent workflow of the same key (GH #17)', async () => {
    await svc.init();
    const draft = await svc.writeTemp(tempWorkflow({ name: 'Promoted' }));
    const confirmed = await confirm('Promoted', '1.0.0');
    await deleteResolved('Promoted', '1.0.0');
    const permanent = await svc.writePermanent(permanentWorkflow({ name: 'Promoted' }));

    const err = await svc.deleteWorkflow('Promoted', '1.0.0', confirmed).catch((e: unknown) => e);

    expect(confirmed.source).toBe('temp');
    expect((err as { _reason?: string })._reason).toBe('target_changed');
    await expect(fs.stat(draft.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(permanent)).isFile()).toBe(true);
  });

  it('runs the target check inside the serialized delete, after a queued write lands (GH #17)', async () => {
    await svc.init();
    const v1 = await svc.writePermanent(permanentWorkflow({ name: 'Queued', version: '1.0.0' }));
    const confirmed = await confirm('Queued');

    const [written, deleted] = await Promise.allSettled([
      svc.writePermanent(permanentWorkflow({ name: 'Queued', version: '2.0.0' })),
      svc.deleteWorkflow('Queued', undefined, confirmed),
    ]);

    expect(written.status).toBe('fulfilled');
    expect(deleted.status).toBe('rejected');
    expect(((deleted as PromiseRejectedResult).reason as { _reason?: string })._reason).toBe(
      'target_changed',
    );
    expect((await fs.stat(v1)).isFile()).toBe(true);
    expect(svc.findByName('Queued')).toHaveLength(2);
  });

  it('throws tagged not_found when the confirmed target is gone by the time the delete runs (GH #17)', async () => {
    await svc.init();
    await svc.writePermanent(permanentWorkflow({ name: 'Vanishing' }));
    const confirmed = await confirm('Vanishing', '1.0.0');
    await deleteResolved('Vanishing', '1.0.0');

    const err = await svc.deleteWorkflow('Vanishing', '1.0.0', confirmed).catch((e: unknown) => e);

    expect((err as { _reason?: string })._reason).toBe('not_found');
  });

  // --- delete confirmations: server-side, single use, expiring ---

  /** The pending-confirmation map, read directly to check that it stays bounded. */
  const pendingConfirmations = () =>
    (svc as unknown as { _deleteConfirmations: Map<string, unknown> })._deleteConfirmations;

  it('issues a confirmation holding the target and a SHA-256 of its file bytes', async () => {
    await svc.init();
    const filePath = await svc.writePermanent(permanentWorkflow({ name: 'Hashed' }));

    const { id, target } = await request('Hashed', '1.0.0');

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(target).toEqual({
      name: 'Hashed',
      version: '1.0.0',
      source: 'permanent',
      path: path.relative(dir, filePath),
    });
    expect(take(id)).toEqual({
      ...target,
      contentHash: createHash('sha256')
        .update(await fs.readFile(filePath))
        .digest('hex'),
    });
  });

  it('redeems a confirmation once; a second take and any unissued value return nothing', async () => {
    await svc.init();
    await svc.writePermanent(permanentWorkflow({ name: 'Once' }));
    const { id } = await request('Once', '1.0.0');

    expect(take(id)).toBeDefined();
    expect(take(id)).toBeUndefined();
    for (const unissued of [
      undefined,
      '',
      'not-an-id',
      '00000000-0000-4000-8000-000000000000',
      42,
    ]) {
      expect(take(unissued)).toBeUndefined();
    }
    expect(pendingConfirmations().size).toBe(0);
  });

  it.each([
    ['another tenant', { ...CALLER, tenantId: 'other' }],
    ['another client', { ...CALLER, clientId: 'other' }],
    ['another subject', { ...CALLER, subject: 'other' }],
  ])('returns nothing when %s redeems the confirmation, and spends it', async (_label, other) => {
    await svc.init();
    await svc.writePermanent(permanentWorkflow({ name: 'Bound' }));
    const { id } = await request('Bound', '1.0.0');

    expect(take(id, other)).toBeUndefined();
    expect(take(id)).toBeUndefined();
    expect(pendingConfirmations().size).toBe(0);
  });

  it('redeems a confirmation issued to an authenticated caller for that caller', async () => {
    await svc.init();
    await svc.writePermanent(permanentWorkflow({ name: 'Owned' }));
    const owner: DeleteCaller = { tenantId: 'acme', clientId: 'app', subject: 'alice' };
    const { id } = await svc.requestDeleteConfirmation('Owned', '1.0.0', owner);

    expect(take(id, { ...owner })).toMatchObject({ name: 'Owned', version: '1.0.0' });
  });

  it('issues distinct ids for repeated prompts on one target, each redeemable once', async () => {
    await svc.init();
    await svc.writePermanent(permanentWorkflow({ name: 'Twice Asked' }));
    const first = await request('Twice Asked', '1.0.0');
    const second = await request('Twice Asked', '1.0.0');

    expect(second.id).not.toBe(first.id);
    expect(take(second.id)).toBeDefined();
    expect(take(first.id)).toBeDefined();
  });

  it('throws tagged not_found when asked to confirm a missing name or version', async () => {
    await svc.init();
    await svc.writePermanent(permanentWorkflow({ name: 'Present' }));

    for (const [name, version] of [
      ['Absent', undefined],
      ['Present', '9.9.9'],
    ] as const) {
      const err = await request(name, version).catch((e: unknown) => e);
      expect((err as { _reason?: string })._reason).toBe('not_found');
    }
    expect(pendingConfirmations().size).toBe(0);
  });

  it('throws tagged not_found when the indexed file is gone before the index catches up', async () => {
    await svc.init();
    const filePath = await svc.writePermanent(permanentWorkflow({ name: 'Stale Entry' }));
    const confirmed = await confirm('Stale Entry', '1.0.0');
    // Unlink without a rebuild in between: the entry is still indexed, its file is not there.
    await fs.unlink(filePath);
    expect(svc.findWorkflow('Stale Entry', '1.0.0')?.filePath).toBe(filePath);

    for (const attempt of [
      () => request('Stale Entry', '1.0.0'),
      () => svc.deleteWorkflow('Stale Entry', '1.0.0', confirmed),
    ]) {
      const err = await attempt().catch((e: unknown) => e);
      expect((err as { _reason?: string })._reason).toBe('not_found');
      expect((err as Error).message).not.toContain(dir);
    }
  });

  describe('confirmation lifetime', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('redeems a confirmation up to 600 s after issue and refuses it from then on', async () => {
      await svc.init();
      await svc.writePermanent(permanentWorkflow({ name: 'Timed' }));
      const early = await request('Timed', '1.0.0');
      const late = await request('Timed', '1.0.0');

      vi.setSystemTime(Date.now() + 599_999);
      expect(take(early.id)).toBeDefined();
      vi.setSystemTime(Date.now() + 1);
      expect(take(late.id)).toBeUndefined();
    });

    it('prunes expired confirmations when the next one is issued', async () => {
      await svc.init();
      await svc.writePermanent(permanentWorkflow({ name: 'Pruned' }));
      for (let i = 0; i < 5; i++) await request('Pruned', '1.0.0');
      expect(pendingConfirmations().size).toBe(5);

      vi.setSystemTime(Date.now() + 600_000);
      const fresh = await request('Pruned', '1.0.0');

      expect([...pendingConfirmations().keys()]).toEqual([fresh.id]);
    });
  });

  it('holds at most 1,000 pending confirmations, dropping the oldest first', async () => {
    await svc.init();
    await svc.writePermanent(permanentWorkflow({ name: 'Flooded' }));
    const ids: string[] = [];
    for (let i = 0; i < 1_001; i++) {
      ids.push((await request('Flooded', '1.0.0')).id);
    }

    expect(pendingConfirmations().size).toBe(1_000);
    expect(take(ids[0])).toBeUndefined();
    expect(take(ids[1])).toBeDefined();
    expect(take(ids[1_000])).toBeDefined();
  });

  // --- the confirmed file's content and path ---

  it('refuses with target_changed when the confirmed file’s bytes changed in place', async () => {
    await svc.init();
    const filePath = await svc.writePermanent(permanentWorkflow({ name: 'Edited' }));
    const confirmed = await confirm('Edited', '1.0.0');
    await fs.appendFile(filePath, '# a hand edit\n', 'utf-8');

    const err = await svc.deleteWorkflow('Edited', '1.0.0', confirmed).catch((e: unknown) => e);

    expect((err as { _reason?: string })._reason).toBe('target_changed');
    expect((err as Error).message).toBe(
      `Workflow Edited@1.0.0 (permanent) at ${path.relative(dir, filePath)} had its content changed after it was confirmed`,
    );
    expect(await fs.readFile(filePath, 'utf-8')).toContain('# a hand edit');
  });

  it('names both relative paths when only the file behind the key moved', async () => {
    await svc.init();
    const original = await svc.writePermanent(permanentWorkflow({ name: 'Moved' }));
    const confirmed = await confirm('Moved', '1.0.0');
    const moved = path.join(dir, 'categories', 'elsewhere', path.basename(original));
    await fs.mkdir(path.dirname(moved), { recursive: true });
    await fs.rename(original, moved);
    await svc.writePermanent(permanentWorkflow({ name: 'Unrelated' }));

    const err = await svc.deleteWorkflow('Moved', '1.0.0', confirmed).catch((e: unknown) => e);

    expect((err as Error).message).toBe(
      `Workflow Moved@1.0.0 (permanent) is now stored at ${path.relative(dir, moved)}, not at ${path.relative(dir, original)} where it was confirmed`,
    );
  });

  // --- a key another file still declares (GH #32) ---

  it('reports the file now indexed under a deleted key that another permanent file declares (GH #32)', async () => {
    const dirs = ['alpha', 'beta'].map((c) => path.join(dir, 'categories', c));
    for (const d of dirs) {
      await fs.mkdir(d, { recursive: true });
      await fs.writeFile(path.join(d, 'dup.yaml'), makeWorkflowYaml({ name: 'Dup' }), 'utf-8');
    }
    await svc.init();
    const indexed = svc.findWorkflow('Dup', '1.0.0')?.filePath as string;
    const other = dirs.map((d) => path.join(d, 'dup.yaml')).find((p) => p !== indexed) as string;

    const deleted = await deleteResolved('Dup', '1.0.0');

    expect(deleted).toEqual({
      name: 'Dup',
      version: '1.0.0',
      nowIndexedPath: path.relative(dir, other),
    });
    expect(svc.findWorkflow('Dup', '1.0.0')?.filePath).toBe(other);
  });

  it('reports a shadowed draft that takes over a deleted permanent key (GH #32)', async () => {
    await svc.init();
    await svc.writePermanent(permanentWorkflow({ name: 'Shadowed' }));
    const draftPath = path.join(dir, 'temp', 'shadowed-draft.yaml');
    await fs.mkdir(path.dirname(draftPath), { recursive: true });
    await fs.writeFile(draftPath, makeWorkflowYaml({ name: 'Shadowed', temporary: true }), 'utf-8');

    const deleted = await deleteResolved('Shadowed', '1.0.0');

    expect(deleted.nowIndexedPath).toBe(path.join('temp', 'shadowed-draft.yaml'));
    expect(svc.findWorkflow('Shadowed', '1.0.0')).toMatchObject({
      isTemp: true,
      filePath: draftPath,
    });
  });

  it('omits nowIndexedPath when the deleted key no longer resolves, even if other versions do (GH #32)', async () => {
    await svc.init();
    await svc.writePermanent(permanentWorkflow({ name: 'Versions', version: '1.0.0' }));
    await svc.writePermanent(permanentWorkflow({ name: 'Versions', version: '2.0.0' }));

    const deleted = await deleteResolved('Versions');

    expect(deleted).toStrictEqual({ name: 'Versions', version: '2.0.0' });
    expect(svc.findWorkflow('Versions')?.workflow.version).toBe('1.0.0');
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
    expect(files).toContain(fileNameFor('multi-ver-wf', '1.0.0'));
    expect(files).toContain(fileNameFor('multi-ver-wf', '1.0.2'));
    expect(files).toContain(fileNameFor('multi-ver-wf', '2.0.0'));

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
    /**
     * A file the index does not hold, already at the computed path, so the index check passes and
     * only the exclusive `wx` create can refuse the write. Its content fails the schema, so no
     * watcher rebuild indexes it in between.
     */
    const placedPath = path.join(dir, 'categories', 'testing', fileNameFor(wf.name, wf.version));
    await fs.mkdir(path.dirname(placedPath), { recursive: true });
    await fs.writeFile(placedPath, 'placeholder: not a workflow\n', 'utf-8');
    expect(svc.findWorkflow(wf.name, wf.version)).toBeUndefined();

    const err = await svc.writePermanent(wf).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { _reason?: string })._reason).toBe('already_exists');
    expect(await fs.readFile(placedPath, 'utf-8')).toBe('placeholder: not a workflow\n');
  });

  it('reports overwritten when an unindexed file already sits at the computed temp path (GH #20)', async () => {
    await svc.init();
    const placedPath = path.join(dir, 'temp', fileNameFor('Unindexed Draft', '1.0.0'));
    await fs.mkdir(path.dirname(placedPath), { recursive: true });
    await fs.writeFile(placedPath, 'placeholder: not a workflow\n', 'utf-8');
    expect(svc.findWorkflow('Unindexed Draft', '1.0.0')).toBeUndefined();

    const result = await svc.writeTemp(
      tempWorkflow({ name: 'Unindexed Draft', created_date: '2026-03-03' }),
    );

    // The index had no entry, so only the write itself could have found the file there.
    expect(result).toMatchObject({ status: 'overwritten', filePath: placedPath });
    expect(result.workflow.created_date).toBe('2026-03-03');
    const written = parseYaml(await fs.readFile(placedPath, 'utf-8')) as ParsedWorkflow;
    expect(written).toMatchObject({ name: 'Unindexed Draft', created_date: '2026-03-03' });
    expect(svc.findWorkflow('Unindexed Draft', '1.0.0')?.filePath).toBe(placedPath);
  });

  // --- cross-category duplicate guard (regression: GH #7) ---

  it('rejects a permanent duplicate name@version under a different category (GH #7)', async () => {
    await svc.init();
    const base = {
      name: 'Audit Workflow',
      version: '1.0.0',
      description: 'audit',
      author: 'me',
      steps: [{ server: 'srv', tool: 'tool' }],
    };
    await svc.writePermanent({ ...base, category: 'Alpha Category' });

    const err = await svc
      .writePermanent({ ...base, category: 'Beta Category' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { _reason?: string })._reason).toBe('already_exists');

    // No second file written; a single index entry remains for the key.
    expect(svc.findByName('Audit Workflow')).toHaveLength(1);
  });

  // GH #10 — a provided category that slugifies empty would drop the file into the
  // categories/ root; the write path must reject it like an empty name slug.
  it('rejects a permanent workflow whose category slugifies to empty (GH #10)', async () => {
    await svc.init();
    const err = await svc
      .writePermanent({
        name: 'Category Edge',
        version: '1.0.0',
        description: 'empty category slug',
        author: 'me',
        category: '!!!',
        steps: [{ server: 'srv', tool: 'tool' }],
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { _reason?: string })._reason).toBe('invalid_category');
  });

  it('bounds the category slug at 255 characters, a whole directory name (GH #31)', async () => {
    await svc.init();

    const created = await svc.writePermanent(
      permanentWorkflow({ name: 'Long Category', category: 'c'.repeat(255) }),
    );
    expect(path.basename(path.dirname(created))).toBe('c'.repeat(255));

    const err = await svc
      .writePermanent(permanentWorkflow({ name: 'Longer Category', category: 'c'.repeat(256) }))
      .catch((e: unknown) => e);
    expect((err as { _reason?: string })._reason).toBe('invalid_category');
    expect((err as Error).message).toBe(
      'Workflow category is too long — keep it to at most 255 characters after slugification',
    );
    expect(svc.findByName('Longer Category')).toHaveLength(0);
  });

  it('measures the category bound after slugification (GH #31)', async () => {
    await svc.init();
    // 300 characters of input, 299 after slugification; the punctuation below slugifies away.
    const category = 'a '.repeat(150);
    expect(slugify(category)).toHaveLength(299);

    const err = await svc
      .writePermanent(permanentWorkflow({ name: 'Spaced Category', category }))
      .catch((e: unknown) => e);
    expect((err as { _reason?: string })._reason).toBe('invalid_category');

    const created = await svc.writePermanent(
      permanentWorkflow({ name: 'Punctuated Category', category: `${'!'.repeat(200)}ok` }),
    );
    expect(path.basename(path.dirname(created))).toBe('ok');
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

  // --- filenames carry a hash of the stored key (GH #21, #29) ---

  const slugCollisionPairs = [
    ['name punctuation', 'Slug A+B', '1.0.0', 'Slug A B', '1.0.0'],
    ['name case', 'Deploy', '1.0.0', 'deploy', '1.0.0'],
    ['non-ASCII letters', 'Café Plan', '1.0.0', 'Caf Plan', '1.0.0'],
    ['prerelease case', 'RC Probe', '1.0.0-RC1', 'RC Probe', '1.0.0-rc1'],
  ] as const;

  it.each(slugCollisionPairs)(
    'stores permanent keys whose slugs coincide (%s) at distinct paths (GH #21)',
    async (_label, nameA, versionA, nameB, versionB) => {
      await svc.init();
      const a = await svc.writePermanent(permanentWorkflow({ name: nameA, version: versionA }));
      const b = await svc.writePermanent(permanentWorkflow({ name: nameB, version: versionB }));

      expect(b).not.toBe(a);
      expect(path.basename(a)).toBe(fileNameFor(nameA, versionA));
      expect(path.basename(b)).toBe(fileNameFor(nameB, versionB));
      expect(svc.findWorkflow(nameA, versionA)?.filePath).toBe(a);
      expect(svc.findWorkflow(nameB, versionB)?.filePath).toBe(b);
    },
  );

  it.each(slugCollisionPairs)(
    'stores temp keys whose slugs coincide (%s) at distinct paths without losing either (GH #21)',
    async (_label, nameA, versionA, nameB, versionB) => {
      await svc.init();
      const a = await svc.writeTemp(tempWorkflow({ name: nameA, version: versionA }));
      const b = await svc.writeTemp(tempWorkflow({ name: nameB, version: versionB }));

      expect(a.status).toBe('created');
      expect(b.status).toBe('created');
      expect(b.filePath).not.toBe(a.filePath);
      expect(svc.findWorkflow(nameA, versionA)?.filePath).toBe(a.filePath);
      expect(svc.findWorkflow(nameB, versionB)?.filePath).toBe(b.filePath);
      expect(await yamlFilesUnder(path.join(dir, 'temp'))).toHaveLength(2);
    },
  );

  it('keeps the filename within 255 bytes for the longest name and a long prerelease (GH #21)', async () => {
    await svc.init();
    const version = `1.0.0-${'prerelease.'.repeat(20)}final`;

    const permanent = await svc.writePermanent(
      permanentWorkflow({ name: 'p'.repeat(200), version }),
    );
    const temp = await svc.writeTemp(tempWorkflow({ name: 't'.repeat(200), version }));

    for (const filePath of [permanent, temp.filePath]) {
      expect(Buffer.byteLength(path.basename(filePath))).toBeLessThanOrEqual(255);
      expect(path.basename(filePath)).toMatch(/-[0-9a-f]{8}-workflow\.yaml$/);
    }
    expect(svc.findWorkflow('p'.repeat(200), version)?.filePath).toBe(permanent);
    expect(svc.findWorkflow('t'.repeat(200), version)?.filePath).toBe(temp.filePath);
  });

  it('accepts names with no ASCII letters or digits under a placeholder name segment (GH #29)', async () => {
    await svc.init();
    const first = await svc.writePermanent(permanentWorkflow({ name: 'Рабочий процесс' }));
    const second = await svc.writePermanent(permanentWorkflow({ name: 'Другой процесс' }));
    const draft = await svc.writeTemp(tempWorkflow({ name: '日本語ワークフロー' }));

    expect(path.basename(first)).toBe(fileNameFor('Рабочий процесс', '1.0.0', 'workflow'));
    expect(path.basename(draft.filePath)).toBe(
      fileNameFor('日本語ワークフロー', '1.0.0', 'workflow'),
    );
    expect(second).not.toBe(first);
    expect(svc.findWorkflow('Рабочий процесс')?.filePath).toBe(first);
    expect(svc.findWorkflow('Другой процесс')?.filePath).toBe(second);
    expect(svc.findWorkflow('日本語ワークフロー')?.isTemp).toBe(true);

    await deleteResolved('Рабочий процесс', '1.0.0');
    expect(svc.findWorkflow('Рабочий процесс')).toBeUndefined();
    await expect(fs.stat(first)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('resolves, conflicts on, and deletes a permanent file stored under the old naming (GH #21)', async () => {
    const catDir = path.join(dir, 'categories', 'testing');
    await fs.mkdir(catDir, { recursive: true });
    const legacyPath = path.join(catDir, 'legacy-wf-1-0-0-workflow.yaml');
    await fs.writeFile(legacyPath, makeWorkflowYaml({ name: 'Legacy WF' }), 'utf-8');
    await svc.init();

    expect(svc.findWorkflow('Legacy WF', '1.0.0')?.filePath).toBe(legacyPath);
    for (const write of [
      () => svc.writePermanent(permanentWorkflow({ name: 'Legacy WF', category: 'other' })),
      () => svc.writeTemp(tempWorkflow({ name: 'Legacy WF' })),
    ]) {
      const err = await write().catch((e: unknown) => e);
      expect((err as { _reason?: string })._reason).toBe('already_exists');
    }
    expect(await yamlFilesUnder(dir)).toEqual([
      path.join('categories', 'testing', path.basename(legacyPath)),
    ]);

    await deleteResolved('Legacy WF', '1.0.0');
    await expect(fs.stat(legacyPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // --- temp write outcome (GH #20) ---

  it('reports created for a new draft and overwritten when replacing one, keeping its created_date (GH #20)', async () => {
    await svc.init();
    const first = await svc.writeTemp(
      tempWorkflow({ created_date: '2026-01-01', last_updated_date: '2026-01-01' }),
    );
    const second = await svc.writeTemp(
      tempWorkflow({
        description: 'revised',
        created_date: '2026-02-02',
        last_updated_date: '2026-02-02',
      }),
    );

    expect(first.status).toBe('created');
    expect(second.status).toBe('overwritten');
    expect(second.filePath).toBe(first.filePath);
    expect(second.workflow.created_date).toBe('2026-01-01');
    expect(second.workflow.last_updated_date).toBe('2026-02-02');

    const written = parseYaml(await fs.readFile(second.filePath, 'utf-8')) as ParsedWorkflow;
    expect(written).toMatchObject({
      description: 'revised',
      created_date: '2026-01-01',
      last_updated_date: '2026-02-02',
    });
    expect(await yamlFilesUnder(path.join(dir, 'temp'))).toHaveLength(1);
  });

  it('overwrites a draft stored under an older filename in place (GH #20, #21)', async () => {
    const tempDir = path.join(dir, 'temp');
    await fs.mkdir(tempDir, { recursive: true });
    const legacyPath = path.join(tempDir, 'hand-named-draft.yaml');
    await fs.writeFile(
      legacyPath,
      JSON.stringify({
        ...tempWorkflow({ name: 'Legacy Draft' }),
        created_date: '2020-01-01',
        last_updated_date: '2020-01-01',
      }),
      'utf-8',
    );
    await svc.init();

    const result = await svc.writeTemp(
      tempWorkflow({
        name: 'Legacy Draft',
        description: 'replacement',
        created_date: '2026-09-23',
        last_updated_date: '2026-09-23',
      }),
    );

    expect(result).toMatchObject({ status: 'overwritten', filePath: legacyPath });
    expect(await yamlFilesUnder(tempDir)).toEqual(['hand-named-draft.yaml']);
    const written = parseYaml(await fs.readFile(legacyPath, 'utf-8')) as ParsedWorkflow;
    expect(written).toMatchObject({
      description: 'replacement',
      created_date: '2020-01-01',
      last_updated_date: '2026-09-23',
    });
  });

  // --- one index entry per key across sources (GH #19) ---

  it('rejects a temp draft for a key a permanent workflow holds and writes nothing (GH #19)', async () => {
    await svc.init();
    const permanentPath = await svc.writePermanent(permanentWorkflow({ name: 'Shadow Collision' }));

    const err = await svc
      .writeTemp(tempWorkflow({ name: 'Shadow Collision', description: 'draft' }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as { _reason?: string })._reason).toBe('already_exists');
    expect(await yamlFilesUnder(path.join(dir, 'temp'))).toEqual([]);
    expect(svc.findWorkflow('Shadow Collision', '1.0.0')).toMatchObject({
      isTemp: false,
      filePath: permanentPath,
    });
    await expect(deleteResolved('Shadow Collision', '1.0.0')).resolves.toEqual({
      name: 'Shadow Collision',
      version: '1.0.0',
    });
  });

  it('rejects a permanent create for a key a temp draft holds and writes nothing (GH #19)', async () => {
    await svc.init();
    const draft = await svc.writeTemp(tempWorkflow({ name: 'Shadow Collision' }));

    const err = await svc
      .writePermanent(permanentWorkflow({ name: 'Shadow Collision' }))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as { _reason?: string })._reason).toBe('already_exists');
    expect((err as Error).message).toContain('temporary draft');
    expect(await yamlFilesUnder(path.join(dir, 'categories'))).toEqual([]);
    expect(svc.findWorkflow('Shadow Collision', '1.0.0')).toMatchObject({
      isTemp: true,
      filePath: draft.filePath,
    });
  });

  it('keeps different versions of one name across sources (GH #19)', async () => {
    await svc.init();
    await svc.writePermanent(permanentWorkflow({ name: 'Cross Source', version: '1.0.0' }));
    await svc.writeTemp(tempWorkflow({ name: 'Cross Source', version: '2.0.0' }));

    expect(svc.findWorkflow('Cross Source', '1.0.0')?.isTemp).toBe(false);
    expect(svc.findWorkflow('Cross Source', '2.0.0')?.isTemp).toBe(true);
    expect(svc.findByName('Cross Source')).toHaveLength(2);
  });

  it('resolves an on-disk same-key pair to the permanent entry and warns with both paths (GH #19)', async () => {
    const warn = vi.spyOn(logger, 'warning');
    const catDir = path.join(dir, 'categories', 'testing');
    const tempDir = path.join(dir, 'temp');
    await fs.mkdir(catDir, { recursive: true });
    await fs.mkdir(tempDir, { recursive: true });
    const permanentPath = path.join(catDir, 'pair.yaml');
    const tempPath = path.join(tempDir, 'pair.yaml');
    await fs.writeFile(permanentPath, makeWorkflowYaml({ name: 'Pair' }), 'utf-8');
    await fs.writeFile(tempPath, makeWorkflowYaml({ name: 'Pair', temporary: true }), 'utf-8');

    await svc.init();

    expect(svc.findByName('Pair')).toHaveLength(1);
    expect(svc.index.get('Pair@1.0.0')).toMatchObject({ isTemp: false, filePath: permanentPath });
    const shadowWarning = warn.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.includes('"Pair@1.0.0"'));
    expect(shadowWarning).toContain(permanentPath);
    expect(shadowWarning).toContain(tempPath);
    expect(shadowWarning).toContain('shadowed');
  });

  // --- serialized writes (GH #30) ---

  it('lets exactly one of two parallel creates of one key into different categories succeed (GH #30)', async () => {
    await svc.init();

    const results = await Promise.allSettled([
      svc.writePermanent(permanentWorkflow({ name: 'Race Probe', category: 'alpha' })),
      svc.writePermanent(permanentWorkflow({ name: 'Race Probe', category: 'beta' })),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected.map((r) => (r.reason as { _reason?: string })._reason)).toEqual([
      'already_exists',
    ]);
    expect(await yamlFilesUnder(path.join(dir, 'categories'))).toHaveLength(1);
    expect(svc.findByName('Race Probe')).toHaveLength(1);
  });

  it.each([
    ['permanent first', true],
    ['temp first', false],
  ])(
    'lets exactly one of a parallel permanent/temp pair on one key succeed (%s) (GH #19, #30)',
    async (_label, permanentFirst) => {
      await svc.init();
      const permanent = () => svc.writePermanent(permanentWorkflow({ name: 'Pair Race' }));
      const temp = () => svc.writeTemp(tempWorkflow({ name: 'Pair Race' }));

      const results = await Promise.allSettled(
        permanentFirst ? [permanent(), temp()] : [temp(), permanent()],
      );

      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
      const rejected = results[1] as PromiseRejectedResult;
      expect((rejected.reason as { _reason?: string })._reason).toBe('already_exists');
      expect(await yamlFilesUnder(dir)).toHaveLength(1);
      expect(svc.findWorkflow('Pair Race', '1.0.0')?.isTemp).toBe(!permanentFirst);
    },
  );

  it('serializes parallel temp writes of one key into one created and one overwritten (GH #20, #30)', async () => {
    await svc.init();

    const results = await Promise.all([
      svc.writeTemp(
        tempWorkflow({ name: 'Draft Race', description: 'first', created_date: '2026-01-01' }),
      ),
      svc.writeTemp(
        tempWorkflow({ name: 'Draft Race', description: 'second', created_date: '2026-02-02' }),
      ),
    ]);

    expect(results.map((r) => r.status)).toEqual(['created', 'overwritten']);
    expect(await yamlFilesUnder(path.join(dir, 'temp'))).toHaveLength(1);
    expect(svc.findWorkflow('Draft Race', '1.0.0')?.workflow.description).toBe('second');
    /**
     * The overwrite keeps the replaced draft's created_date only if it saw the first write's
     * index entry — which the queue guarantees. Interleaved, the second write reads an empty
     * index before the first lands and stamps its own date.
     */
    const written = parseYaml(await fs.readFile(results[1].filePath, 'utf-8')) as ParsedWorkflow;
    expect(written.created_date).toBe('2026-01-01');
    expect(results[1].workflow.created_date).toBe('2026-01-01');
  });

  it('completes a parallel delete of a category’s last workflow and a create into it (GH #24, #30)', async () => {
    await svc.init();
    await svc.writePermanent(permanentWorkflow({ name: 'Leaving', category: 'shared' }));

    const [deleted, created] = await Promise.all([
      deleteResolved('Leaving', '1.0.0'),
      svc.writePermanent(permanentWorkflow({ name: 'Arriving', category: 'shared' })),
    ]);

    expect(deleted).toEqual({ name: 'Leaving', version: '1.0.0' });
    expect((await fs.stat(created)).isFile()).toBe(true);
    expect(svc.findWorkflow('Arriving', '1.0.0')?.filePath).toBe(created);
  });

  // --- empty category cleanup (GH #24) ---

  it('removes a category directory emptied by a delete and keeps categories/ (GH #24)', async () => {
    await svc.init();
    await svc.writePermanent(permanentWorkflow({ name: 'Typo Category', category: 'tesitng' }));
    const categoryDir = path.join(dir, 'categories', 'tesitng');
    expect((await fs.stat(categoryDir)).isDirectory()).toBe(true);

    await deleteResolved('Typo Category', '1.0.0');

    await expect(fs.stat(categoryDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(path.join(dir, 'categories'))).isDirectory()).toBe(true);
  });

  it('keeps a category directory that still holds another workflow (GH #24)', async () => {
    await svc.init();
    await svc.writePermanent(permanentWorkflow({ name: 'Stays', category: 'shared' }));
    await svc.writePermanent(permanentWorkflow({ name: 'Goes', category: 'shared' }));

    await deleteResolved('Goes', '1.0.0');

    expect((await fs.stat(path.join(dir, 'categories', 'shared'))).isDirectory()).toBe(true);
    expect(svc.findWorkflow('Stays', '1.0.0')).toBeDefined();
  });

  it('keeps a category directory that still holds a non-workflow file (GH #24)', async () => {
    await svc.init();
    await svc.writePermanent(permanentWorkflow({ name: 'Only One', category: 'notes' }));
    const categoryDir = path.join(dir, 'categories', 'notes');
    await fs.writeFile(path.join(categoryDir, '.DS_Store'), '', 'utf-8');

    await deleteResolved('Only One', '1.0.0');

    expect(await fs.readdir(categoryDir)).toEqual(['.DS_Store']);
  });

  it('never removes categories/ or a nested directory — only a direct child of categories/ (GH #24)', async () => {
    const categoriesDir = path.join(dir, 'categories');
    const nestedDir = path.join(categoriesDir, 'outer', 'inner');
    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(
      path.join(categoriesDir, 'root.yaml'),
      makeWorkflowYaml({ name: 'At Root' }),
      'utf-8',
    );
    await fs.writeFile(
      path.join(nestedDir, 'nested.yaml'),
      makeWorkflowYaml({ name: 'Nested' }),
      'utf-8',
    );
    await svc.init();

    await deleteResolved('At Root', '1.0.0');
    await deleteResolved('Nested', '1.0.0');

    expect((await fs.stat(categoriesDir)).isDirectory()).toBe(true);
    expect((await fs.stat(nestedDir)).isDirectory()).toBe(true);
  });

  it('logs a cleanup failure and still completes the delete (GH #24)', async () => {
    const warn = vi.spyOn(logger, 'warning');
    await svc.init();
    const filePath = await svc.writePermanent(
      permanentWorkflow({ name: 'Locked Parent', category: 'locked' }),
    );
    const categoriesDir = path.join(dir, 'categories');
    // Removing categories/locked needs write permission on categories/; unlinking the file
    // inside it does not.
    await fs.chmod(categoriesDir, 0o555);

    try {
      await expect(deleteResolved('Locked Parent', '1.0.0')).resolves.toEqual({
        name: 'Locked Parent',
        version: '1.0.0',
      });
      await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(svc.findWorkflow('Locked Parent', '1.0.0')).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(path.join(categoriesDir, 'locked')),
      );
    } finally {
      await fs.chmod(categoriesDir, 0o755);
    }
  });

  it('recreates a category directory on create after a delete removed it (GH #24)', async () => {
    await svc.init();
    await svc.writePermanent(permanentWorkflow({ name: 'First', category: 'cycle' }));
    await deleteResolved('First', '1.0.0');

    const filePath = await svc.writePermanent(
      permanentWorkflow({ name: 'Second', category: 'cycle' }),
    );

    expect(path.dirname(filePath)).toBe(path.join(dir, 'categories', 'cycle'));
    expect(svc.findWorkflow('Second', '1.0.0')?.filePath).toBe(filePath);
  });

  // --- shutdown ---

  it('indexes every bundled seed workflow (GH #22 regression guard)', async () => {
    const seedDir = fileURLToPath(new URL('../../workflows-yaml/categories', import.meta.url));
    await fs.cp(seedDir, path.join(dir, 'categories'), { recursive: true });
    const seedFiles = (await fs.readdir(seedDir, { recursive: true })).filter((f) =>
      /\.ya?ml$/.test(f),
    );

    await svc.init();

    expect(seedFiles.length).toBeGreaterThan(0);
    expect(svc.index.size).toBe(seedFiles.length);
  });

  it('shutdown aborts the filesystem watcher', async () => {
    await svc.init();

    const internals = svc as unknown as ServiceInternals;
    expect(internals._watcherController?.signal.aborted).toBe(false);

    svc.shutdown();

    expect(internals._watcherController?.signal.aborted).toBe(true);
  });

  it('shutdown clears a pending debounced rebuild', async () => {
    await svc.init();

    const internals = svc as unknown as ServiceInternals;
    // The watcher loop is the only writer of _debounceTimer, and live fs.watch event delivery is
    // timing-dependent under parallel FS load (see the GH #11 note above), so the pending timer is
    // planted directly. A ref'd timer surviving shutdown is what keeps the event loop alive.
    let fired = false;
    internals._debounceTimer = setTimeout(() => {
      fired = true;
    }, 20);

    svc.shutdown();

    expect(internals._debounceTimer).toBeUndefined();
    await new Promise((r) => setTimeout(r, 80));
    expect(fired).toBe(false);
  });

  it('shutdown is idempotent', async () => {
    await svc.init();

    svc.shutdown();
    expect(() => {
      svc.shutdown();
    }).not.toThrow();
  });

  it('a shutdown during init leaves no watcher behind', async () => {
    // initWorkflowIndexService() starts init() without awaiting it, so teardown can land while the
    // first index build is still running. The watcher must not open after that point.
    const initializing = svc.init();
    svc.shutdown();
    await initializing;

    const internals = svc as unknown as ServiceInternals;
    expect(internals._watcherController).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Module lifecycle — the init/teardown pair createApp() wires to setup/teardown
// ---------------------------------------------------------------------------

describe('initWorkflowIndexService / shutdownWorkflowIndexService', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkTmpDir();
  });

  afterEach(async () => {
    shutdownWorkflowIndexService();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('tears down the live service and clears the accessor', async () => {
    initWorkflowIndexService(
      {} as AppConfig,
      {} as StorageService,
      dir,
      path.join(dir, 'global_instructions.md'),
      10,
    );
    await waitFor(() => getWorkflowIndexService().ready);

    const live = getWorkflowIndexService();
    const internals = live as unknown as ServiceInternals;
    expect(internals._watcherController?.signal.aborted).toBe(false);

    shutdownWorkflowIndexService();

    expect(internals._watcherController?.signal.aborted).toBe(true);
    expect(() => getWorkflowIndexService()).toThrow(/not initialized/);
  });

  it('is a no-op when no service was initialized', () => {
    expect(() => {
      shutdownWorkflowIndexService();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Bundled seed workflows
// ---------------------------------------------------------------------------

describe('bundled seed workflows', () => {
  // GH #12 — the shipped research-visualization workflow must declare a category so it stops
  // warning at boot and matches category-filtered workflow_list. The slug must equal the parent
  // directory to stay in-place-consistent with the write path.
  it('research-visualization workflow declares a category matching its directory (GH #12)', async () => {
    const filePath = fileURLToPath(
      new URL(
        '../../workflows-yaml/categories/research-visualization/pubmed-research-with-cosmograph-visualization-workflow.yaml',
        import.meta.url,
      ),
    );
    const parsed = parseYaml(await fs.readFile(filePath, 'utf-8')) as { category?: string };

    expect(parsed.category).toBeDefined();
    expect(slugify(parsed.category ?? '')).toBe('research-visualization');
  });
});
