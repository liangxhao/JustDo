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

| Patch | Purpose |
| --- | --- |
| `001-thinking-stream.cjs` | Thinking stream compatibility and bounded diagnostic previews |
| `002-agent-announce-reasoning-stream.cjs` | Agent reasoning announcement stream |
| `003-openai-content-reasoning-tags.cjs` | OpenAI content reasoning tag handling |
| `004-windows-mcp-package-runner.cjs` | Windows MCP stdio/package runner compatibility |
| `005-history-thinking-and-subagent-yield.cjs` | History thinking content and subagent yield compatibility |
| `006-sessions-yield-active-guard.cjs` | Session yield active guard |
| `007-allow-managed-pip-config-env.cjs` | JustDo-managed pip config env passthrough |
| `008-dedupe-visible-subagent-announces.cjs` | Deduplicate sibling completion announces already visible in parent history |
| `009-reply-session-init-conflict-retry.cjs` | Fresh writer snapshots, key-order-independent revisions, and bounded retry for reply initialization conflicts |

Historical patches for `v2026.6.9` remain in `scripts/patches/v2026.6.9/` for reference only.

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
2. Confirm patch logs show applied/skipped status.
3. Run a smoke test for the patched behavior.
4. Run related Vitest tests if adapter behavior changed.
5. Update this guide and any feature docs.

### 5. Remove

Patch removal is a real change:

- Delete the patch file for the current version.
- Remove references in this guide.
- Remove downstream compatibility code if it only existed for that patch.
- Test the exact scenario that originally required the patch.

## Current Patch Rationale

| Patch | Category | Removal direction |
| --- | --- | --- |
| `001-thinking-stream.cjs` | Reasoning stream compatibility | Remove when Gateway emits stable thinking stream/history and bounded thinking diagnostics |
| `002-agent-announce-reasoning-stream.cjs` | Reasoning event compatibility | Remove when upstream agent announcements include reasoning stream |
| `003-openai-content-reasoning-tags.cjs` | Provider content parsing | Remove when upstream provider parser preserves reasoning tags |
| `004-windows-mcp-package-runner.cjs` | Windows process compatibility | Remove when upstream MCP package runner handles Windows stdio launch reliably |
| `005-history-thinking-and-subagent-yield.cjs` | History/subagent compatibility | Remove when upstream history includes thinking and subagent yield data |
| `006-sessions-yield-active-guard.cjs` | Runtime race guard | Remove when upstream session yield state is guarded |
| `007-allow-managed-pip-config-env.cjs` | Managed dependency config passthrough | Remove when upstream supports scoped dependency manager env passthrough |
| `008-dedupe-visible-subagent-announces.cjs` | Subagent completion delivery compatibility | Remove when upstream coalesces sibling announces or credits results already visible in parent history |
| `009-reply-session-init-conflict-retry.cjs` | Runtime session concurrency guard | Remove when upstream aligns reply snapshot/commit cache consistency, uses key-order-independent revisions, and retries genuine conflicts |

## Version Upgrade Process

When bumping `package.json.openclaw.version`:

1. Create a new `scripts/patches/<new-version>/` only if patches are still required.
2. Re-evaluate each old patch against upstream runtime.
3. Drop obsolete patches rather than blindly copying.
4. Update `docs/patches/openclaw-patch-guide.md`.
5. Update `docs/features/thinking-stream-implementation.md` if reasoning patches changed.
6. Run platform runtime install scripts for at least the active development platform.
