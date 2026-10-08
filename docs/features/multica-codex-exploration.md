# Multica Codex compatibility exploration

Explored on 2026-10-05 in an isolated worktree based on JustDo
`ea59a98d795d750f1629638ab0ff3722c22ac4a6`. Multica source and existing user
conversations were not modified. An isolated verification
runtime profile, private agent and test chats were created through the installed
Multica CLI/API; existing agents were left unchanged.

## Evidence and scope

The installed desktop's bundled `multica.exe --version` reports **0.6.1**,
commit **2ea01ae4e**, built 2026-10-01. The adjacent Multica checkout has the
same HEAD. This makes the source inspection relevant to the installed binary;
it does not constitute an end-to-end execution test.

`scripts/multica/probe-codex-reuse.cjs` starts the actual
`BrowserExtensionChatServer` with a synthetic execution API, uses a fresh local
WebSocket and a probe-only credential, and checks:

- initialize accepts Multica-style JSON-RPC framing;
- Codex text input reaches the execution API;
- thread/resume returns Method not found;
- a live tool event becomes thread/stream, not item/started;
- interrupt emits turn/completed.

All five checks passed. Observed notifications: thread/started, turn/started,
thread/updated, thread/stream, turn/completed. The probe does not call a model,
connect to the running app, or run the Multica adapter. Its backend is synthetic.
It transpiles the actual TypeScript server for execution, without type checking.

Run from this worktree, using dependencies from the primary checkout if needed:

```powershell
node scripts/multica/probe-codex-reuse.cjs E:/workspace/JustDo
```

## Reuse boundary

The browser controller already owns useful Gateway subscription, session
execution, interruption and history projection. subscribeThreadEvents receives
agent/session.tool/chat events, filters session ownership and resubscribes after
Gateway reconnects. Extract the reusable execution/subscription operations into
an explicit service rather than coupling Multica to the browser transport.

The existing server is a browser-specific protocol subset, not a drop-in Codex
runtime. In particular:

| Area          | Current browser endpoint                            | Multica Codex expectation                             |
| ------------- | --------------------------------------------------- | ----------------------------------------------------- |
| Transport     | authenticated WebSocket with fixed extension Origin | spawned app-server --listen stdio:// process          |
| Events        | thread/stream and thread/updated                    | item/started, item/completed, item/agentMessage/delta |
| Tools         | custom toolCall history objects                     | commandExecution, fileChange, mcpToolCall             |
| Resume        | not implemented                                     | thread/resume                                         |
| Creation      | configured application cwd and main agent           | task cwd, model and execution overrides               |
| Configuration | desktop-managed OpenClaw configuration              | task CODEX_HOME, Codex config and MCP setup           |

Do not spoof the browser extension Origin or reuse its discovery credential as
the production integration. Retain a separately authenticated local Multica
entrypoint, with request/session ownership and cancellation handling.

## Local rollout gate: narrower than initially assumed

Multica's daemon gateCodexResumeToRolloutPresence clears a prior session ID when
CodexResumeRolloutPresent returns false. codexSessionResumable also checks file
presence before retaining a resumable pointer. The current implementation uses
filepath.Glob over these layouts:

```text
sessions/rollout-*-<sessionId>.jsonl*
sessions/*/*/*/rollout-*-<sessionId>.jsonl*
```

That specific check does not parse transcript contents. Consequently, an
identity-only session marker can satisfy this gate without duplicating
OpenClaw history. A second task in the same test chat reached thread/resume
with the original thread identity in the installed Multica daemon. Other paths inspect rollout session_meta for token usage,
and Multica manages links and cleanup around its task session store.

If pursued, markers must contain only identity/ownership metadata, be confined
to the verified task session store, and point back to durable application-owned
external session mappings. OpenClaw remains the transcript authority. Do not
create fake assistant/tool history or usage counts. Resume must reject deleted,
foreign or mismatched cwd/agent mappings, even if a marker survives.

