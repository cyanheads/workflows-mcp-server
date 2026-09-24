/**
 * @fileoverview Tests for workflow_get tool.
 * @module tests/tools/workflow-get.tool.test
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/workflow-index/workflow-index-service.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/services/workflow-index/workflow-index-service.js')>();
  return {
    ...actual,
    getWorkflowIndexService: vi.fn(),
  };
});

import { workflowGet } from '@/mcp-server/tools/definitions/workflow-get.tool.js';
import {
  getWorkflowIndexService,
  WorkflowIndexService,
} from '@/services/workflow-index/workflow-index-service.js';

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wf-get-test-'));
}

const PERMANENT_WF_YAML = `name: deploy-app
version: "1.0.0"
description: Deploy the application to production
author: ops-team
category: Deployment
tags:
  - deploy
  - production
steps:
  - server: deploy-server
    tool: run_deploy
    description: Run the deployment script
  - server: notify-server
    tool: send_alert
`;

const TEMP_WF_YAML = `name: quick-plan
version: "1.0.0"
description: A quick temporary plan
author: agent
temporary: true
steps:
  - server: my-server
    tool: do_thing
`;

describe('workflowGet', () => {
  let dir: string;
  let svc: WorkflowIndexService;

  beforeEach(async () => {
    dir = await mkTmpDir();

    // Write fixture workflows
    const catDir = path.join(dir, 'categories', 'deployment');
    await fs.mkdir(catDir, { recursive: true });
    await fs.writeFile(path.join(catDir, 'deploy-app.yaml'), PERMANENT_WF_YAML, 'utf-8');
    await fs.writeFile(
      path.join(catDir, 'deploy-app-v2.yaml'),
      PERMANENT_WF_YAML.replace('version: "1.0.0"', 'version: "2.0.0"'),
      'utf-8',
    );

    const tempDir = path.join(dir, 'temp');
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, 'quick-plan.yaml'), TEMP_WF_YAML, 'utf-8');

    await fs.writeFile(
      path.join(dir, 'global_instructions.md'),
      'Always verify before committing.',
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

  it('returns the latest version when version is omitted', async () => {
    const ctx = createMockContext({ errors: workflowGet.errors });
    const input = workflowGet.input.parse({ name: 'deploy-app' });
    const result = await workflowGet.handler(input, ctx);
    expect(result.workflow.version).toBe('2.0.0');
    expect(result.workflow.name).toBe('deploy-app');
    expect(result.source).toBe('permanent');
  });

  it('returns a specific version when requested', async () => {
    const ctx = createMockContext({ errors: workflowGet.errors });
    const input = workflowGet.input.parse({ name: 'deploy-app', version: '1.0.0' });
    const result = await workflowGet.handler(input, ctx);
    expect(result.workflow.version).toBe('1.0.0');
  });

  it('returns globalInstructions from the file', async () => {
    const ctx = createMockContext({ errors: workflowGet.errors });
    const input = workflowGet.input.parse({ name: 'deploy-app' });
    const result = await workflowGet.handler(input, ctx);
    expect(result.globalInstructions).toBe('Always verify before committing.');
  });

  it('returns globalInstructions as null when file is missing', async () => {
    await fs.rm(path.join(dir, 'global_instructions.md'));
    const ctx = createMockContext({ errors: workflowGet.errors });
    const input = workflowGet.input.parse({ name: 'deploy-app' });
    const result = await workflowGet.handler(input, ctx);
    expect(result.globalInstructions).toBeNull();
  });

  it('returns a temp workflow with source=temp', async () => {
    const ctx = createMockContext({ errors: workflowGet.errors });
    const input = workflowGet.input.parse({ name: 'quick-plan' });
    const result = await workflowGet.handler(input, ctx);
    expect(result.source).toBe('temp');
    expect(result.workflow.temporary).toBe(true);
  });

  // --- error paths ---

  it('throws not_found when name does not exist', async () => {
    const ctx = createMockContext({ errors: workflowGet.errors });
    const input = workflowGet.input.parse({ name: 'nonexistent-wf' });
    await expect(workflowGet.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
  });

  it('throws version_not_found when name exists but version does not', async () => {
    const ctx = createMockContext({ errors: workflowGet.errors });
    const input = workflowGet.input.parse({ name: 'deploy-app', version: '99.0.0' });
    await expect(workflowGet.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'version_not_found' },
    });
  });

  it('throws index_unavailable when service is not ready', async () => {
    Object.defineProperty(svc, '_ready', { value: false, writable: true });
    const ctx = createMockContext({ errors: workflowGet.errors });
    const input = workflowGet.input.parse({ name: 'deploy-app' });
    await expect(workflowGet.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'index_unavailable' },
    });
  });

  // --- format ---

  it('renders workflow name, version, author, and steps', async () => {
    const ctx = createMockContext({ errors: workflowGet.errors });
    const input = workflowGet.input.parse({ name: 'deploy-app', version: '1.0.0' });
    const result = await workflowGet.handler(input, ctx);
    const blocks = workflowGet.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('deploy-app');
    expect(text).toContain('1.0.0');
    expect(text).toContain('ops-team');
    expect(text).toContain('run_deploy');
  });

  it('renders global instructions when present', async () => {
    const ctx = createMockContext({ errors: workflowGet.errors });
    const input = workflowGet.input.parse({ name: 'deploy-app' });
    const result = await workflowGet.handler(input, ctx);
    const blocks = workflowGet.format!(result);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Always verify before committing.');
  });

  it('renders absence note when globalInstructions is null', async () => {
    const blocks = workflowGet.format!({
      workflow: {
        name: 'test',
        version: '1.0.0',
        description: 'desc',
        author: 'me',
        steps: [{ server: 's', tool: 't' }],
      },
      globalInstructions: null,
      source: 'permanent',
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No global execution guidance');
  });

  // --- version input (GH #16, #26) ---

  it('treats an empty-string version as omitted and returns the latest', async () => {
    const ctx = createMockContext({ errors: workflowGet.errors });
    const input = workflowGet.input.parse({ name: 'deploy-app', version: '' });
    const result = await workflowGet.handler(input, ctx);
    expect(result.workflow.version).toBe('2.0.0');
  });

  it.each(['not-semver', '1.0', '1.0.0junk', '   '])(
    'rejects non-semver version %j as invalid arguments before lookup (GH #16)',
    async (version) => {
      const findWorkflow = vi.spyOn(svc, 'findWorkflow');
      const result = await runToolContract(workflowGet, { name: 'deploy-app', version });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
      });
      expect((result.content[0] as { text: string }).text).toContain('version');
      expect(findWorkflow).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['v1.0.0', '1.0.0'],
    [' 2.0.0 ', '2.0.0'],
    ['1.0.0+build.5', '1.0.0'],
  ])(
    'canonicalizes the tolerated spelling %j before lookup (GH #16)',
    async (version, canonical) => {
      const result = await runToolContract(workflowGet, { name: 'deploy-app', version });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ workflow: { version: canonical } });
      expect((result.content[0] as { text: string }).text).toContain(`# deploy-app v${canonical}`);
    },
  );

  it('serves an on-disk non-canonical version under its canonical form (GH #26)', async () => {
    await fs.writeFile(
      path.join(dir, 'categories', 'deployment', 'deploy-app-v3.yaml'),
      PERMANENT_WF_YAML.replace('version: "1.0.0"', 'version: "v3.0.0"'),
      'utf-8',
    );
    await svc.init();

    const ctx = createMockContext({ errors: workflowGet.errors });
    const latest = await workflowGet.handler(workflowGet.input.parse({ name: 'deploy-app' }), ctx);
    expect(latest.workflow.version).toBe('3.0.0');

    for (const version of ['3.0.0', 'v3.0.0']) {
      const exact = await workflowGet.handler(
        workflowGet.input.parse({ name: 'deploy-app', version }),
        ctx,
      );
      expect(exact.workflow.version).toBe('3.0.0');
    }
  });

  it('reports version_not_found with the canonical version and semver-ordered alternatives', async () => {
    await fs.writeFile(
      path.join(dir, 'categories', 'deployment', 'deploy-app-v10.yaml'),
      PERMANENT_WF_YAML.replace('version: "1.0.0"', 'version: "10.0.0"'),
      'utf-8',
    );
    await svc.init();

    const ctx = createMockContext({ errors: workflowGet.errors });
    const input = workflowGet.input.parse({ name: 'deploy-app', version: 'v99.0.0' });
    await expect(workflowGet.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'version_not_found' },
      message:
        'Workflow "deploy-app" does not have version "99.0.0". Available: 1.0.0, 2.0.0, 10.0.0',
    });
  });

  // --- name input (GH #33) ---

  it('trims a padded name before lookup and serves the stored workflow on both surfaces (GH #33)', async () => {
    const result = await runToolContract(workflowGet, { name: '  deploy-app  ' });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      workflow: { name: 'deploy-app', version: '2.0.0' },
      source: 'permanent',
    });
    expect((result.content[0] as { text: string }).text).toContain('# deploy-app v2.0.0');
  });

  it('trims a padded name on an exact-version lookup and a draft lookup (GH #33)', async () => {
    const exact = await runToolContract(workflowGet, { name: '\tdeploy-app\n', version: '1.0.0' });
    const draft = await runToolContract(workflowGet, { name: ' quick-plan ' });

    expect(exact.structuredContent).toMatchObject({ workflow: { version: '1.0.0' } });
    expect(draft.structuredContent).toMatchObject({
      workflow: { name: 'quick-plan' },
      source: 'temp',
    });
  });

  it('names the trimmed name in version_not_found (GH #33)', async () => {
    const ctx = createMockContext({ errors: workflowGet.errors });
    const input = workflowGet.input.parse({ name: ' deploy-app ', version: '99.0.0' });
    await expect(workflowGet.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'version_not_found' },
      message: 'Workflow "deploy-app" does not have version "99.0.0". Available: 1.0.0, 2.0.0',
    });
  });

  it.each(['', '   '])(
    'rejects the blank name %j as invalid arguments before lookup (GH #33)',
    async (name) => {
      const findWorkflow = vi.spyOn(svc, 'findWorkflow');
      const result = await runToolContract(workflowGet, { name });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
      });
      expect((result.content[0] as { text: string }).text).toContain('name');
      expect(findWorkflow).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['not_found', { name: 'nonexistent-wf' }],
    ['version_not_found', { name: 'deploy-app', version: '99.0.0' }],
  ])(
    'points %s recovery at the draft key, since workflow_list never shows drafts',
    async (reason, input) => {
      const result = await runToolContract(workflowGet, input);

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as {
        error: { data: { reason: string; recovery?: { hint: string } } };
      };
      expect(error.data.reason).toBe(reason);
      expect(error.data.recovery?.hint).toContain('workflow_list');
      expect(error.data.recovery?.hint).toContain('temporary drafts are not listed');
      expect(error.data.recovery?.hint).toContain('workflow_create_temp');
      expect((result.content[0] as { text: string }).text).toContain('workflow_create_temp');
    },
  );

  it('renders **Temporary:** yes when temporary flag is present', () => {
    const blocks = workflowGet.format!({
      workflow: {
        name: 'tmp',
        version: '1.0.0',
        description: 'a temp one',
        author: 'bot',
        temporary: true,
        steps: [{ server: 'srv', tool: 'tool' }],
      },
      globalInstructions: null,
      source: 'temp',
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Temporary:** yes');
  });
});
