/**
 * @fileoverview The bundle cleaner and the packaging check agree on which
 * `node_modules/` entries are agent docs: package-root skill trees and stray
 * `SKILL.md` files are stripped, while runtime directories that share a name —
 * the MCP SDK's `dist/ext/skills/` — ship (cyanheads/mcp-ts-core#794).
 * @module tests/scripts/bundle-agent-docs.test
 */
import { describe, expect, it } from 'vitest';

interface CleanMcpbModule {
  AGENT_DOC_ENTRY: RegExp;
  filterAgentDocEntries(entries: string[]): string[];
}

interface LintPackagingModule {
  AGENT_DOC_ENTRY: RegExp;
  checkBundleEntries(entries: string[], bundleLabel: string): string[];
}

/**
 * Loaded by URL at run time: a static import would pull `lint-packaging.ts`
 * into the `tsc` program, and its repo-only `../src/mcp-server/skills.js`
 * fallback import fails to resolve here (cyanheads/mcp-ts-core#797).
 */
const scriptUrl = (name: string) => new URL(`../../scripts/${name}`, import.meta.url).href;
const cleanMcpb = (await import(scriptUrl('clean-mcpb.ts'))) as CleanMcpbModule;
const lintPackaging = (await import(scriptUrl('lint-packaging.ts'))) as LintPackagingModule;

const RUNTIME_ENTRIES = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.d.mts',
  'node_modules/@cyanheads/mcp-ts-core/node_modules/@modelcontextprotocol/core/dist/ext/skills/index.mjs',
  'node_modules/skills/index.js',
  'node_modules/@acme/skills/index.js',
  'skills/workflow-guide/SKILL.md',
  'dist/index.js',
];

const AGENT_DOC_ENTRIES = [
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/references/patterns.md',
  'node_modules/dotenv/skills/dotenv/SKILL.md',
  'node_modules/thread-stream/.claude/settings.json',
  'node_modules/some-pkg/.agents/skills/guide.md',
  'node_modules/outer/node_modules/@scope/inner/skills/guide/SKILL.md',
  'node_modules/some-pkg/docs/SKILL.md',
];

describe('bundle agent-doc selector', () => {
  it('uses the same pattern in the cleaner and the packaging check', () => {
    expect(cleanMcpb.AGENT_DOC_ENTRY.source).toBe(lintPackaging.AGENT_DOC_ENTRY.source);
    expect(cleanMcpb.AGENT_DOC_ENTRY.flags).toBe(lintPackaging.AGENT_DOC_ENTRY.flags);
  });

  it.each(RUNTIME_ENTRIES)('keeps runtime entry %s', (entry) => {
    expect(cleanMcpb.filterAgentDocEntries([entry])).toEqual([]);
  });

  it.each(AGENT_DOC_ENTRIES)('strips package-root agent doc %s', (entry) => {
    expect(cleanMcpb.filterAgentDocEntries([entry])).toEqual([entry]);
  });

  it('passes a cleaned bundle that still carries the SDK skills runtime', () => {
    expect(lintPackaging.checkBundleEntries(RUNTIME_ENTRIES, 'dist/test.mcpb')).toEqual([]);
  });

  it('flags a bundle that still carries package-root agent docs', () => {
    const errors = lintPackaging.checkBundleEntries(
      [...RUNTIME_ENTRIES, ...AGENT_DOC_ENTRIES],
      'dist/test.mcpb',
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`${AGENT_DOC_ENTRIES.length} node_modules agent-doc entries`);
  });
});
