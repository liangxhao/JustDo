# Thinking Stream Display

Thinking/reasoning stream display uses native OpenClaw `v2026.7.1-2` event delivery plus two narrowly scoped JustDo capability patches.

## Current Behavior

- Thinking deltas are forwarded through Cowork stream events.
- Gateway websocket diagnostics include at most 80 characters of thinking text;
  JustDo keeps only the first and last preview for each run and stream.
- Renderer does not maintain a separate thinking state machine.
- The Lit chat pipeline renders thinking content as part of Gateway-backed message rendering.
- Cached message fields include `thinking_content` for UI recovery.

## Related Files

- `scripts/patches/v2026.7.1-2/002-live-thinking-stream.cjs`
- `scripts/patches/v2026.7.1-2/003-openai-think-tag-reasoning.cjs`
- `scripts/patches/v2026.7.1-2/004-history-display-projection.cjs`
- `scripts/patches/v2026.7.1-2/README.md`
- `src/main/engine/cowork/coworkRuntimeForwarder.ts`
- `src/main/engine/openclaw/openclawRuntimeAdapter.ts`
- `src/renderer/libs/openclaw-chat/pipeline/stream-text.ts`

## Maintenance Rule

When upstream OpenClaw exposes equivalent reasoning stream and history behavior, remove or shrink the related runtime patches and update this document.

## Data Flow

```text
Provider/Gateway reasoning content
  -> OpenClaw emits native reasoning events; targeted patches preserve provider/history gaps
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

Native reasoning deltas are published in `v2026.7.1-2`, while patch `002`
preserves callback-independent publication and forwards the configured reasoning
preference through direct Gateway agent runs such as completion announces. The
other targeted patches cover OpenAI-compatible `<think>` content and history
projection. If they fail to apply, symptoms may include:

- announce Thinking missing or arriving only with the final snapshot.
- thinking lost after reopening history.
- reasoning tags displayed as normal answer text.

When diagnosing, check patch logs before changing renderer code.
