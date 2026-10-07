/**
 * @fileoverview Tests for workflow_delete tool.
 * @module tests/tools/workflow-delete.tool.test
 */

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isInputRequiredSignal } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  expectInputRequired,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/workflow-index/workflow-index-service.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/services/workflow-index/workflow-index-service.js')>();
  return {
    ...actual,
    getWorkflowIndexService: vi.fn(),
  };
});

import { workflowCreate } from '@/mcp-server/tools/definitions/workflow-create.tool.js';
import { workflowCreateTemp } from '@/mcp-server/tools/definitions/workflow-create-temp.tool.js';
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

type DeleteInput = { name: string; version?: string };

/** The answers a user can give the confirmation prompt. */
const ACCEPT = { action: 'accept', content: { confirm: true } } as const;
const ACCEPT_FALSE = { action: 'accept', content: { confirm: false } } as const;
const DECLINE = { action: 'decline' } as const;
const CANCEL = { action: 'cancel' } as const;

/** First round: the input_required result workflow_delete returns before touching anything. */
function askToDelete(input: DeleteInput) {
  return expectInputRequired(() =>
    workflowDelete.handler(
      workflowDelete.input.parse(input),
      createMockContext({ errors: workflowDelete.errors }),
    ),
  );
}

/** A second round through the handler, carrying `answer` and the given request state. */
async function answerRound(input: DeleteInput, answer: unknown, requestState: unknown) {
  return workflowDelete.handler(
    workflowDelete.input.parse(input),
    createMockContext({
      errors: workflowDelete.errors,
      inputResponses: { confirm: answer },
      requestState,
    }),
  );
}

/** Both rounds through the handler: ask, then answer with `answer` (accept + confirm by default). */
async function deleteConfirmed(input: DeleteInput, answer: unknown = ACCEPT) {
  const asked = await askToDelete(input);
  return answerRound(input, answer, asked.requestState);
}

/** Both rounds, the second through the tool's public contract (structuredContent + content). */
async function deleteConfirmedContract(input: DeleteInput) {
  const asked = await askToDelete(input);
  return runToolContract(workflowDelete, input, {
    context: { inputResponses: { confirm: ACCEPT }, requestState: asked.requestState },
  });
}

