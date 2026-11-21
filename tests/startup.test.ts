/**
 * @fileoverview Process-level tests for startup before the stdio transport opens.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';

const projectDir = fileURLToPath(new URL('../', import.meta.url));
let scratch: string;

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'workflows-startup-'));
  fs.symlinkSync(path.join(projectDir, 'node_modules'), path.join(scratch, 'node_modules'));
  execFileSync('bun', [
    'build',
    path.join(projectDir, 'src/index.ts'),
    '--target=node',
    '--packages=external',
    '--outfile',
    path.join(scratch, 'server.mjs'),
  ]);
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

function runServer(workflowsDir: string) {
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'startup-test', version: '1' },
    },
  };
  return spawnSync(process.execPath, [path.join(scratch, 'server.mjs')], {
    cwd: projectDir,
    env: {
      ...process.env,
      MCP_TRANSPORT_TYPE: 'stdio',
      WORKFLOWS_DIR: path.relative(projectDir, workflowsDir),
      LOGS_DIR: path.join(scratch, 'logs'),
    },
    input: `${JSON.stringify(initialize)}\n`,
    encoding: 'utf-8',
    timeout: 3_000,
  });
}

it('fails startup with a resolved WORKFLOWS_DIR diagnostic before opening stdio', () => {
  const file = path.join(scratch, 'blocker');
  fs.writeFileSync(file, '');
  const workflowsDir = path.join(file, 'workflows');
  const child = runServer(workflowsDir);

  expect(child.error).toBeUndefined();
  expect(child.status).toBe(1);
  expect(child.stdout).toBe('');
  expect(child.stderr).toContain('WORKFLOWS_DIR');
  expect(child.stderr).toContain(workflowsDir);
});

it.each(['existing', 'missing'])(
  'opens stdio with an empty index for an %s workflows root',
  (state) => {
    const workflowsDir = path.join(scratch, state, 'workflows');
    if (state === 'existing') fs.mkdirSync(workflowsDir, { recursive: true });

    const child = runServer(workflowsDir);
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { serverInfo: { name: 'workflows-mcp-server' } },
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(workflowsDir, '_index.json'), 'utf-8')),
    ).toMatchObject({
      count: 0,
      entries: {},
    });
  },
);
