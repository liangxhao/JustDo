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

Windows packaging uses `packaging/prepare-windows-build.cjs` to verify and reuse
the prepared locked runtime, or rebuild it from pristine inputs when stale.
`OPENCLAW_FORCE_INSTALL=1` deliberately disables reuse; remove that environment
variable for normal repeated builds. The packaging hook prepares Python, Git and
speech in independent child processes. Runtime compression selects up to four
native workers within CPU/memory limits; `RUNTIME_COMPRESSION_WORKERS=0` keeps the
streaming path, while 2–8 requests a bounded parallel worker count. All packaging,
source-proof and final-archive checks still run. See
[Windows installer](../docs/windows-installer.md) for memory and validation scope.

`test/verify-native-skill-state-runtime.mjs [runtime-directory]` runs opt-in checks
of installed-skill discovery and interactive Code Mode session storage through a
real isolated Gateway and QuickJS executor. It uses synthetic imported skills and
a loopback model, checks exact whole-run terminals, restarts its own Gateway, and
writes local evidence under `.agent-tasks/runtime/skill-state/`. It never reads
user configuration or connects to the running app. Run it against the freshly
prepared runtime; it also supports Electron in Node mode. This does not validate
real model decisions or MXC isolation.

If a run reached all 16 pre-restart checks but its shutdown checkpoint failed,
`[runtime-directory] --resume-restart <probe-directory>` can continue the restart
checks against that probe's private state. Evidence keeps the earlier failure
and resumed checks separate; this is not a fresh full pass.

Plugin-specific preparation and verification scripts belong to
`openclaw-extensions/<plugin-id>/scripts/`. Root npm commands and packaging hooks
delegate there; for example, draw.io owns its asset builder and packaged-asset
verifier under `openclaw-extensions/drawio/`.

### Inspect one native session's stored content

For explicitly requested storage forensics, `openclaw/inspect-session-storage.cjs`
uses Node.js 24's built-in SQLite reader to open only the selected native database
in read-only/query-only mode. It reads committed WAL data in one snapshot, decodes
current zstd event rows, and reports each record's run identity, persisted active
branch membership, Thinking/Content sizes, tool argument validity and error size.
It never starts Gateway, imports its store, migrates schemas or changes records.

```powershell
$productName = (Get-Content .\package.json -Raw | ConvertFrom-Json).productName
$databasePath = Join-Path $env:APPDATA "$productName\openclaw\state\agents\main\agent\openclaw-agent.sqlite"
node .\scripts\openclaw\inspect-session-storage.cjs --db $databasePath --session-id '<native-session-id>' --run-id '<run-id>' --include-content
```

Use the physical native `sessionId` from Gateway logs, not the product conversation
ID. The shown path is the default main-agent location; use the actual agent database
path for another assistant or a custom state directory. The standalone script can
also be copied to another computer and run with an explicit `--db` path.

Reports go under `.agent-tasks/session-storage/` in the working directory.
`--include-content` includes the exact stored event JSON, including task text;
omit it for a metadata-only report. Raw events describe what OpenClaw persisted,
not the original provider HTTP/SSE payload. `--run-id` highlights exact matches
without assigning unbound rows to that run or hiding other runs. Identical stored
text alone does not prove duplicate rendering. Active-branch membership is only
an index observation; consult `activeIndexReliable` before interpreting it.

Exit 0 means all current event rows were decoded. Exit 2 means a missing session,
unreadable rows or unexamined cold/reset archives prevent a complete conclusion;
check `coverage` rather than interpreting zero counts as absence. Exit 1 means
the inspection could not run. Archive metadata is reported without opening archive
files or restoring them; a standalone copy of a live database without its matching
WAL can omit committed data. These files are local diagnostic artifacts and must
not be committed.

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

Add `--interaction-contract` to `verify-gateway.mjs --ui` to verify rejected hidden-send
fields, same-name inline document creation, and the actual native private prompt port
in a hidden, isolated Electron browser. Chromium input exercises real activation;
programmatic prompt calls must fail. The probe then explicitly submits the returned
synthetic text to the same session and verifies model input/history. Bridge resolution
is not a model receipt. No personal state or runtime patches are changed.

Add `--presentation` to `--ui --interaction-contract` for the actual Lit widget viewer
and native iframe chain. It checks fixed components, the scenario calculator and
HTML in light/dark themes at 840/312px card widths, live native viewport resizing,
and a trusted click that produces one readable inline suggestion. Synthetic screenshots
and a verification summary remain under `.agent-tasks/interactive-ui/presentation/`.
The test window stays nearly transparent and does not take focus. These checks do
not replace real-model quality or installed-app/workspace acceptance.

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

`node scripts/test/browser-local-html-smoke.cjs [html-file]` verifies native Chromium
file pages in a disposable Electron guest with the production navigation helpers.
It checks parent-directory assets/links, network modules and frames, Blob workers,
forms, popups and redirects without Gateway, user state or public network access.
The optional HTML file is opened unchanged and checks the globe example's canvas
and loading indicator; that extra check uses the document's own dependencies.

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

`node scripts/openclaw/probe-sqlite-retirement.mjs <runtime-directory>` uses
disposable SQLite databases and a real worker to reproduce the retiring WAL
checkpointer's foreground write lock, then verifies nonblocking close while an
older reader remains open. An unpatched runtime supplies the negative control;
already patched runtimes run the fixed case. It never opens native user history.

`node tests/openclaw/runtime/sqlite-retirement-lifecycle.native-smoke.mjs <runtime-directory>`
checks the real prepared-runtime backup, update rollback, deletion exclusion,
integrity receipts, exit callbacks and fresh-process recovery with synthetic
databases. Run with Node and Electron's Node runtime. Successful fixture roots
are removed; failures report and retain only their isolated state for diagnosis.

`node scripts/openclaw/agent-team/probe-agent-team-peer-return.mjs <runtime-directory>`
runs a local fixture model and isolated Gateway with a scoped exact-session send
grant. It verifies repeated writer results start actual organizer executions and
receive whole-run terminals under concurrent history/list reads. Run it with the
Electron Node runtime as well as Node when investigating packaged behavior.

The SQLite probes target 10.4: final maintenance stop is awaited, rollback uses
backup-bound migration write receipts, and logical writes invalidate stale authority.
The contention probe imports the current 025 transformer. See the
[current patch inventory](patches/v2026.10.4/README.md) and
[upgrade evidence](../docs/openclaw-upgrades/v2026.10.4/README.md) for executed
Node/Electron cases and the peer-return validation scope.

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
