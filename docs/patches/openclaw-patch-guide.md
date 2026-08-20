# OpenClaw Runtime Patch Guide

JustDo is an OpenClaw desktop frontend, not a long-term fork of OpenClaw Runtime. Runtime patches are compatibility shims and must stay small, documented, auditable, and removable.

## Current OpenClaw Version

`package.json` declares:

```json
{
  "openclaw": {
    "version": "v2026.7.1-2"
  }
}
```

## Current Patch Location

```text
scripts/patches/v2026.7.1-2/
```

The authoritative current capability inventory, pristine-package evidence,
per-patch behavior, inter-patch relationships, retention rationale, mapping,
and removal conditions live in
`scripts/patches/v2026.7.1-2/README.md`.

## Historical v2026.6.11 Patch Set

| Patch                                            | Purpose                                                                                                                                                                                                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `001-thinking-stream.cjs`                        | Thinking stream compatibility and bounded diagnostic previews                                                                                                                                                                                             |
| `002-agent-announce-reasoning-stream.cjs`        | Agent reasoning announcement stream                                                                                                                                                                                                                       |
| `003-openai-content-reasoning-tags.cjs`          | OpenAI content reasoning tag handling                                                                                                                                                                                                                     |
| `004-windows-mcp-package-runner.cjs`             | Windows MCP stdio/package runner compatibility                                                                                                                                                                                                            |
| `005-history-thinking-and-subagent-yield.cjs`    | Preserve auditable thinking/tool-call history, promote announce side branches only after outer delivery commit, enforce a persistent per-requester completion delivery queue, and suppress redundant CLI transcript gap-fill after yielded embedded turns |
| `006-sessions-yield-active-guard.cjs`            | Allow yield only when an active child or a future required completion delivery can wake the parent; exclude the completion currently being consumed                                                                                                       |
| `007-allow-managed-pip-config-env.cjs`           | JustDo-managed pip config env passthrough                                                                                                                                                                                                                 |
| `008-dedupe-visible-subagent-announces.cjs`      | Deduplicate sibling completion announces already visible in parent history                                                                                                                                                                                |
| `009-reply-session-init-conflict-retry.cjs`      | Fresh writer snapshots, key-order-independent revisions, and bounded retry for reply initialization conflicts                                                                                                                                             |
| `010-defer-selected-tool-schemas.cjs`            | Defer selected heavyweight native schemas through directory-mode Tool Search                                                                                                                                                                              |
| `011-retain-user-messages-across-compaction.cjs` | Persist and replay original user text across repeated compactions with a rolling 20k-token budget                                                                                                                                                         |
| `012-codex-compaction-template.cjs`              | Replace OpenClaw's compaction prompts, replay wrapper, and forced suffixes with Codex handoff semantics                                                                                                                                                   |
| `013-default-cron-delivery-none.cjs`             | Normalize native-tool agent-turn cron add/update requests to in-app delivery when `delivery` is omitted or a targetless `announce` cannot resolve an external destination                                                                                 |
| `014-live-context-budget-status.cjs`             | Publish the authoritative pre-prompt context estimate to session state during active runs                                                                                                                                                                 |
| `015-final-system-prompt-replacements.cjs`       | Apply JustDo-managed ordered regex rules to the final system prompt                                                                                                                                                                                       |
| `016-litellm-session-id.cjs`                     | Forward session, direct-parent session, request-purpose, and explicit human-user initiation metadata on agent, safeguard/native-compaction, and exec-review OpenAI-compatible model requests                                                              |
| `017-tool-error-reasoning-recovery.cjs`          | Retry reasoning-only post-tool-error turns with bounded request-only user recovery messages                                                                                                                                                               |
| `018-persistent-interactive-approvals.cjs`       | Keep interactive approvals pending until a decision, preserve timeout-free Gateway waits, suppress the suspended turn's duplicate reply, and resume webchat exec work with a hidden internal prompt only after a real decision                            |
| `019-compaction-emergency-fallback.cjs`          | Commit a bounded local handoff when model-backed summarization cannot run, then use bounded retries and an aggressive recent-tail pass before reporting irreducible context                                                                               |
| `020-run-progress-events.cjs`                    | Publish sanitized run progress events for long-running turns                                                                                                                                                                                              |
| `021-atomic-sessions-spawn-admission.cjs`        | After each native/ACP synchronous preflight, reserve per-parent child capacity before the first initialization await and hold it through shared registry admission                                                                                        |
| `022-subagent-pending-status.cjs`                | Project accepted native and ACP children without a lifecycle `start` as `pending`, then switch to `running` on `start`, including starts observed just before registry admission                                                                          |
| `023-managed-subagent-join.cjs`                  | Incrementally join completed subagents inside the original JustDo parent run and pin managed logical sessions to their existing Gateway session id                                                                                                        |
| `024-silent-goal-clear.cjs`                      | Expose a narrow operator-admin RPC for clearing canonical Goal metadata without writing an application lifecycle command into model-visible chat history                                                                                                  |
| `025-subagent-session-title-metadata.cjs`        | Project durable subagent `taskName`, explicit `label`, and `task` metadata on Gateway `sessions.list` rows so retained history keeps authoritative titles                                                                                                 |

Historical patches for `v2026.6.9` remain in `scripts/patches/v2026.6.9/` for reference only.

