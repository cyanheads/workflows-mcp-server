---
name: workflows-guide
description: Gates and conventions for the workflow_* playbook library. Use before running the steps of a workflow from workflow_get, when saving a procedure with workflow_create or workflow_create_temp, when promoting or discarding a draft, and before calling workflow_delete. Covers version pinning (drafts can win an unversioned lookup), step placeholders, and the user-confirmed delete.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

A library of named, versioned playbooks stored as YAML in a local directory. The server stores and returns them; it never runs a step. You run each step through your own tools. Nothing checks a step's `server` or `tool` against anything that exists, so a stored step can name a server you don't have or a tool that has since been renamed. No API key.

Reach for it when the user asks to run a saved procedure, to keep a procedure for reuse, or names a workflow. It does not schedule, execute, or record runs.

## Identifiers

| Identifier | Comes from | Taken by |
|:-----------|:-----------|:---------|
| `name` | a `workflow_list` row, or the part of a create tool's `key` before its final `@` (never pass the whole key as `name`) | `workflow_get`, `workflow_delete` — exact and case-sensitive after trimming: `Deploy` and `deploy` are two workflows |
| `version` | the same row, or the part of the `key` after its final `@`, in canonical semver (`v2.0.0+build.5` is stored as `2.0.0`) | `workflow_get`, `workflow_delete` |
| a draft's name and version | only the `key` from `workflow_create_temp` — drafts never appear in `workflow_list` | `workflow_get`, `workflow_delete` |
| a step's `name` | the author | `{{steps.<name>.output…}}` placeholders in later steps |
| `filePath` | the create tools | no tool — it is where the YAML file lives |

`workflow_list` returns one row per permanent version, sorted by name and, within a name, newest version first, so the row you pick carries the version to pin.

## Gates

- **Pin the version.** Without `version`, `workflow_get` and `workflow_delete` resolve the highest version across permanent workflows and drafts together: a draft at 1.1.0 wins over a permanent 1.0.0. Pass the version from the `workflow_list` row or the create `key`, and check `source` in the `workflow_get` result before running — `temp` means you are holding a draft.
- **Map every step before running any.** Match each step's `server` and `tool` to a tool you actually have. If one has no match, tell the user which step before starting, not halfway through.
- **Fill inputs before the first step.** Resolve each `{{input.<name>}}` from the request or context and ask the user for any you can't. The server returns placeholders verbatim and never resolves them.
- **The user confirms a delete, not you.** `workflow_delete` shows the user a prompt naming the resolved `name@version`, its source, and its file. Each call removes one version, so a workflow with three versions takes three calls and three prompts. After `cancelled`, leave the workflow alone unless the user asks again. On `client_capability_missing`, this client cannot show the prompt: tell the user the workflow is still there, and do not delete its file by other means.
- **Revise with a new version, never by editing the file.** There is no update tool; store the revision with `workflow_create` at a higher version. A hand edit at `filePath` that breaks the schema drops the workflow from `workflow_list` and `workflow_get` (`not_found`, or `version_not_found` when you pin a version and other versions of that name exist) with no error outside the server's own log. The broken file still holds its name and version, so `workflow_create` at that same version returns `already_exists`: create at a higher version.

## Step placeholders

Step `params` are stored exactly as written. Workflows rely on these conventions between author and runner; the server enforces none of them:

| Form | Meaning |
|:-----|:--------|
| `{{input.<name>}}` | a per-run value the runner supplies |
| `{{steps.<step name>.output.<field>}}` | a field of an earlier step's result, addressed by that step's `name` |
| `forEach: "{{steps.<step name>.output.<list>}}"` with `{{item.<field>}}` in the same step's params | run the step once per element; `item` is the current element |

Filters such as `| slice: 0, 3`, `| slugify`, or `{{now | date: 'YYYY-MM-DD'}}` also appear. Read them as the author's intent and carry it out yourself.

## Workflows

**Run a saved workflow.** Call `workflow_list` with `query` (a substring of the name or description), `category` (a substring), or `tags` (each must equal a whole tag, ignoring case: `pub` does not match `pubmed`). Pick the row, call `workflow_get` with its name and version, apply `globalInstructions` when it is not null, then run the steps in order through your tools, carrying each output forward.

**Save a procedure.** Write one step per tool call: `server` is the server's name as you see it, `tool` its exact tool name, literal `params` for values fixed on every run, and `{{input.<name>}}` for values that change. Give a step a `name` when a later step reads its output. Reuse a category spelling `workflow_list` already shows. `already_exists` means that name and version are taken; a revision goes in at a higher version.

**Draft, then promote or discard.** `workflow_create_temp` writes a draft with no category. Writing the same name and version again overwrites it (`status: "overwritten"`). Keep the returned `key`: nothing lists the draft and nothing expires it. A draft and a permanent workflow can never share a name and version, in either direction, so promote one of two ways:

1. Same version: `workflow_delete` the draft at its version (the user confirms), then `workflow_create` that name and version with a category.
2. New version: `workflow_create` at a higher version, then delete the draft so it doesn't linger.

To discard a draft, `workflow_delete` it at its version.
