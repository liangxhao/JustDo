# OpenClaw Thin Frontend

JustDo is a thin frontend for OpenClaw Gateway.

## Current boundary

- Gateway owns execution, history, session lifecycle, and subagent lineage.
- JustDo owns UI, local cache, configuration, and permission prompts.
- Chat rendering uses the current `<justdo-chat>` Lit pipeline.

## Responsibilities

### Gateway

- `chat.send`
- `chat.abort`
- `chat.history`
- `sessions.list`
- `sessions.delete`
- tool and approval event emission

### JustDo

- Render chat and settings UI
- Persist UI cache in SQLite
- Present permission approval dialogs
- Sync config and skills to Gateway

## Related files

- [02-architecture.md](../architecture/02-architecture.md)
- [15-chat-rendering.md](../architecture/15-chat-rendering.md)
