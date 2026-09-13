/**
 * @fileoverview Installer environment values resolve through the server config boundary.
 * @module tests/config/server-config.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('server environment configuration', () => {
  it.each(['', `\${user_config.WORKFLOWS_DIR}`, undefined])(
    'uses defaults for unset installer values (%s)',
    async (value) => {
      vi.stubEnv('WORKFLOWS_DIR', value);
      vi.stubEnv('GLOBAL_INSTRUCTIONS_PATH', value);
      vi.stubEnv('WATCHER_DEBOUNCE_MS', value);
      const { getServerConfig } = await import('@/config/server-config.js');
      expect(getServerConfig()).toEqual({
        workflowsDir: './workflows-yaml',
        globalInstructionsPath: '',
        watcherDebounceMs: 500,
      });
    },
  );

  it('keeps explicit values and embedded placeholder text', async () => {
    vi.stubEnv('WORKFLOWS_DIR', `/tmp/workflows-\${team}`);
    vi.stubEnv('GLOBAL_INSTRUCTIONS_PATH', '/tmp/instructions.md');
    vi.stubEnv('WATCHER_DEBOUNCE_MS', '0');
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(getServerConfig()).toEqual({
      workflowsDir: `/tmp/workflows-\${team}`,
      globalInstructionsPath: '/tmp/instructions.md',
      watcherDebounceMs: 0,
    });
  });

  it('rejects a nonnumeric debounce value', async () => {
    vi.stubEnv('WATCHER_DEBOUNCE_MS', 'invalid');
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(() => getServerConfig()).toThrow();
  });
});
