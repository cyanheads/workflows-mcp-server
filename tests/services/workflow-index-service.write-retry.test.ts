/**
 * @fileoverview Tests that a permanent write survives its category directory being removed
 * between the directory create and the file write — the window a concurrent empty-category
 * cleanup from another process can land in. `node:fs/promises` is wrapped, not stubbed: every
 * call runs the real implementation, and one write is preceded by a real `rm` of its directory.
 * @module tests/services/workflow-index-service.write-retry.test
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const realFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

import * as fs from 'node:fs/promises';
import { WorkflowIndexService } from '@/services/workflow-index/workflow-index-service.js';

describe('WorkflowIndexService.writePermanent — category directory removed mid-write (GH #24)', () => {
  let dir: string;
  let svc: WorkflowIndexService;

  beforeEach(async () => {
    dir = await realFs.mkdtemp(path.join(os.tmpdir(), 'workflows-retry-test-'));
    svc = new WorkflowIndexService(dir, path.join(dir, 'global_instructions.md'), 10);
    await svc.init();
  });

  afterEach(async () => {
    svc.shutdown();
    vi.mocked(fs.writeFile).mockImplementation(realFs.writeFile);
    await realFs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('recreates the directory and retries once when the write fails with ENOENT', async () => {
    const workflowWrites: string[] = [];
    let interfered = false;
    vi.mocked(fs.writeFile).mockImplementation(async (file, data, options) => {
      const target = String(file);
      if (target.endsWith('-workflow.yaml')) {
        workflowWrites.push(target);
        if (!interfered) {
          interfered = true;
          await realFs.rm(path.dirname(target), { recursive: true });
        }
      }
      return realFs.writeFile(file, data, options);
    });

    const filePath = await svc.writePermanent({
      name: 'Retry Probe',
      version: '1.0.0',
      description: 'created while its category is cleaned up',
      author: 'me',
      category: 'contested',
      steps: [{ server: 'srv', tool: 'tool' }],
    });

    expect(workflowWrites).toEqual([filePath, filePath]);
    expect((await realFs.stat(filePath)).isFile()).toBe(true);
    expect(svc.findWorkflow('Retry Probe', '1.0.0')?.filePath).toBe(filePath);
  });
});