## Experiment plan without changing Multica

1. Add an isolated stdio launcher and authenticated Main bridge, implementing
   initialize, thread/start, thread/resume, turn/start and turn/interrupt.
   Audit optional naming/steering calls and runtime detection/model discovery.
2. Bind task identity, cwd and selected assistant explicitly. The current
   OpenClaw bridge requires OPENCLAW_CONFIG_PATH; Codex tasks instead prepare
   CODEX_HOME, so its environment validation cannot be reused unchanged.
3. Convert live Gateway tool events to supported Codex items with stable call
   IDs; convert visible assistant text separately from final-answer selection.
   End the turn only on authoritative whole-run completion. Do not convert
   reasoning into fabricated tools or assistant answers merely to make it visible.
4. Verify identity-only markers through actual Multica task execution, a second
   turn, daemon restart and cancellation. Preserve native history ownership.
5. Verify how Multica's task MCP configuration and task-scoped credentials reach
   the OpenClaw execution context. A protocol handshake alone does not prove
   that task reporting, tools, model selection or workspace instructions work.

Multica's current Codex adapter displays command/file/MCP activity and assistant
text. It does not map reasoning content, and MCP results are reduced to status,
duration and error rather than the full tool payload. Text deltas are partly
aggregated. These remain limitations even after successful compatibility.

## Installed-runtime verification

The installed Multica 0.6.1 daemon discovered a separate Codex-provider runtime
whose launcher ran a controlled stdio fixture. Its task message API recorded an
MCP tool-use item eight seconds before the tool-result and final-answer items.
A second task resumed the same thread using only a session_meta marker. These
checks exercised the actual installed adapter and cloud task event storage,
but used synthetic execution. They do not prove model execution or UI rendering.

The Windows launcher must flush each forwarded stdin chunk. Buffered forwarding
stalled the initialize handshake in the first attempt.

A subsequent isolated native OpenClaw Gateway connected and created sessions,
but model requests failed under the standalone network configuration (private
DNS-address/SSRF rejection). Copying the runtime separately avoided interference
from an unrelated rebuild in the primary checkout. No successful native tool
execution or model answer was obtained. Automatic approval rejected application
startup and later proxy/restart actions without a detailed reason. The user was
asked to start the application normally so verification can use a working runtime.

At this stage, draft Codex modules passed four session tests but were not wired
to production. The following section records the subsequent successful real
execution and implementation; it supersedes that initial blocked state.

## Final verification and implementation

After the user started the normal application, native execution succeeded. The
installed Multica recorded write/read tool events and a final answer. A second
task resumed the same conversation and read the file created by the first task.

The experiment was then repeated through the production launcher source, bridge
client/server, Codex session/backend, SQLite stores and execution adapter. An
isolated test host supplied application startup/router preparation and connected
to the running application's Gateway. It returned `PRODUCTION VERIFIED maple-4816`
and `PRODUCTION RESUMED maple-4816`; the Multica task API contained the intermediate
tool events. No Multica source change was required.

A separate cancellation task recorded the adapter receiving abort at
1791134877157 and native execution settling at 1791134877402 (245 ms later).
The installed Multica marked the task cancelled. These are lifecycle timestamps,
not copied transcript records.

The worktree now replaces the external OpenClaw command interface with Codex
stdio bridge v4. Setup instructions select the Codex provider. Native OpenClaw
execution and transcript ownership remain unchanged. Refer to
[multica-integration.md](multica-integration.md) for supported functionality and
limitations, notably absent reasoning rendering and task-specific Codex MCP/env
injection. The packaged installer and visual Multica UI were not tested.

Verification used the local authenticated Multica profile. No credentials or raw
native logs are included in tracked files. Go was not available, so Multica's Go
test suite was not run. JustDo's focused integration tests ran under Electron's
Node mode to match the installed SQLite ABI, without rebuilding shared dependencies.
