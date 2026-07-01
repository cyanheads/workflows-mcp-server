/**
 * @fileoverview Tests for workflow_delete tool.
 * @module tests/tools/workflow-delete.tool.test
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

import { workflowDelete } from '@/mcp-server/tools/definitions/workflow-delete.tool.js';
import {
  getWorkflowIndexService,
  WorkflowIndexService,
} from '@/services/workflow-index/workflow-index-service.js';

async function mkTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'wf-delete-test-'));
}

const PERMANENT_WF_YAML = `name: deploy-app
version: "1.0.0"
description: Deploy the application to production
author: ops-team
category: Deployment
steps:
  - server: deploy-server
    tool: run_deploy
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

describe('workflowDelete', () => {
  let dir: string;
  let svc: WorkflowIndexService;

  beforeEach(async () => {
    dir = await mkTmpDir();

    // Two versions of a permanent workflow + one temp workflow.
    const catDir = path.join(dir, 'categories', 'deployment');
    await fs.mkdir(catDir, { recursive: true });
    await fs.writeFile(
      path.join(catDir, 'deploy-app-1-0-0-workflow.yaml'),
      PERMANENT_WF_YAML,
      'utf-8',
    );
    await fs.writeFile(
      path.join(catDir, 'deploy-app-2-0-0-workflow.yaml'),
      PERMANENT_WF_YAML.replace('version: "1.0.0"', 'version: "2.0.0"'),
      'utf-8',
    );

    const tempDir = path.join(dir, 'temp');
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(path.join(tempDir, 'quick-plan-1-0-0-workflow.yaml'), TEMP_WF_YAML, 'utf-8');

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

  it('deletes the latest version when version is omitted', async () => {
    const ctx = createMockContext({ errors: workflowDelete.errors });
    const input = workflowDelete.input.parse({ name: 'deploy-app' });
    const result = await workflowDelete.handler(input, ctx);

    expect(result.status).toBe('deleted');
    expect(result.name).toBe('deploy-app');
    expect(result.version).toBe('2.0.0');

    // Latest is gone; the older version remains.
    expect(svc.index.has('deploy-app@2.0.0')).toBe(false);
    expect(svc.index.has('deploy-app@1.0.0')).toBe(true);
  });

  it('deletes a specific version when requested, leaving other versions intact', async () => {
    const ctx = createMockContext({ errors: workflowDelete.errors });
    const input = workflowDelete.input.parse({ name: 'deploy-app', version: '1.0.0' });
    const result = await workflowDelete.handler(input, ctx);

    expect(result.version).toBe('1.0.0');
    expect(svc.index.has('deploy-app@1.0.0')).toBe(false);
    expect(svc.index.has('deploy-app@2.0.0')).toBe(true);
  });

  it('removes the file from disk and the entry from the index (index consistency)', async () => {
    const targetPath = svc.findWorkflow('deploy-app', '1.0.0')?.filePath;
    expect(targetPath).toBeDefined();
    // File exists before deletion.
    expect((await fs.stat(targetPath as string)).isFile()).toBe(true);

    const ctx = createMockContext({ errors: workflowDelete.errors });
    await workflowDelete.handler(
      workflowDelete.input.parse({ name: 'deploy-app', version: '1.0.0' }),
      ctx,
    );

    // File gone from disk and entry gone from the index.
    await expect(fs.stat(targetPath as string)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(svc.findWorkflow('deploy-app', '1.0.0')).toBeUndefined();
  });

  // --- error paths ---

  it('throws not_found when the name does not exist', async () => {
    const ctx = createMockContext({ errors: workflowDelete.errors });
    const input = workflowDelete.input.parse({ name: 'nonexistent-wf' });
    await expect(workflowDelete.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
  });

  it('throws not_found when the name exists but the version does not', async () => {
    const ctx = createMockContext({ errors: workflowDelete.errors });
    const input = workflowDelete.input.parse({ name: 'deploy-app', version: '99.0.0' });
    await expect(workflowDelete.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
    });
    // A failed delete leaves the index untouched.
    expect(svc.index.has('deploy-app@1.0.0')).toBe(true);
    expect(svc.index.has('deploy-app@2.0.0')).toBe(true);
  });

  it('rejects deleting a temporary workflow with temp_not_allowed', async () => {
    const ctx = createMockContext({ errors: workflowDelete.errors });
    const input = workflowDelete.input.parse({ name: 'quick-plan' });
    await expect(workflowDelete.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'temp_not_allowed' },
    });
    // The temp workflow is still indexed — nothing was removed.
    expect(svc.index.has('quick-plan@1.0.0')).toBe(true);
  });

  it('throws index_unavailable when the service is not ready', async () => {
    Object.defineProperty(svc, '_ready', { value: false, writable: true });
    const ctx = createMockContext({ errors: workflowDelete.errors });
    const input = workflowDelete.input.parse({ name: 'deploy-app' });
    await expect(workflowDelete.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'index_unavailable' },
    });
  });

  it('maps a raw filesystem error to delete_failed and strips the file path', async () => {
    const ctx = createMockContext({ errors: workflowDelete.errors });
    vi.spyOn(svc, 'deleteWorkflow').mockRejectedValueOnce(
      new Error("EACCES: permission denied, unlink '/abs/secret/deploy-app.yaml'"),
    );
    const input = workflowDelete.input.parse({ name: 'deploy-app', version: '1.0.0' });
    const err = await workflowDelete.handler(input, ctx).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      data: { reason: 'delete_failed' },
    });
    // The absolute path must not leak into the client-visible message.
    expect((err as Error).message).not.toContain('/abs/secret/');
  });

  // --- format ---

  it('formats output with status, name, and version', () => {
    const blocks = workflowDelete.format!({
      status: 'deleted',
      name: 'deploy-app',
      version: '2.0.0',
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Workflow Deleted');
    expect(text).toContain('deploy-app');
    expect(text).toContain('2.0.0');
  });
});
