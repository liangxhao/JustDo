# OpenClaw Runtime Patch Policy

JustDo is an OpenClaw desktop frontend, not a long-term fork of the OpenClaw
Runtime. Runtime patches are temporary compatibility shims and must stay small,
auditable, and removable.

## Required Patch Header

Every patch under `scripts/patches/<openclaw-version>/` must start with metadata:

```js
// Purpose: Why this patch exists.
// Affected OpenClaw version: vYYYY.M.DD.
// Risk: What behavior can diverge from upstream.
// Remove when: The exact condition that makes this patch unnecessary.
// Upstream tracking: Issue or PR URL, or TODO with owner/date if not filed yet.
// Temporary: yes/no.
```

## Rules

- Do not add a runtime patch without the header above.
- Prefer upstream OpenClaw issues or PRs over expanding JustDo patch logic.
- Mark bug-fix and prompt-semantic patches as `Temporary: yes`.
- Electron, Windows, or packaging compatibility patches may be temporary or
  permanent, but still need a removal condition.
- Patch hit failure must be visible through build or startup logs.

## Review Checklist

- The patch names the OpenClaw version it targets.
- The patch can answer why it exists and when it can be deleted.
- The patch does not make SQLite, tool-call ids, labels, or local state a
  second source of truth for OpenClaw Runtime behavior.
- The patch has a path to an upstream fix or a documented compatibility reason.