The historical numbers above describe only the archived `v2026.6.11` files.
They are not current IDs and must not be used to infer current dependencies.

## Current Ordering Convention

The `v2026.7.1-2` directory contains exactly 37 capability patches named with a
continuous three-digit prefix, `001` through `037`. The loader sorts filenames
lexicographically, so the prefix is the actual application order:

| Range       | Capability group                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| `001`–`004` | Managed environment, live Thinking, reasoning transport, history projection                                               |
| `005`–`012` | Cron, Windows/Chrome MCP, Tool Search, prompt and session RPC projections                                                 |
| `013`–`021` | Subagent admission, lifecycle, completion delivery and managed join                                                       |
| `022`–`025` | Persistent interactive approval lifecycle                                                                                 |
| `026`–`028` | Parent identity and LiteLLM request metadata                                                                              |
| `029`–`031` | Retained user context, Codex-style continuation and compaction fallback                                                   |
| `032`–`037` | Sanitized progress, bounded recovery, context budget, local compaction, managed session identity and overflow convergence |

Within a dependency chain, producers precede consumers. In particular,
`015` precedes `016`, `017`–`021` are the managed-join state machine, `036`
pins its Gateway session identity across implicit recovery, `037` consumes
`029` and `035` to converge provider-confirmed overflow,
`022` precedes `023`–`025`, and `026` precedes provider metadata patches
`027`–`028`. The authoritative per-file behavior, tests, removal conditions,
and deleted-capability decisions remain in the target directory README.

## Required Patch Header

Every patch must follow the policy in `scripts/patches/README.md` and include:

```js
// Capability: The independently removable user-visible behavior.
// Target: The exact pristine OpenClaw npm version and missing native behavior.
// Scope: The request paths, sessions, platforms, or files affected.
// Safety: The fail-closed boundaries and native behavior that must remain.
// Remove when: The exact condition that makes this patch unnecessary.
```

## Maintenance Checklist

- Confirm the patch targets the currently declared OpenClaw version.
- Keep patch names continuous, three-digit, ordered by dependency, and descriptive.
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

Every successful full patch pass writes manifest format 2 as
`runtime-patch-manifest.json`, but only after every patch module's read-only
`verifyPatch()` has checked the final runtime. The proof binds the npm integrity
and tarball hash, target platform/architecture, ordered patch hashes, patch
helper and source-lock hashes, build-recipe fingerprint, package/dependency
lock, immutable runtime artifacts, and final bundle bytes. Patch application
snapshots all JavaScript targets and rolls the entire pass back byte-for-byte if
any apply or verification step fails. Electron Builder revalidates the proof
before packaging and against the staged product; Windows validates the contents
of `win-resources.tar` while allowing only the intentionally omitted standalone
asar. A partial patch, stale cache, reordered patch, rebuilt bundle, or packaging
omission therefore fails before an installer is emitted.

The current-version patch helper also uses that immutable transaction snapshot
as a phase-local file/content index. Target discovery decodes each JavaScript
file once, repeated identical searches are cached, and `writeIfChanged()`
updates the affected content and cached query results before the next patch or
verification runs. Current-version patches must therefore route runtime
JavaScript writes through `writeIfChanged()`; direct writes would bypass the
index and are not allowed. The index is discarded at the end of every success
or rollback, so it does not weaken pristine-source, idempotence, or manifest
validation.

### 5. Remove

Patch removal is a real change:

- Delete the patch file for the current version.
- Remove references in this guide.
- Remove downstream compatibility code if it only existed for that patch.
- Test the exact scenario that originally required the patch.

## Current Patch Rationale

The authoritative, capability-level inventory for the current target is
[`scripts/patches/v2026.7.1-2/README.md`](../../scripts/patches/v2026.7.1-2/README.md).
It records every user-visible contract, pristine evidence, retained patch,
deleted upstream capability, focused test, and removal condition. Do not copy a
second file-level table here: it becomes stale as soon as a large historical
patch is split.

### Historical v2026.6.11 compaction upgrade warning

`011`, `012`, and `019` match exact text emitted by the OpenClaw `v2026.6.11`
bundle. They intentionally fail loudly when those anchors change. On every OpenClaw
upgrade:

1. Do not copy these patches unchanged into the new version directory.
2. Check whether upstream now persists/replays user originals and exposes full
   replacement hooks for the compaction prompt, replay wrapper, and suffixes.
3. If patches remain necessary, inspect the new generated bundle and rewrite
   every exact anchor. Do not broaden matching merely to make the patch apply.
4. Compare the prompt and replacement-history behavior with the current
   `../codex` source; that checkout is reference-only and is not packaged.
5. Exercise manual `/compact`, threshold and overflow auto-compaction,
   mid-turn/split-turn recovery, and at least two consecutive compactions.
   Confirm user-message deduplication, latest-assistant inclusion, bounded tool
   results, emergency fallback after model/auth/summary failures, and patch
   idempotence.

## Version Upgrade Process

When bumping `package.json.openclaw.version`:

1. Create a new `scripts/patches/<new-version>/` only if patches are still required.
2. Re-evaluate each old patch against upstream runtime.
3. Drop obsolete patches rather than blindly copying.
4. Update `docs/patches/openclaw-patch-guide.md`.
5. Update `docs/features/thinking-stream-implementation.md` if reasoning patches changed.
6. Run platform runtime install scripts for at least the active development platform.