/** The elicitation form a first round asked the user to fill in. */
function elicitation(asked: Awaited<ReturnType<typeof askToDelete>>) {
  return asked.inputRequests?.confirm as {
    method: string;
    params: {
      message: string;
      requestedSchema: { properties: Record<string, { type: string }>; required?: string[] };
    };
  };
}

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
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  /** Any write rebuilds the index — used to pick up a hand edit made between rounds. */
  async function rebuildIndex() {
    await svc.writeTemp({
      name: 'rebuild-trigger',
      version: '1.0.0',
      description: 'x',
      author: 'agent',
      temporary: true,
      steps: [{ server: 's', tool: 't' }],
    });
  }

  // --- happy paths ---

  it('deletes the latest version when version is omitted', async () => {
    const result = await deleteConfirmed({ name: 'deploy-app' });

    expect(result.status).toBe('deleted');
    expect(result.name).toBe('deploy-app');
    expect(result.version).toBe('2.0.0');

    // Latest is gone; the older version remains.
    expect(svc.index.has('deploy-app@2.0.0')).toBe(false);
    expect(svc.index.has('deploy-app@1.0.0')).toBe(true);
  });

  it('deletes a specific version when requested, leaving other versions intact', async () => {
    const result = await deleteConfirmed({ name: 'deploy-app', version: '1.0.0' });

    expect(result.version).toBe('1.0.0');
    expect(svc.index.has('deploy-app@1.0.0')).toBe(false);
    expect(svc.index.has('deploy-app@2.0.0')).toBe(true);
  });

  it('removes the file from disk and the entry from the index (index consistency)', async () => {
    const targetPath = svc.findWorkflow('deploy-app', '1.0.0')?.filePath;
    expect(targetPath).toBeDefined();
    // File exists before deletion.
    expect((await fs.stat(targetPath as string)).isFile()).toBe(true);

    await deleteConfirmed({ name: 'deploy-app', version: '1.0.0' });

    // File gone from disk and entry gone from the index.
    await expect(fs.stat(targetPath as string)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(svc.findWorkflow('deploy-app', '1.0.0')).toBeUndefined();
  });

  it('removes the category directory once its last workflow is deleted (GH #24)', async () => {
    const categoryDir = path.join(dir, 'categories', 'deployment');

    const first = await deleteConfirmedContract({ name: 'deploy-app', version: '2.0.0' });
    expect(first.structuredContent).toEqual({
      status: 'deleted',
      name: 'deploy-app',
      version: '2.0.0',
      source: 'permanent',
    });
    expect((await fs.stat(categoryDir)).isDirectory()).toBe(true);

    const last = await deleteConfirmedContract({ name: 'deploy-app', version: '1.0.0' });
    expect(last.structuredContent).toEqual({
      status: 'deleted',
      name: 'deploy-app',
      version: '1.0.0',
      source: 'permanent',
    });
    expect((last.content[0] as { text: string }).text).toContain('**Version:** 1.0.0');
    await expect(fs.stat(categoryDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(path.join(dir, 'categories'))).isDirectory()).toBe(true);
    expect((await fs.stat(path.join(dir, 'temp'))).isDirectory()).toBe(true);
  });

  // --- confirmation round (GH #17) ---

  it('asks for confirmation on the first round, naming the target, and touches nothing (GH #17)', async () => {
    const targetPath = svc.findWorkflow('deploy-app', '2.0.0')?.filePath as string;

    const asked = await askToDelete({ name: 'deploy-app' });
    const request = elicitation(asked);

    expect(request.method).toBe('elicitation/create');
    expect(request.params.message).toContain('deploy-app@2.0.0');
    expect(request.params.message).toContain('permanent');
    expect(request.params.message).toContain(
      path.join('categories', 'deployment', 'deploy-app-2-0-0-workflow.yaml'),
    );
    // The path is relative to the workflows root — the absolute root never reaches the prompt.
    expect(request.params.message).not.toContain(dir);
    expect(request.params.requestedSchema.properties.confirm?.type).toBe('boolean');
    expect(request.params.requestedSchema.required).toEqual(['confirm']);
    expect(asked.requestState).toEqual(expect.any(String));
    expect(asked.requestState).not.toContain(dir);

    expect((await fs.stat(targetPath)).isFile()).toBe(true);
    expect(svc.index.has('deploy-app@1.0.0')).toBe(true);
    expect(svc.index.has('deploy-app@2.0.0')).toBe(true);
    expect(svc.index.has('quick-plan@1.0.0')).toBe(true);
  });

  it.each([
    ['exact version', { name: 'deploy-app', version: '1.0.0' }, 'deploy-app@1.0.0', 'permanent'],
    ['omitted version', { name: 'deploy-app' }, 'deploy-app@2.0.0', 'permanent'],
    ['temporary draft', { name: 'quick-plan' }, 'quick-plan@1.0.0', 'temp'],
  ])(
    'gates a delete by %s behind the confirmation round (GH #17, #18)',
    async (_label, input, key, source) => {
      const deleteWorkflow = vi.spyOn(svc, 'deleteWorkflow');

      const asked = await askToDelete(input);

      expect(elicitation(asked).params.message).toContain(key);
      expect(elicitation(asked).params.message).toContain(`(${source})`);
      expect(deleteWorkflow).not.toHaveBeenCalled();
      expect(svc.index.has(key)).toBe(true);
    },
  );

  it.each([
    ['confirm: false', ACCEPT_FALSE],
    ['decline', DECLINE],
    ['cancel', CANCEL],
    [
      'an accept whose content is not { confirm: boolean }',
      { action: 'accept', content: { confirm: 'yes' } },
    ],
  ])(
    'fails with cancelled on %s, deletes nothing, and never asks again (GH #17)',
    async (_label, answer) => {
      const deleteWorkflow = vi.spyOn(svc, 'deleteWorkflow');

      const err = await deleteConfirmed({ name: 'deploy-app' }, answer).catch((e: unknown) => e);

      expect(isInputRequiredSignal(err)).toBe(false);
      expect(err).toMatchObject({
        code: JsonRpcErrorCode.InvalidRequest,
        data: { reason: 'cancelled' },
      });
      expect(deleteWorkflow).not.toHaveBeenCalled();
      expect(svc.index.has('deploy-app@2.0.0')).toBe(true);
    },
  );

  it('reports cancelled on both surfaces with its recovery hint (GH #17)', async () => {
    const asked = await askToDelete({ name: 'deploy-app' });
    const result = await runToolContract(
      workflowDelete,
      { name: 'deploy-app' },
      { context: { inputResponses: { confirm: DECLINE }, requestState: asked.requestState } },
    );

    expect(result.isError).toBe(true);
    const { error } = result.structuredContent as {
      error: { code: number; data: { reason: string; recovery?: { hint: string } } };
    };
    expect(error.code).toBe(JsonRpcErrorCode.InvalidRequest);
    expect(error.data.reason).toBe('cancelled');
    expect(error.data.recovery?.hint).toBeTruthy();
    expect((result.content[0] as { text: string }).text).toContain('cancelled');
    expect(svc.index.has('deploy-app@2.0.0')).toBe(true);
  });

  it('refuses with target_changed when a higher version appears between rounds (GH #17)', async () => {
    const asked = await askToDelete({ name: 'deploy-app' });
    await svc.writePermanent({
      name: 'deploy-app',
      version: '3.0.0',
      description: 'newer',
      author: 'ops-team',
      category: 'Deployment',
      steps: [{ server: 'deploy-server', tool: 'run_deploy' }],
    });

    const err = await answerRound({ name: 'deploy-app' }, ACCEPT, asked.requestState).catch(
      (e: unknown) => e,
    );

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.Conflict,
      data: { reason: 'target_changed' },
    });
    expect(svc.findByName('deploy-app')).toHaveLength(3);
  });

  it('refuses with target_changed when the same key resolves to a different file between rounds (GH #17)', async () => {
    const asked = await askToDelete({ name: 'deploy-app', version: '1.0.0' });
    const original = svc.findWorkflow('deploy-app', '1.0.0')?.filePath as string;
    const movedDir = path.join(dir, 'categories', 'archive');
    const moved = path.join(movedDir, path.basename(original));
    await fs.mkdir(movedDir, { recursive: true });
    await fs.rename(original, moved);
    await rebuildIndex();
    expect(svc.findWorkflow('deploy-app', '1.0.0')?.filePath).toBe(moved);

    const err = await answerRound(
      { name: 'deploy-app', version: '1.0.0' },
      ACCEPT,
      asked.requestState,
    ).catch((e: unknown) => e);

    expect(err).toMatchObject({ data: { reason: 'target_changed' } });
    expect((await fs.stat(moved)).isFile()).toBe(true);
  });

  it.each([
    ['no request state', undefined],
    ['unparseable request state', 'not json'],
    ['request state naming another workflow', JSON.stringify({ name: 'x', version: '1.0.0' })],
  ])(
    'refuses with confirmation_invalid on an accepted round carrying %s (GH #17)',
    async (_label, requestState) => {
      const err = await answerRound({ name: 'deploy-app' }, ACCEPT, requestState).catch(
        (e: unknown) => e,
      );

      expect(err).toMatchObject({ data: { reason: 'confirmation_invalid' } });
      expect(svc.index.has('deploy-app@2.0.0')).toBe(true);
    },
  );

  // --- no delete without a server-issued prompt ---

  it.each([
    [
      'a well-formed target the server never issued',
      () =>
        JSON.stringify({
          name: 'deploy-app',
          version: '2.0.0',
          source: 'permanent',
          path: path.join('categories', 'deployment', 'deploy-app-2-0-0-workflow.yaml'),
        }),
    ],
    ['a well-formed confirmation id the server never issued', () => randomUUID()],
    ['no request state at all', () => undefined],
  ])(
    'deletes nothing when the very first call carries an accepted answer and %s',
    async (_label, forgedState) => {
      const targetPath = svc.findWorkflow('deploy-app', '2.0.0')?.filePath as string;
      const deleteWorkflow = vi.spyOn(svc, 'deleteWorkflow');

      const result = await runToolContract(
        workflowDelete,
        { name: 'deploy-app', version: '2.0.0' },
        { context: { inputResponses: { confirm: ACCEPT }, requestState: forgedState() } },
      );

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as {
        error: { code: number; data: { reason: string; recovery?: { hint: string } } };
      };
      expect(error.code).toBe(JsonRpcErrorCode.InvalidRequest);
      expect(error.data.reason).toBe('confirmation_invalid');
      expect(error.data.recovery?.hint).toContain('Call workflow_delete again');
      expect((result.content[0] as { text: string }).text).toContain('nothing was deleted');
      expect(deleteWorkflow).not.toHaveBeenCalled();
      expect((await fs.stat(targetPath)).isFile()).toBe(true);
      expect(svc.index.has('deploy-app@2.0.0')).toBe(true);
    },
  );

  it('carries only an opaque confirmation id in requestState, never the target', async () => {
    const asked = await askToDelete({ name: 'deploy-app', version: '2.0.0' });

    expect(asked.requestState).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(asked.requestState).not.toContain('deploy-app');
  });

  it('refuses a verbatim replay of a used confirmation after the same key is recreated', async () => {
    const input = { name: 'deploy-app', version: '2.0.0' };
    const targetPath = svc.findWorkflow('deploy-app', '2.0.0')?.filePath as string;
    const content = await fs.readFile(targetPath, 'utf-8');

    const asked = await askToDelete(input);
    await expect(answerRound(input, ACCEPT, asked.requestState)).resolves.toMatchObject({
      status: 'deleted',
    });

    // Recreate the identical file at the identical path, then replay the round verbatim.
    await fs.writeFile(targetPath, content, 'utf-8');
    await rebuildIndex();
    expect(svc.findWorkflow('deploy-app', '2.0.0')?.filePath).toBe(targetPath);

    const err = await answerRound(input, ACCEPT, asked.requestState).catch((e: unknown) => e);

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.InvalidRequest,
      data: { reason: 'confirmation_invalid' },
    });
    expect(await fs.readFile(targetPath, 'utf-8')).toBe(content);
  });

  it('spends the confirmation on a declined answer, so a later accept of it deletes nothing', async () => {
    const asked = await askToDelete({ name: 'deploy-app' });
    await expect(
      answerRound({ name: 'deploy-app' }, DECLINE, asked.requestState),
    ).rejects.toMatchObject({ data: { reason: 'cancelled' } });

    const err = await answerRound({ name: 'deploy-app' }, ACCEPT, asked.requestState).catch(
      (e: unknown) => e,
    );

    expect(err).toMatchObject({ data: { reason: 'confirmation_invalid' } });
    expect(svc.index.has('deploy-app@2.0.0')).toBe(true);
  });

  // --- the confirmation is bound to the caller it was issued to ---

  describe('caller binding', () => {
    const input = { name: 'deploy-app', version: '2.0.0' };
    const ALICE = { clientId: 'client-a', sub: 'alice', scopes: [] };
    const ASKED = { auth: ALICE, tenantId: 'tenant-a' };

    /** One round of the handler under the given caller, answering when `answer` is given. */
    function roundAs(
      caller: { auth?: typeof ALICE; tenantId?: string },
      answer?: { requestState?: unknown },
    ) {
      return Promise.resolve(
        workflowDelete.handler(
          workflowDelete.input.parse(input),
          createMockContext({
            errors: workflowDelete.errors,
            ...caller,
            ...(answer && {
              inputResponses: { confirm: ACCEPT },
              requestState: answer.requestState,
            }),
          }),
        ),
      );
    }

    it('deletes when the caller who was asked answers', async () => {
      const asked = await expectInputRequired(() => roundAs(ASKED));

      await expect(roundAs(ASKED, asked)).resolves.toMatchObject({
        status: 'deleted',
        version: '2.0.0',
      });
      expect(svc.index.has('deploy-app@2.0.0')).toBe(false);
    });

    it.each([
      [
        'another subject of the same client',
        { auth: { ...ALICE, sub: 'bob' }, tenantId: 'tenant-a' },
      ],
      ['another client', { auth: { ...ALICE, clientId: 'client-b' }, tenantId: 'tenant-a' }],
      ['another tenant', { auth: ALICE, tenantId: 'tenant-b' }],
      ['an unauthenticated caller', { tenantId: 'tenant-a' }],
    ])(
      'refuses with confirmation_invalid when %s answers, deletes nothing, and spends the prompt',
      async (_label, other) => {
        const deleteWorkflow = vi.spyOn(svc, 'deleteWorkflow');
        const asked = await expectInputRequired(() => roundAs(ASKED));

        await expect(roundAs(other, asked)).rejects.toMatchObject({
          code: JsonRpcErrorCode.InvalidRequest,
          data: { reason: 'confirmation_invalid' },
        });
        // The other caller's round redeemed the record, so the asked caller's answer is refused too.
        await expect(roundAs(ASKED, asked)).rejects.toMatchObject({
          data: { reason: 'confirmation_invalid' },
        });
        expect(deleteWorkflow).not.toHaveBeenCalled();
        expect(svc.index.has('deploy-app@2.0.0')).toBe(true);
      },
    );
  });

  describe('confirmation expiry', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('deletes on an answer just inside the 600 s window', async () => {
      const asked = await askToDelete({ name: 'deploy-app' });
      vi.setSystemTime(Date.now() + 599_999);

      await expect(
        answerRound({ name: 'deploy-app' }, ACCEPT, asked.requestState),
      ).resolves.toMatchObject({ status: 'deleted', version: '2.0.0' });
    });

    it('refuses an answer that arrives at the end of the 600 s window and deletes nothing', async () => {
      const asked = await askToDelete({ name: 'deploy-app' });
      vi.setSystemTime(Date.now() + 600_000);

      const err = await answerRound({ name: 'deploy-app' }, ACCEPT, asked.requestState).catch(
        (e: unknown) => e,
      );

      expect(err).toMatchObject({ data: { reason: 'confirmation_invalid' } });
      expect(svc.index.has('deploy-app@2.0.0')).toBe(true);
    });
  });

  // --- the confirmed file's path and content ---

  it('refuses with target_changed when the same key is recreated with new content at the same path', async () => {
    const input = { name: 'deploy-app', version: '1.0.0' };
    const targetPath = svc.findWorkflow('deploy-app', '1.0.0')?.filePath as string;
    const asked = await askToDelete(input);

    const replacement = PERMANENT_WF_YAML.replace(
      'Deploy the application to production',
      'Replaced while the prompt was open',
    );
    await fs.unlink(targetPath);
    await fs.writeFile(targetPath, replacement, 'utf-8');
    await rebuildIndex();
    expect(svc.findWorkflow('deploy-app', '1.0.0')?.filePath).toBe(targetPath);

    const err = await answerRound(input, ACCEPT, asked.requestState).catch((e: unknown) => e);

    expect(err).toMatchObject({
      code: JsonRpcErrorCode.Conflict,
      data: { reason: 'target_changed' },
    });
    const message = (err as Error).message;
    expect(message).toContain(path.relative(dir, targetPath));
    expect(message).toContain('content changed');
    expect(message).not.toContain(dir);
    expect(await fs.readFile(targetPath, 'utf-8')).toBe(replacement);
  });

  it('refuses with target_changed when workflow_create_temp overwrites the draft during the prompt', async () => {
    const draftPath = svc.findWorkflow('quick-plan', '1.0.0')?.filePath as string;
    const asked = await askToDelete({ name: 'quick-plan' });

    const overwrite = await workflowCreateTemp.handler(
      workflowCreateTemp.input.parse({
        name: 'quick-plan',
        version: '1.0.0',
        description: 'Overwritten while the prompt was open',
        author: 'agent',
        steps: [{ server: 'my-server', tool: 'do_thing' }],
      }),
      createMockContext({ errors: workflowCreateTemp.errors }),
    );
    expect(overwrite).toMatchObject({ status: 'overwritten', filePath: draftPath });

    const err = await answerRound({ name: 'quick-plan' }, ACCEPT, asked.requestState).catch(
      (e: unknown) => e,
    );

    expect(err).toMatchObject({ data: { reason: 'target_changed' } });
    expect(await fs.readFile(draftPath, 'utf-8')).toContain(
      'Overwritten while the prompt was open',
    );
  });

  it('names both relative paths when only the file behind the key moved', async () => {
    const input = { name: 'deploy-app', version: '1.0.0' };
    const asked = await askToDelete(input);
    const original = svc.findWorkflow('deploy-app', '1.0.0')?.filePath as string;
    const moved = path.join(dir, 'categories', 'archive', path.basename(original));
    await fs.mkdir(path.dirname(moved), { recursive: true });
    await fs.rename(original, moved);
    await rebuildIndex();

    const err = await answerRound(input, ACCEPT, asked.requestState).catch((e: unknown) => e);

    expect(err).toMatchObject({ data: { reason: 'target_changed' } });
    const message = (err as Error).message;
    expect(message).toContain(path.relative(dir, moved));
    expect(message).toContain(path.relative(dir, original));
    expect(message).not.toContain('not the deploy-app@1.0.0 (permanent) that was confirmed');
    expect(message).not.toContain(dir);
  });

  // --- a key another file still declares (GH #32) ---

  it('returns a notice naming the file now indexed under the key when another copy declares it (GH #32)', async () => {
    const copyDir = path.join(dir, 'categories', 'archive');
    await fs.mkdir(copyDir, { recursive: true });
    await fs.writeFile(
      path.join(copyDir, 'deploy-app-copy.yaml'),
      PERMANENT_WF_YAML.replace('Deploy the application to production', 'The archived copy'),
      'utf-8',
    );
    await rebuildIndex();
    const indexed = svc.findWorkflow('deploy-app', '1.0.0')?.filePath as string;
    const other = [
      path.join(copyDir, 'deploy-app-copy.yaml'),
      path.join(dir, 'categories', 'deployment', 'deploy-app-1-0-0-workflow.yaml'),
    ].find((p) => p !== indexed) as string;

    const result = await deleteConfirmedContract({ name: 'deploy-app', version: '1.0.0' });

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { status: string; notice?: string };
    expect(structured.status).toBe('deleted');
    expect(structured.notice).toContain('deploy-app@1.0.0');
    expect(structured.notice).toContain(path.relative(dir, other));
    expect(structured.notice).not.toContain(dir);
    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).toContain(path.relative(dir, other));
    await expect(fs.stat(indexed)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(svc.findWorkflow('deploy-app', '1.0.0')?.filePath).toBe(other);
  });

  it('names a shadowed draft that takes over the key after its permanent copy is deleted (GH #32)', async () => {
    const draftPath = path.join(dir, 'temp', 'deploy-app-draft.yaml');
    await fs.writeFile(
      draftPath,
      PERMANENT_WF_YAML.replace('version: "1.0.0"', 'version: "2.0.0"'),
      'utf-8',
    );
    await rebuildIndex();
    expect(svc.findWorkflow('deploy-app', '2.0.0')?.isTemp).toBe(false);

    const result = await deleteConfirmedContract({ name: 'deploy-app', version: '2.0.0' });

    const structured = result.structuredContent as { source: string; notice?: string };
    expect(structured.source).toBe('permanent');
    expect(structured.notice).toContain(path.join('temp', 'deploy-app-draft.yaml'));
    expect(svc.findWorkflow('deploy-app', '2.0.0')).toMatchObject({
      isTemp: true,
      filePath: draftPath,
    });
  });

  it('carries no notice when the deleted key no longer resolves (GH #32)', async () => {
    const result = await deleteConfirmedContract({ name: 'deploy-app', version: '1.0.0' });

    expect(result.structuredContent).not.toHaveProperty('notice');
    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).not.toContain('still');
    expect(svc.findWorkflow('deploy-app', '1.0.0')).toBeUndefined();
  });

  // --- name input (GH #33) ---

  it('trims a padded name before resolving it, on both rounds (GH #33)', async () => {
    const result = await deleteConfirmedContract({ name: '  deploy-app  ', version: '1.0.0' });

    expect(result.structuredContent).toEqual({
      status: 'deleted',
      name: 'deploy-app',
      version: '1.0.0',
      source: 'permanent',
    });
    expect(svc.index.has('deploy-app@1.0.0')).toBe(false);
    expect(svc.index.has('deploy-app@2.0.0')).toBe(true);
  });

  it.each(['', '   '])(
    'rejects the blank name %j as invalid arguments and deletes nothing (GH #33)',
    async (name) => {
      const result = await runToolContract(workflowDelete, { name });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
      });
      expect((result.content[0] as { text: string }).text).toContain('name');
      expect(svc.index.size).toBe(3);
    },
  );

  it('asks again when the round carries no confirmation response, rather than deleting (GH #17)', async () => {
    const err = await Promise.resolve(
      workflowDelete.handler(
        workflowDelete.input.parse({ name: 'deploy-app' }),
        createMockContext({ errors: workflowDelete.errors, requestState: 'stale' }),
      ),
    ).catch((e: unknown) => e);

    expect(isInputRequiredSignal(err)).toBe(true);
    expect(svc.index.has('deploy-app@2.0.0')).toBe(true);
  });

  // --- temporary drafts (GH #18) ---

  it('deletes a temporary draft and reports source temp on both surfaces (GH #18)', async () => {
    const draftPath = svc.findWorkflow('quick-plan', '1.0.0')?.filePath as string;

    const result = await deleteConfirmedContract({ name: 'quick-plan' });

    expect(result.structuredContent).toEqual({
      status: 'deleted',
      name: 'quick-plan',
      version: '1.0.0',
      source: 'temp',
    });
    expect((result.content[0] as { text: string }).text).toContain('**Source:** temp');
    await expect(fs.stat(draftPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(svc.index.has('quick-plan@1.0.0')).toBe(false);
    // temp/ itself is never removed, even once empty.
    expect(await fs.readdir(path.join(dir, 'temp'))).toEqual([]);
  });

  it('deletes the temp draft when it is the highest version across sources (GH #18)', async () => {
    await svc.writeTemp({
      name: 'deploy-app',
      version: '3.0.0',
      description: 'draft',
      author: 'agent',
      temporary: true,
      steps: [{ server: 'deploy-server', tool: 'run_deploy' }],
    });

    const result = await deleteConfirmed({ name: 'deploy-app' });

    expect(result).toEqual({
      status: 'deleted',
      name: 'deploy-app',
      version: '3.0.0',
      source: 'temp',
    });
    expect(svc.index.has('deploy-app@2.0.0')).toBe(true);
    expect(svc.index.has('deploy-app@1.0.0')).toBe(true);
  });

  it('promotes a draft: delete it, then workflow_create of the same key succeeds (GH #17, #18)', async () => {
    const draft = {
      name: 'Promote Me',
      version: '1.0.0',
      description: 'Draft to promote',
      author: 'agent',
      steps: [{ server: 'srv', tool: 'run' }],
    };
    await workflowCreateTemp.handler(
      workflowCreateTemp.input.parse(draft),
      createMockContext({ errors: workflowCreateTemp.errors }),
    );
    const blocked = await runToolContract(workflowCreate, { ...draft, category: 'Promoted' });
    expect(blocked.isError).toBe(true);

    const deleted = await deleteConfirmed({ name: 'Promote Me', version: '1.0.0' });
    expect(deleted.source).toBe('temp');

    const created = await runToolContract(workflowCreate, { ...draft, category: 'Promoted' });
    expect(created.isError).toBeFalsy();
    expect(svc.findWorkflow('Promote Me', '1.0.0')?.isTemp).toBe(false);
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

  it('throws not_found on the confirming round when the target was removed in between (GH #17)', async () => {
    const asked = await askToDelete({ name: 'deploy-app', version: '1.0.0' });
    await fs.unlink(svc.findWorkflow('deploy-app', '1.0.0')?.filePath as string);
    await rebuildIndex();

    await expect(
      answerRound({ name: 'deploy-app', version: '1.0.0' }, ACCEPT, asked.requestState),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.NotFound, data: { reason: 'not_found' } });
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
    const input = { name: 'deploy-app', version: '1.0.0' };
    const asked = await askToDelete(input);
    vi.spyOn(svc, 'deleteWorkflow').mockRejectedValueOnce(
      new Error("EACCES: permission denied, unlink '/abs/secret/deploy-app.yaml'"),
    );
    const err = await answerRound(input, ACCEPT, asked.requestState).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      data: { reason: 'delete_failed' },
    });
    // The absolute path must not leak into the client-visible message.
    expect((err as Error).message).not.toContain('/abs/secret/');
  });

  it('reports delete_failed without the path when the first round cannot read the file', async () => {
    const targetPath = svc.findWorkflow('deploy-app', '1.0.0')?.filePath as string;
    await fs.chmod(targetPath, 0o000);
    try {
      const result = await runToolContract(workflowDelete, {
        name: 'deploy-app',
        version: '1.0.0',
      });

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as {
        error: { code: number; message: string; data: { reason: string } };
      };
      expect(error.code).toBe(JsonRpcErrorCode.InternalError);
      expect(error.data.reason).toBe('delete_failed');
      expect(error.message).toBe(
        'Failed to read workflow for confirmation: EACCES: permission denied',
      );
      expect((result.content[0] as { text: string }).text).not.toContain(dir);
    } finally {
      await fs.chmod(targetPath, 0o644);
    }
    expect(svc.index.has('deploy-app@1.0.0')).toBe(true);
  });

  it('strips a file path containing a quote from delete_failed', async () => {
    const input = { name: 'deploy-app', version: '1.0.0' };
    const asked = await askToDelete(input);
    vi.spyOn(svc, 'deleteWorkflow').mockRejectedValueOnce(
      new Error("EACCES: permission denied, unlink '/abs/Casey's vault/deploy-app.yaml'"),
    );

    const err = await answerRound(input, ACCEPT, asked.requestState).catch((e: unknown) => e);

    expect(err).toMatchObject({ data: { reason: 'delete_failed' } });
    expect((err as Error).message).toBe('Failed to delete workflow: EACCES: permission denied');
  });

  // --- version input (GH #16, #26) ---

  it('treats an empty-string version as omitted and deletes the latest', async () => {
    const result = await deleteConfirmed({ name: 'deploy-app', version: '' });
    expect(result.version).toBe('2.0.0');
    expect(svc.index.has('deploy-app@1.0.0')).toBe(true);
  });

  it.each(['not-semver', '2.0', '   '])(
    'rejects non-semver version %j as invalid arguments and deletes nothing (GH #16)',
    async (version) => {
      const deleteWorkflow = vi.spyOn(svc, 'deleteWorkflow');
      const result = await runToolContract(workflowDelete, { name: 'deploy-app', version });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
      });
      expect(deleteWorkflow).not.toHaveBeenCalled();
      expect(svc.index.has('deploy-app@1.0.0')).toBe(true);
      expect(svc.index.has('deploy-app@2.0.0')).toBe(true);
    },
  );

  it.each([
    ['v1.0.0', '1.0.0'],
    [' 1.0.0 ', '1.0.0'],
    ['1.0.0+build.5', '1.0.0'],
  ])(
    'canonicalizes the tolerated spelling %j before deleting (GH #16)',
    async (version, canonical) => {
      const result = await deleteConfirmedContract({ name: 'deploy-app', version });

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ status: 'deleted', version: canonical });
      expect((result.content[0] as { text: string }).text).toContain(`**Version:** ${canonical}`);
      expect(svc.index.has(`deploy-app@${canonical}`)).toBe(false);
      expect(svc.index.has('deploy-app@2.0.0')).toBe(true);
    },
  );

  it('reports not_found with the canonical version for a tolerated spelling that is absent', async () => {
    const ctx = createMockContext({ errors: workflowDelete.errors });
    const input = workflowDelete.input.parse({ name: 'deploy-app', version: 'v99.0.0' });
    await expect(workflowDelete.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found' },
      message: 'No indexed workflow "deploy-app@99.0.0"',
    });
  });

  // --- format ---

  it('formats output with status, name, and version', () => {
    const blocks = workflowDelete.format!({
      status: 'deleted',
      name: 'deploy-app',
      version: '2.0.0',
      source: 'permanent',
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Workflow Deleted');
    expect(text).toContain('deploy-app');
    expect(text).toContain('2.0.0');
  });

  it('formats the source of the deleted workflow (GH #18)', () => {
    for (const source of ['permanent', 'temp'] as const) {
      const blocks = workflowDelete.format!({
        status: 'deleted',
        name: 'deploy-app',
        version: '2.0.0',
        source,
      });
      expect((blocks[0] as { text: string }).text).toContain(`**Source:** ${source}`);
    }
  });
});
