# Repository scripts

Scripts are grouped by responsibility. Use the npm commands in `package.json` as
stable entry points; direct script invocations use the paths below.

| Directory    | Responsibility                                                      |
| ------------ | ------------------------------------------------------------------- |
| `assets/`    | Application and tray icon generation, macOS icon repair             |
| `browser/`   | Browser extension preparation, content bundles and native host      |
| `build/`     | Vite build integration                                              |
| `electron/`  | Electron development startup, ports and native module rebuilds      |
| `multica/`   | Multica agent launcher generation and development registration      |
| `openclaw/`  | OpenClaw runtime installation, patching, verification and bundling  |
| `packaging/` | Electron Builder hooks, installers, signing and update validation   |
| `runtime/`   | Bundled Git, Python, speech and skill preparation, dependency fixes |
| `test/`      | Test runner and browser smoke checks                                |
| `fixtures/`  | Shared script verification fixtures                                 |
| `patches/`   | Versioned OpenClaw capability patches and their inventories         |
| `theme/`     | Offline theme CSS generation and Tailwind integration               |

Keep script-specific helpers beside their entry points and import cross-domain
helpers explicitly. Resolve repository paths relative to the script location;
do not rely on the caller's working directory when locating repository assets.
Versioned patches remain under `patches/`; runtime orchestration belongs in
`openclaw/`.

`test/interactive-ui/verify-gateway.mjs <runtime-dir>` verifies the locked native
Gateway with an isolated local synthetic provider. It checks real widget tools,
authenticated document views, history/restart, prompt bridges and explicit plugin
disable, then cleans up temporary services and credentials. No user state is used.

Add `--ui` for the `interactive-answer` component path: the actual native `show_widget`
tool receives the five component kinds, both extension kinds register distinct
public resources, and authenticated views survive history/restart. Explicit
disable removes both kinds and their public resources without rewriting stored
documents. Run this separately from scenario variants and `--tool-dispatch`.
`test/interactive-ui/verify-runtime.mjs <runtime-dir>` also checks both kinds
against the locked native registrar, including duplicate-path rejection.

Add `--tool-dispatch` to the verifier for native Tool Search directory mode:
the synthetic model invokes the exact core `show_widget` through `tool_call`,
with generic HTML and the scenario plugin disabled. This checks the actual
dispatcher envelope, authenticated view and history/restart identity separately
from the direct scenario path. Do not combine it with `--ui`/`--retention`/`--extreme`.

`node scripts/openclaw/agent-team/probe-agent-team-routing.mjs <runtime-directory>` compares
ordinary group broadcast routing with a public `runGroupThread` callback that
preserves an organizer's source session. It uses isolated temporary state and a
deterministic dispatcher; no Gateway or provider is started. Assertions cover
session and delivery identity plus `toolsAllow` forwarding, not enforcement,
busy-session queueing, or durable completion delivery.

`test/verify-session-review.cjs [runtime-dir] [evidence-json]` checks T03 against a
prepared Gateway using native session baseline filtering. It creates its own temporary config,
credentials, Git repository and sessions, stops the test Gateway when finished,
and prints only synthetic evidence. It never uses the application's live state.

`node scripts/test/verify-code-mode-runtime.mjs [runtime-directory]` checks the
packaged QuickJS Code Mode worker and assets, then exercises execution,
wait/resume, text encoding, errors, and cancellation without model/API calls.
It defaults to `vendor/openclaw-runtime/current` and does not modify the runtime.

`node scripts/test/verify-peer-compaction-runtime.mjs [runtime-directory]` starts
a real Gateway with disposable state and a deterministic loopback model. A main
turn sends work to a peer through native `sessions_send`, the peer sends an
acknowledgment, and large native tool results trigger automatic compaction while
history is polled. It checks continued execution, the persisted final reply and
unchanged native session identity. `--provider-overflow` exercises provider-side
overflow; `--abort-during-compaction` checks cancellation; `--provider-failure`
checks durable error persistence after compaction. With an older runtime,
`--expect-writer-error` asserts the original transcript-writer failure. Artifacts
remain under ignored `.tmp/`; no live configuration, credentials or transcripts
are read or modified. The model is a fixture, so this does not validate a real
provider's summary quality or the complete product UI.

`test/verify-decision-secret-runtime.cjs [runtime-dir]` exercises a prepared Gateway
bundle and its dynamic TypeSafe SDK with an isolated file SecretRef and local
synthetic provider. It covers first use, rotation, unavailable-owner denial and
recovery without a chat model or user credentials.

`node scripts/test/prepare-npx-mcp-smoke.cjs` packs the dependency-free local
`tests/openclaw/fixtures/npx-mcp-smoke/` package and primes an isolated offline npm
cache. On Windows it verifies real npx package-bin startup through Main's command
projection and the bundled native MCP transport, including Unicode/space shim
paths and tool calls. It writes form arguments, configuration and verification
evidence under `.agent-tasks/npx-mcp-smoke/` for manual product testing; it never
changes the application's MCP entries or live Gateway state.

`packaging/windows-installer-script.cjs` composes upstream NSIS templates at the
project-scoped final-script build seam. It retains electron-builder's two-pass
uninstaller generation/signing, extracts the shell under the selected installation
root and removes the installer EXE copy into the AppData updater cache. Do not use
`nsis.script` for this composition: that skips native uninstaller generation.

`node scripts/openclaw/agent-team/probe-agent-team-source.mjs <runtime-directory>` runs an
isolated Gateway and local fixture model to verify source-session tool limits,
queueing, cancellation and delivery identity. The original channel path is a
negative control: its top-level routePreserved=false is expected; the internal
participation and standalone-summary variants must preserve delivery and identity.
No real provider credentials or user sessions are used.

`node scripts/openclaw/agent-team/probe-agent-team-gateway.mjs <runtime-directory>` additionally
exercises the production team extension with Main coordinators: model-created
rooms, automatic summaries, source participation/mentions, public native history
surviving source deletion, history rejection after disable and restoration after re-enable,
and settings resource limits.
Use `--history-toggle-only` to isolate history RPC registration, disabled receipt
reconciliation and restored native history after re-enabling.
Concurrency metrics use public native lifecycle events; queued cancellation and
source participation share the production permit pool. `node
scripts/test/agent-team/probe-agent-team-ui.cjs` captures isolated desktop/narrow/draft views
using the built Renderer CSS, including Team/global settings at narrow widths;
the native bridge is a fixture.

`node scripts/openclaw/agent-team/probe-agent-team-settings.mjs <runtime-directory>` verifies
the public group SDK's per-request strategy, turn budget, mention and cancellation
behavior with a bounded delayed fixture dispatcher. It measures dispatcher
concurrency, not real model execution or whole-run outcomes; see
`docs/features/assistants/agent-team.md` for production acceptance gates.

`node scripts/test/agent-team/verify-group-discussion-runtime.mjs [runtime-directory]`
uses disposable state and a loopback model with the bundled group and summary RPCs.
It verifies broadcast, native `NO_REPLY` without empty-answer retries, early completion
of a silent round, exact mentions, borrowed-source identity, source summary, whole-group
cancellation and provider failure. Fixture artifacts stay in ignored `.tmp/`; no user
configuration, credentials or history is accessed. This checks native execution contracts,
not real-model discussion quality or the complete Main/Renderer flow.
