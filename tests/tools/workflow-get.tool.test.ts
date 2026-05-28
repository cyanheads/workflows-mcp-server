/**
 * @fileoverview Tests for workflow_get tool.
 * @module tests/tools/workflow-get.tool.test
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
    await fs.rm(dir, { recursive: true, force: true });
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
    expect(text).toContain('No global_instructions.md');
  });

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
