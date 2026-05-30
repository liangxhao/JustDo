# OpenClaw Gateway Capability Matrix

This matrix records the runtime boundary for GucciAI as an OpenClaw desktop
frontend. OpenClaw Gateway is the authoritative source for execution, history,
session lifecycle, and Subagent lineage. GucciAI stores local UI data, cache,
permissions audit, and product metadata.

| Capability | Gateway API/Event | Observed Fields In GucciAI | Current GucciAI Compensation | Target Boundary | Deletion Prerequisite |
| --- | --- | --- | --- | --- | --- |
| Send chat turn | `chat.send` | `sessionKey`, `runId`, prompt/options payload | Adapter maps Cowork session ids to managed OpenClaw session keys and tracks active turn UI state. | Gateway owns turn execution; adapter only maps UI events. | Keep only Cowork compatibility facade and event mapper. |
| Abort chat turn | `chat.abort` | `sessionKey`, `runId` | Adapter stores per-session active turn to abort the current run. | Gateway owns cancellation semantics. | Gateway exposes enough run/session status for UI to avoid local runtime decisions. |
| Chat history | `chat.history` | `messages[]` with roles/content/usage/tool blocks | `historyReconciler` replaces or patches SQLite `cowork_messages`; Subagent history has multiple fallback guesses. | Gateway history is authoritative; SQLite is cache only. | New sessions always recover history from Gateway; legacy SQLite-only sessions are marked fallback. |
| List sessions | `sessions.list` | `sessions[]`, `key`, `label`/`displayName`, `status`, `spawnedBy`, optional run-state fields | Adapter merges Gateway sessions with `cowork_subagents` and in-memory maps. | Gateway sessions are authoritative for parent/child lineage and Subagent status. | Gateway consistently returns child session key, parent/spawnedBy key, label, and status. |
| Delete session tree | `sessions.list`, `sessions.delete` | child `key` from `sessions.list` | Adapter recursively deletes children as best-effort cleanup. | GucciAI may request cleanup, but does not own lineage truth. | None; keep as product cleanup helper. |
| Gateway event stream | Gateway client event frames | `chat:*`, `agent:*`, tool events, approval events | `openclawRuntimeAdapter.ts` parses events and maintains UI/progress state. | Event mapper converts Gateway events to Cowork IPC without runtime state authority. | Extract stateless event mapper with fixtures. |
| Permission request | approval events + approval response request | approval `id`, command/cwd/security/session metadata | GucciAI presents approval UI and audits user choice. | GucciAI owns approval UX and audit; Gateway owns tool execution. | None; this is a GucciAI responsibility. |
| Subagent completion | Gateway agent/session events and transcript entries | session/run identifiers, `subagent_completion` extracted from history/content | Adapter tracks status maps and a temporary runtime prompt patch changes announce guidance. | Gateway emits structured child completion/result and parent resume semantics. | Upstream structured completion event with child session id, parent session id, status, and final result. |
| Parent/child lineage | `sessions.list(spawnedBy)` | child session `key`, `label`, `spawnedBy` | Fallbacks infer child from toolCallId, label, parent session id, and persisted rows. | Gateway lineage is canonical; UI details use child session id. | Normal Subagent UI path has `childSessionId` and fallback warn count is 0. |
| Subagent history | `chat.history(childSessionId)` | child session `messages[]` | Existing fallback probes tool results, in-memory messages, and labels. | Child history is fetched directly by child session id. | Renderer/IPC always passes OpenClaw child session id for new Subagents. |

## Notes

- `cowork_messages` is a UI cache. It must not participate in runtime decisions.
- `cowork_subagents` is UI cache or migration metadata. It must not decide
  Subagent lifecycle, completion counts, or whether a parent resumes.
- Missing Gateway structure should become an OpenClaw upstream issue or PR before
  adding new local guessing logic.
- Temporary fallback paths should log warnings so normal-path usage can be driven
  to zero before deletion.
