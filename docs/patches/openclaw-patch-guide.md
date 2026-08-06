# OpenClaw Runtime Patch Guide

JustDo is an OpenClaw desktop frontend, not a long-term fork of OpenClaw Runtime. Runtime patches are compatibility shims and must stay small, documented, auditable, and removable.

## Current OpenClaw Version

`package.json` declares:

```json
{
  "openclaw": {
    "version": "v2026.6.11"
  }
}
```

## Current Patch Location

```text
scripts/patches/v2026.6.11/
```

## Current Patch Set

| Patch                                            | Purpose                                                                                                                                                                                                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `001-thinking-stream.cjs`                        | Thinking stream compatibility and bounded diagnostic previews                                                                                                                                                                  |
| `002-agent-announce-reasoning-stream.cjs`        | Agent reasoning announcement stream                                                                                                                                                                                            |
| `003-openai-content-reasoning-tags.cjs`          | OpenAI content reasoning tag handling                                                                                                                                                                                          |
| `004-windows-mcp-package-runner.cjs`             | Windows MCP stdio/package runner compatibility                                                                                                                                                                                 |
| `005-history-thinking-and-subagent-yield.cjs`    | History thinking content and subagent yield compatibility                                                                                                                                                                      |
| `006-sessions-yield-active-guard.cjs`            | Session yield active guard                                                                                                                                                                                                     |
| `007-allow-managed-pip-config-env.cjs`           | JustDo-managed pip config env passthrough                                                                                                                                                                                      |
| `008-dedupe-visible-subagent-announces.cjs`      | Deduplicate sibling completion announces already visible in parent history                                                                                                                                                     |
| `009-reply-session-init-conflict-retry.cjs`      | Fresh writer snapshots, key-order-independent revisions, and bounded retry for reply initialization conflicts                                                                                                                  |
| `010-defer-selected-tool-schemas.cjs`            | Defer selected heavyweight native schemas through directory-mode Tool Search                                                                                                                                                   |
| `011-retain-user-messages-across-compaction.cjs` | Persist and replay original user text across repeated compactions with a rolling 20k-token budget                                                                                                                              |
| `012-codex-compaction-template.cjs`              | Replace OpenClaw's compaction prompts, replay wrapper, and forced suffixes with Codex handoff semantics                                                                                                                        |
| `013-default-cron-delivery-none.cjs`             | Normalize native-tool agent-turn cron add/update requests to in-app delivery when `delivery` is omitted or a targetless `announce` cannot resolve an external destination                                                      |
| `014-live-context-budget-status.cjs`             | Publish the authoritative pre-prompt context estimate to session state during active runs                                                                                                                                      |
| `015-final-system-prompt-replacements.cjs`       | Apply JustDo-managed ordered regex rules to the final system prompt                                                                                                                                                            |
| `016-litellm-session-id.cjs`                     | Forward `metadata.session_id` and `metadata.request_purpose` on agent, safeguard-compaction, and exec-review OpenAI-compatible model requests                                                                                  |
| `017-tool-error-reasoning-recovery.cjs`          | Retry reasoning-only post-tool-error turns with bounded request-only user recovery messages                                                                                                                                    |
| `018-persistent-interactive-approvals.cjs`       | Keep interactive approvals pending until a decision, preserve timeout-free Gateway waits, suppress the suspended turn's duplicate reply, and resume webchat exec work with a hidden internal prompt only after a real decision |

Historical patches for `v2026.6.9` remain in `scripts/patches/v2026.6.9/` for reference only.

`012` depends on the sanitization helper injected by `011`, and `015` places
its helper before the live-context publisher injected by `014`; the numeric
filenames are the required application order. Reassess these dependencies
before removing any of those patches.

`016` applies its normal-request and safeguard-compaction changes together to a
pristine generated bundle. It intentionally rejects a bundle containing an
earlier or partial `016` revision; regenerate the runtime (for example with
`OPENCLAW_FORCE_INSTALL=1`) instead of layering patch revisions.

## Required Patch Header

