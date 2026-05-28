/**
 * @fileoverview Server-specific environment configuration for workflows-mcp-server.
 * @module config/server-config
 */

import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  workflowsDir: z
    .string()
    .default('./workflows-yaml')
    .describe('Absolute or relative path to the workflows root directory'),
  globalInstructionsPath: z
    .string()
    .default('')
    .describe(
      'Path to the global instructions markdown file. Empty string means derive from WORKFLOWS_DIR.',
    ),
  watcherDebounceMs: z.coerce
    .number()
    .default(500)
    .describe('Milliseconds to debounce filesystem change events before rebuilding the index'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;

export function getServerConfig(): z.infer<typeof ServerConfigSchema> {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    workflowsDir: 'WORKFLOWS_DIR',
    globalInstructionsPath: 'GLOBAL_INSTRUCTIONS_PATH',
    watcherDebounceMs: 'WATCHER_DEBOUNCE_MS',
  });
  return _config;
}
