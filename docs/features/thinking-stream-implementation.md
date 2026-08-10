# Thinking Stream Display

Thinking/reasoning stream display is currently implemented through OpenClaw Gateway stream behavior plus JustDo runtime compatibility patches for `v2026.6.11`.

## Current Behavior

- Thinking deltas are forwarded through Cowork stream events.
- Gateway websocket diagnostics include at most 80 characters of thinking text;
  JustDo keeps only the first and last preview for each run and stream.
- Renderer does not maintain a separate thinking state machine.
- The Lit chat pipeline renders thinking content as part of Gateway-backed message rendering.
- Cached message fields include `thinking_content` for UI recovery.

## Related Files

- `scripts/patches/v2026.6.11/001-thinking-stream.cjs`
- `scripts/patches/v2026.6.11/002-agent-announce-reasoning-stream.cjs`
- `scripts/patches/v2026.6.11/003-openai-content-reasoning-tags.cjs`
- `scripts/patches/v2026.6.11/005-history-thinking-and-subagent-yield.cjs`
- `src/main/engine/cowork/coworkRuntimeForwarder.ts`
- `src/main/engine/openclaw/openclawRuntimeAdapter.ts`
- `src/renderer/libs/openclaw-chat/pipeline/stream-text.ts`

## Maintenance Rule

When upstream OpenClaw exposes equivalent reasoning stream and history behavior, remove or shrink the related runtime patches and update this document.

## Data Flow

```text
Provider/Gateway reasoning content
  -> OpenClaw runtime patch preserves/emits thinking data
  -> OpenClawRuntimeAdapter receives stream/history
  -> coworkRuntimeForwarder emits thinkingUpdate
  -> Renderer chat pipeline updates thinking block
  -> SQLite cache may persist thinking_content for recovery
```

## Display Semantics

Thinking content is assistant-side auxiliary content. It should be visually distinct from final answer content and should not be mixed into the final message text.

Renderer behavior:

- Show incremental thinking while a turn is running.
- Preserve already received thinking deltas if final answer continues.
- Collapse or group thinking content according to chat UI rules.
- Avoid duplicating thinking content when history reloads after stream completion.

## History Semantics

Live stream and history can arrive in different shapes. The pipeline should normalize both so reopening a session does not change the apparent reasoning content.

Potential mismatch cases:

- live stream has deltas, history has combined thinking text.
- provider uses reasoning tags inside content.
- subagent yield includes thinking metadata.
- old cache has `thinking_content`, Gateway history does not.

Gateway history wins when available; cache is fallback.

## Patch Dependency

This feature currently depends on runtime patches for `v2026.6.11`. If a patch fails to apply, symptoms may include:

- no thinking stream during live turn.
- thinking lost after reopening history.
- reasoning tags displayed as normal answer text.
- subagent thinking/yield content missing.

When diagnosing, check patch logs before changing renderer code.