Every patch must follow the policy in `scripts/patches/README.md` and include:

```js
// Purpose: Why this patch exists.
// Affected OpenClaw version: vYYYY.M.DD.
// Risk: What behavior can diverge from upstream.
// Remove when: The exact condition that makes this patch unnecessary.
// Upstream tracking: Issue or PR URL, or TODO with owner/date if not filed yet.
// Temporary: yes/no.
```

## Maintenance Checklist

- Confirm the patch targets the currently declared OpenClaw version.
- Keep patch names numbered and descriptive.
- Prefer upstream OpenClaw issues or PRs over expanding local patch logic.
- Do not make SQLite, tool-call ids, labels, or local state a second source of truth.
- Make patch failure visible in build or startup logs.
- Update this guide whenever a patch is added, removed, renamed, or made obsolete.

## Removal Rule

When upstream OpenClaw includes equivalent behavior, remove the patch, update the patch list, and run the OpenClaw runtime install/bundle flow for the affected platform.

## Patch Lifecycle

### 1. Identify

Before adding a patch, decide whether the issue is:

- Electron packaging compatibility.
- Windows/macOS/Linux runtime compatibility.
- Missing Gateway API needed by JustDo UI.
- Temporary behavior difference awaiting upstream support.
- A JustDo bug that should be fixed outside runtime.

Only the first four categories may justify a runtime patch. If the bug is in JustDo adapter/UI/config sync, fix JustDo code instead.

### 2. Scope

A patch should touch the smallest runtime surface possible. It should avoid broad rewrites and should not introduce a second source of truth.

Good patch shape:

- Small compatibility wrapper.
- Event field preservation.
- Platform-specific path/process fix.
- Guard around known runtime race.

Bad patch shape:

- Reimplementing Gateway scheduling.
- Replacing session storage.
- Parsing UI labels to infer runtime truth.
- Hardcoding JustDo-specific prompt semantics deep in Gateway.

### 3. Document

The required header is part of the patch contract. The `Remove when` line must be concrete enough that a future maintainer can delete the patch without archaeology.

Examples:

```js
// Remove when: OpenClaw >= v2026.7.x emits reasoning_delta in chat.history.
// Remove when: upstream package runner supports Windows .cmd resolution for MCP stdio.
```

### 4. Verify

After changing patches:

1. Reinstall/sync the target runtime.
2. Run `npm run openclaw:patches:verify`.
3. Confirm patch logs show applied/skipped status.
4. Run a smoke test for the patched behavior.
5. Run related Vitest tests if adapter behavior changed.
6. Update this guide and any feature docs.

Every successful full patch pass writes `runtime-patch-manifest.json` into the
runtime root, but only after every patch module's read-only `verifyPatch()` has
asserted that all critical final replacements are present. The manifest binds
the declared OpenClaw version and the SHA-256 of every current patch script to
the exact `gateway-bundle.mjs` bytes produced after patching. Electron Builder
verifies this manifest before packaging and again against the runtime copied
into the packaged app. On Windows, the second check extracts the manifest and
gateway bundle from the packaged `win-resources.tar`. A silent no-op,
missing/stale patch, rebuilt bundle, or packaging omission therefore fails the
build before an installer is emitted.

### 5. Remove

Patch removal is a real change:

- Delete the patch file for the current version.
- Remove references in this guide.
- Remove downstream compatibility code if it only existed for that patch.
- Test the exact scenario that originally required the patch.

## Current Patch Rationale

