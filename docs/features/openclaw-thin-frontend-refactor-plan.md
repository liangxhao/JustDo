# OpenClaw Thin Frontend Refactor Plan

## Background

> **实现状态（2026-06）**：本重构方案已在 v2026.5-v2026.6 中部分落地。GucciAI 不再做 OpenClaw Runtime 二次状态机，Gateway 为权威数据源。Subagent 逻辑已收缩。剩余工作包括历史兼容性 shim 清理和 runtime patch 精简。

GucciAI is intended to act as an Electron/React frontend for OpenClaw, similar to ClawX. The current `OpenClawRuntimeAdapter` has gradually grown into a second orchestration layer: it tracks active turns, run IDs, subagent status, visible announce runs, deferred history reloads, tool streams, SQLite persistence, and completion fallbacks.

Recent logs in `build.log` show the risk of this approach. OpenClaw successfully spawned and completed two subagents, and emitted completion announce runs, but GucciAI's adapter state and completion handling did not reliably let the parent agent receive the full set of child results. This suggests the local adapter can interfere with OpenClaw's native webchat/runtime semantics.

The goal is to move GucciAI toward the ClawX model: OpenClaw Gateway is the authority, and GucciAI projects Gateway events/history into its UI with minimal custom orchestration.

## Reference

Use `../ClawX` as the reference implementation style, especially:

- `../ClawX/src/stores/chat/runtime-send-actions.ts`
- `../ClawX/src/stores/chat/runtime-event-actions.ts`
- `../ClawX/src/stores/chat/runtime-event-handlers.ts`
- `../ClawX/src/stores/chat/history-actions.ts`
- `../ClawX/src/stores/gateway.ts`
- `../ClawX/electron/gateway/event-dispatch.ts`

Important ClawX pattern:

- `chat.send` is sent directly through Gateway RPC.
- Streaming events update UI optimistically.
- `chat.history` is the authoritative source.
- `agent` lifecycle events mostly trigger history/session refresh.
- The frontend does not reimplement subagent completion orchestration.

## Goals

1. Make GucciAI a thin OpenClaw frontend.
2. Treat Gateway `chat.history`, `sessions.list`, and native Gateway events as authoritative.
3. Reduce custom state machines in `src/main/libs/agentEngine/openclawRuntimeAdapter.ts`.
4. Keep existing Cowork UI and SQLite message persistence working.
5. Avoid custom subagent completion fixes except as temporary compatibility shims.

## Non-Goals

- Do not rewrite OpenClaw runtime behavior in GucciAI.
- Do not patch OpenClaw announce/yield semantics in app code unless absolutely necessary.
- Do not remove SQLite persistence in the first pass.
- Do not redesign Cowork UI during this refactor.

## Current Risk Areas

The following adapter responsibilities are too broad and should be reduced or removed:

- `activeTurns` as a full turn state machine.
- `knownRunIds` and custom announce run routing.
- `visibleRunStreams`.
- `subagentStatus`, `toolCallIdToSessionKey`, `toolCallIdToParentSessionId` as long-lived orchestration truth.
- Custom subagent completion parsing and aggregate wake logic.
- Manual completion/cleanup decisions based on partial `agent` events.
- History reconciliation that competes with Gateway transcript timing.

Temporary code added for the current bug:

- Aggregate subagent wake fallback in `openclawRuntimeAdapter.ts`.
- This should be considered stopgap code and removed once the thin adapter handles OpenClaw-native announce/yield correctly.

## Proposed Architecture

Introduce a thinner adapter boundary:

```text
Renderer Cowork UI
        |
Cowork store / SQLite cache
        |
Thin Gateway Chat Adapter
        |
OpenClaw Gateway RPC + events
        |
OpenClaw runtime
```

The thin adapter should only do:

- Send user messages via `chat.send`.
- Abort via `chat.abort`.
- Convert Gateway `chat` streaming events into Cowork UI events.
- Use `agent` lifecycle/tool events as UI hints only.
- Reload `chat.history` after final/error/aborted/completed events.
- Persist projected history into `CoworkStore`.

The thin adapter should not do:

- Start its own subagent completion flow.
- Infer all subagent statuses from local maps.
- Inject aggregate completion messages.
- Treat `agent phase=end` as full run completion.
- Maintain independent session truth if Gateway has an answer.

## Phase 0: Preserve Current Behavior

Before refactoring, keep the current fix in place so users are not blocked.

Tasks:

1. Keep the current aggregate wake fallback temporarily.
2. Add comments marking it as compatibility fallback.
3. Add a feature flag or constant to disable it later, for example:

```ts
const ENABLE_LEGACY_SUBAGENT_AGGREGATE_WAKE = true;
```

Validation:

- `npm test -- src/main/libs/agentEngine/openclawRuntimeAdapter.test.ts`
- `npm run compile:electron`

## Phase 1: Add Thin Adapter in Parallel

Create a new module instead of modifying the current adapter in place.

Suggested files:

- `src/main/libs/agentEngine/openclawThinRuntimeAdapter.ts`
- `src/main/libs/agentEngine/openclaw/thinGatewayHistory.ts`
- `src/main/libs/agentEngine/openclaw/thinGatewayEvents.ts`

Responsibilities:

1. Implement `CoworkRuntime` interface.
2. Use the existing `OpenClawEngineManager` and Gateway client creation.
3. On `startSession` / `continueSession`:
   - Add/persist the user message locally for immediate UI.
   - Call Gateway `chat.send` with:
     - `sessionKey`
     - `message`
     - `deliver: false`
     - `idempotencyKey`
   - Store only `sessionKey`, `runId`, and minimal send state.
4. On Gateway `chat` events:
   - Process only the current session/run when possible.
   - Stream assistant text into one transient UI message.
   - On final/error/aborted, reload `chat.history`.
5. On Gateway `agent` events:
   - Do not perform orchestration.
   - Use `phase=start` as "running" hint.
   - Treat `phase=end` as per-message or hint only.
   - Treat only `completed`, `done`, `finished`, `error`, `failed`, `aborted`, `cancelled` as run terminal hints.
   - Trigger quiet `chat.history` reload on tool/lifecycle changes.

Validation:

- Unit test `chat.send` request shape.
- Unit test `phase=end` does not complete a session.
- Unit test final chat event triggers history reload.
- Unit test internal messages like `NO_REPLY` do not become visible.

## Phase 2: History-First Projection

Build a reliable history projection layer.

Tasks:

1. Reuse existing `HistoryReconciler` if possible, but simplify its call sites.
2. Convert Gateway `chat.history` messages into `CoworkMessage`.
3. Persist the converted messages into `CoworkStore`.
4. Preserve user optimistic messages until Gateway history contains them.
5. Drop internal-only messages:
   - `NO_REPLY`
   - `HEARTBEAT_OK`
   - OpenClaw internal runtime context blocks
6. Preserve tool call/tool result visibility according to Gateway history, not local reconstructed tool maps.

Validation:

- A tool-use turn appears after history reload.
- A final assistant answer appears once, not duplicated.
- Internal announce context is not displayed.
- Uploaded/attached file metadata still displays if relevant.

## Phase 3: Subagent UI From Gateway Authority

Replace local subagent orchestration truth with Gateway data.

Tasks:

1. Implement subagent list/status from Gateway `sessions.list({ spawnedBy })`.
2. Use `chat.history(childSessionKey)` for subtask detail view.
3. Use persisted SQLite subagent rows only as UI cache/fallback.
4. Remove local status transitions that compete with Gateway.
5. Do not send custom aggregate completion messages from GucciAI.

Validation:

- Spawned subagents appear in UI.
- Status changes to running/done/failed based on Gateway.
- Clicking a subagent opens history from Gateway.
- Two subagents completing does not require GucciAI to inject a custom wake.

## Phase 4: Switch Cowork Runtime Behind a Feature Flag

Add a runtime selection flag:

```ts
const USE_THIN_OPENCLAW_ADAPTER = false;
```

Then wire `coworkEngineRouter` or runtime construction to select:

- Current `OpenClawRuntimeAdapter`
- New `OpenClawThinRuntimeAdapter`

Tasks:

1. Default to current adapter.
2. Add local/dev option to enable thin adapter.
3. Run the same user scenarios under both adapters.
4. Compare SQLite messages and UI behavior.

Recommended scenarios:

- Normal single prompt.
- Prompt with one tool call.
- Prompt with two tool calls.
- Spawn two subagents, yield, then summarize.
- Spawn two subagents and write Excel via xlsx skill.
- Abort while model is thinking.
- Gateway restart during run.

Validation:

- `npm test`
- `npm run lint`
- `npm run compile:electron`
- Manual `npm run electron:dev:openclaw`

## Phase 5: Remove Legacy Custom Orchestration

After thin adapter is stable:

1. Remove aggregate subagent wake fallback.
2. Remove or deprecate:
   - `visibleRunStreams`
   - `subagentStreamByRunId` if no longer needed
   - most `toolCallIdTo*` maps
   - manual `pendingSubagentCompletionSessions`
   - custom completion parsing for parent orchestration
3. Keep only UI projection helpers that do not affect Gateway behavior.
4. Update tests to assert Gateway-authoritative behavior.

## Suggested Test Additions

Add focused tests around the failure mode from `build.log`:

1. Two subagents complete; each completion announce arrives separately.
2. Adapter does not inject extra custom completion by default in thin mode.
3. Adapter reloads parent `chat.history` after announce events.
4. Parent final answer is rendered from Gateway history.
5. `sessions_yield` result does not mark run as permanently stuck.

## Manual Verification Script

Use this prompt in a fresh Cowork session:

```text
请开2个subagent，分别写一句祝福语，最终汇总之后，使用skill写入Excel。
```

Expected behavior:

1. Two subagents are spawned.
2. Both subagents complete.
3. Parent agent receives both results.
4. Parent agent writes the Excel file.
5. UI shows the final answer once.
6. Session returns to idle/completed state.

## Migration Notes

- Keep changes incremental. Do not delete the current adapter until thin mode is proven.
- Prefer copying ClawX behavior conceptually, not blindly copying code.
- Any change touching Gateway communication should include a regression test.
- When unsure, prefer Gateway history over local state.
- If a local cache disagrees with Gateway, Gateway wins.

## Success Criteria

The refactor is successful when:

- GucciAI no longer needs custom subagent aggregate wake logic.
- The adapter has fewer local lifecycle maps.
- Parent/subagent completion is handled by OpenClaw-native announce/yield behavior.
- UI still supports streaming, tool display, thinking display, and SQLite persistence.
- Repeated multi-subagent workflows do not get stuck after child completion.
