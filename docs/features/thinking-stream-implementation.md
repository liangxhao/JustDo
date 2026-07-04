# Thinking Stream Display

Thinking content is rendered as part of the current Gateway-driven chat pipeline.

## Current behavior

- Gateway emits thinking content with assistant stream events.
- `ChatController` forwards the stream to `<justdo-chat>`.
- `<justdo-chat>` renders thinking blocks inside Shadow DOM.
- No separate Redux thinking state machine is used.

## Related files

- [15-chat-rendering.md](../architecture/15-chat-rendering.md)
- `src/renderer/libs/openclaw-chat/`
