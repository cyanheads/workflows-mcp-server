/**
 * @fileoverview Shared `content[]` trailer for an enrichment notice that embeds caller- or
 * workflow-authored text.
 * @module mcp-server/tools/escaped-notice-trailer
 */

import { escapeMarkdownInline } from '@cyanheads/mcp-ts-core/utils';

/**
 * `enrichmentTrailer.notice` entry: renders the notice as a block quote with its text escaped,
 * one quoted line per line break. The handler passes the notice raw, so `structuredContent.notice`
 * carries the text exactly as written while `content[]` shows it literally.
 */
export const escapedNoticeTrailer = {
  render: (notice: unknown) =>
    escapeMarkdownInline(String(notice))
      .split(/\r\n|\r|\n/)
      .map((line) => `> ${line}`)
      .join('\n'),
};
