# OpenClaw Thin Frontend Status

JustDo has completed the thin-frontend refactor. This document records the current status rather than a pending migration plan.

## Completed Boundary

- OpenClaw Gateway owns chat execution, history, subagents, skills runtime, cron runtime, and slash command capability.
- JustDo owns Electron desktop UX, local configuration, SQLite UI cache, ask-user interaction UI, plugin management UI, and runtime lifecycle controls.
- Renderer accesses local capabilities only through `window.electron`.
- Chat rendering uses the Lit `<justdo-chat>` element and Gateway WebSocket.
- SQLite is not an execution-history authority.

## Remaining Maintenance Work

- Keep runtime patches small and remove them when upstream OpenClaw supports the behavior.
- Keep docs synchronized when Gateway APIs replace local compatibility code.
- Avoid adding new local state machines for Gateway-owned behavior.

## Files To Watch

- `src/main/engine/openclaw/openclawRuntimeAdapter.ts`
- `src/main/openclaw/runtime/openclawEngineManager.ts`
- `src/main/openclaw/config/openclawConfigSyncService.ts`
- `src/renderer/libs/openclaw-chat/`
- `scripts/patches/`

## Acceptance Criteria

- Gateway history can rebuild chat display even if local message cache is stale.
- A Gateway restart does not require restarting the renderer.
- New execution capabilities are routed through Gateway APIs or upstream changes.

## What Changed Architecturally

The refactor removed the need for JustDo to maintain long-lived local execution state. Before the boundary cleanup, local UI state, SQLite cache, and Gateway state could drift. The current design makes the drift explicit:

- Gateway state is execution truth.
- SQLite state is cache/product metadata.
- Renderer state is view state.
- Runtime patches are temporary compatibility layers.

## Current Invariants

- `openclawRuntimeAdapter.ts` adapts, but does not own, Gateway semantics.
- `historyReconciler` can update local cache from Gateway history.
- Cowork UI can render from Gateway-backed chat pipeline.
- Subagent UI depends on Gateway child session identity.
- Scheduled tasks depend on Gateway cron execution.

## Regression Signals

Watch for these signs that code is drifting back to thick-frontend behavior:

- New Redux state represents Gateway execution status without reconciliation.
- SQLite fields are used to decide whether Gateway work happened.
- Renderer parses tool output text to infer structured state.
- A runtime patch introduces JustDo-only business policy.
- Adapter grows unrelated responsibilities instead of delegating to domain services.

## Review Questions

- Is this change adding UI state or execution state?
- If Gateway restarts, can the state be recovered?
- If SQLite is deleted, can the user still recover Gateway history?
- Does the renderer need this detail, or can Main/Gateway own it?
- Is there an upstream OpenClaw API that should exist instead?