| Patch                                            | Category                                                  | Removal direction                                                                                                                                                 |
| ------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `001-thinking-stream.cjs`                        | Reasoning stream compatibility                            | Remove when Gateway emits stable thinking stream/history and bounded thinking diagnostics                                                                         |
| `002-agent-announce-reasoning-stream.cjs`        | Reasoning event compatibility                             | Remove when upstream agent announcements include reasoning stream                                                                                                 |
| `003-openai-content-reasoning-tags.cjs`          | Provider content parsing                                  | Remove when upstream provider parser preserves reasoning tags                                                                                                     |
| `004-windows-mcp-package-runner.cjs`             | Windows process compatibility                             | Remove when upstream MCP package runner handles Windows stdio launch reliably                                                                                     |
| `005-history-thinking-and-subagent-yield.cjs`    | History/subagent compatibility                            | Remove when upstream history includes thinking and subagent yield data                                                                                            |
| `006-sessions-yield-active-guard.cjs`            | Runtime race guard                                        | Remove when upstream session yield state is guarded                                                                                                               |
| `007-allow-managed-pip-config-env.cjs`           | Managed dependency config passthrough                     | Remove when upstream supports scoped dependency manager env passthrough                                                                                           |
| `008-dedupe-visible-subagent-announces.cjs`      | Subagent completion delivery compatibility                | Remove when upstream coalesces sibling announces or credits results already visible in parent history                                                             |
| `009-reply-session-init-conflict-retry.cjs`      | Runtime session concurrency guard                         | Remove when upstream aligns reply snapshot/commit cache consistency, uses key-order-independent revisions, and retries genuine conflicts                          |
| `010-defer-selected-tool-schemas.cjs`            | Tool context compaction                                   | Remove when upstream supports a configurable per-tool Tool Search defer list                                                                                      |
| `011-retain-user-messages-across-compaction.cjs` | Compaction fidelity                                       | Remove when upstream persists and replays retained user messages across compaction entries                                                                        |
| `012-codex-compaction-template.cjs`              | Compaction fidelity                                       | Remove when upstream supports replacing the compaction template, replay wrapper, and suffix assembly                                                              |
| `013-default-cron-delivery-none.cjs`             | Scheduled-task delivery default                           | Remove when upstream exposes a configurable default cron delivery mode                                                                                            |
| `014-live-context-budget-status.cjs`             | Missing live Gateway usage state                          | Remove when Gateway exposes current context budget status during active runs                                                                                      |
| `015-final-system-prompt-replacements.cjs`       | Missing final prompt transform                            | Remove when Gateway exposes a final, system-only prompt transform hook                                                                                            |
| `016-litellm-session-id.cjs`                     | Missing provider request correlation and purpose metadata | Remove when OpenClaw forwards its session UUID and request purpose for agent, compaction, and exec-review requests                                                |
| `017-tool-error-reasoning-recovery.cjs`          | Reasoning-only turns silently stop after tool errors      | Remove when OpenClaw supports bounded request-only recovery messages without transcript persistence                                                               |
| `018-persistent-interactive-approvals.cjs`       | Interactive approval lifetime and run suspension          | Remove when OpenClaw preserves timeout-free approval waits and resumes approved webchat exec work outside the originating run lifetime only after a real decision |

### Compaction patch upgrade warning

`011` and `012` match exact text emitted by the OpenClaw `v2026.6.11` bundle.
They intentionally fail loudly when those anchors change. On every OpenClaw
upgrade:

1. Do not copy either patch unchanged into the new version directory.
2. Check whether upstream now persists/replays user originals and exposes full
   replacement hooks for the compaction prompt, replay wrapper, and suffixes.
3. If patches remain necessary, inspect the new generated bundle and rewrite
   every exact anchor. Do not broaden matching merely to make the patch apply.
4. Compare the prompt and replacement-history behavior with the current
   `../codex` source; that checkout is reference-only and is not packaged.
5. Exercise manual `/compact`, threshold and overflow auto-compaction,
   mid-turn/split-turn recovery, and at least two consecutive compactions.
   Confirm user-message deduplication, latest-assistant inclusion, bounded tool
   results, and patch idempotence.

## Version Upgrade Process

When bumping `package.json.openclaw.version`:

1. Create a new `scripts/patches/<new-version>/` only if patches are still required.
2. Re-evaluate each old patch against upstream runtime.
3. Drop obsolete patches rather than blindly copying.
4. Update `docs/patches/openclaw-patch-guide.md`.
5. Update `docs/features/thinking-stream-implementation.md` if reasoning patches changed.
6. Run platform runtime install scripts for at least the active development platform.
