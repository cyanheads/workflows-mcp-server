# Contributing

Thanks for using `workflows-mcp-server`. Bugs, feature requests, and documentation gaps all belong in an issue — that's where they get read and picked up.

Open one from the **Issues** tab and pick the **Bug Report** or **Feature Request** form. Both are structured, and filling in the fields is what makes an issue actionable.

## Server bug or framework bug?

`workflows-mcp-server` is built on [@cyanheads/mcp-ts-core](https://github.com/cyanheads/mcp-ts-core), which handles transports, auth, config, logging, and telemetry.

- **This repo** — a tool returns wrong data, workflow storage fails, a schema doesn't match reality, or a description misleads the model.
- **[mcp-ts-core](https://github.com/cyanheads/mcp-ts-core/issues)** — a builder rejects valid input, `createApp()` fails on a valid config, a Context method behaves contrary to its docs, or transport/auth misbehaves across tools.

If you're not sure, file here and it'll get routed.

## Before filing

1. Check you're on the latest release.
2. Search existing issues before opening a new one.
3. Redact API keys, tokens, auth headers, internal URLs, and personal information from code, logs, and stack traces.

## What makes an issue actionable

- Server version, `mcp-ts-core` version, runtime (Bun or Node), and transport (stdio or HTTP).
- The tool involved and the arguments you called it with.
- Actual versus expected behavior, including verbatim error messages where useful.
- For features, the use case first and the desired API second.

## For agents

Do the triage first. Use [`skills/report-issue-local/SKILL.md`](../skills/report-issue-local/SKILL.md) for this repo or [`skills/report-issue-framework/SKILL.md`](../skills/report-issue-framework/SKILL.md) after isolating a framework bug.

## Security

Don't open a public issue for a vulnerability. Use GitHub's **Security** tab or email **security@caseyjhand.com**.
