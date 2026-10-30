# Repository scripts

Scripts are grouped by responsibility. Use the npm commands in `package.json` as
stable entry points; direct script invocations use the paths below.

Application resource ownership is documented in [`resources/README.md`](../resources/README.md).
Icon tooling uses `resources/icons/`; Python preparation reads its tracked inputs
from `resources/python/`. Offline downloads are cached under
the repository-root `cache/<capability>/`. Prepared runtime payloads are written
to `build/runtimes/{mingit,python-win,local-tts}/`, which development and packaging
consume directly. Installed runtime directory names remain unchanged.

Generated build artifacts share the repository-root `build/`: prepared runtimes
use `build/runtimes/`, Windows runtime archives use `build/tar/`, local speech model artifacts use
`build/speech-models/v1/`, and the Chrome extension package uses `build/chrome-extension/`.
The build and cache directories are ignored by Git.

Local speech model preparation, packaging and upload to the internal download
service are documented in [speech model releases](../docs/features/speech/local-speech-model-release.md).

## Directory map

| Directory                 | Responsibility                                                                |
| ------------------------- | ----------------------------------------------------------------------------- |
| `assets/`                 | Application/tray icons, macOS icon repair and pet graphics                    |
| `build/`                  | Vite build integration                                                        |
| `chrome/`                 | Desktop adapters for Chrome content bundles and Native Messaging              |
| `diagnostics/`            | Explicit read-only support evidence and native-session inspection             |
| `electron/`               | Electron development startup, ports, shutdown and native module rebuilds      |
| `external-agent/`         | Console CLI generation and profile-bound development launchers                |
| `fixtures/`               | Native installer and browser-recording verification fixtures                  |
| `openclaw/`               | Locked runtime installation, patch orchestration, verification and bundling   |
| `packaging/`              | Builder hooks, resource archives, installers, signing and update validation   |
| `patches/<version>/`      | Versioned native transformers, source locks and inventories                   |
| `plugins/`                | Host plugin/SDK assembly, development preparation and bundled-skill selection |
| `runtime/`                | Bundled Node, Git, Python and speech preparation; dependency fixes            |
| `startup/`                | Browser-only rehearsal of startup presentations                               |
| `test/`                   | Core test runner, its helpers and the workspace-window probe                  |
| `test/browser/`           | Embedded-browser, widget-viewer and guest-window probes                       |
| `test/openclaw/`          | Opt-in native runtime probes and prepared-SDK test profiles                   |
| `test/plugin-management/` | Plugin marketplace, import UI and publication probes                          |
| `test/plugin-host/`       | Generic SDK, Main/Browser loading and lifecycle boundary probes               |
| `test/smart-canvas/`      | Host Widget/native-renderer integration probes                                |
| `theme/`                  | Offline theme CSS generation and Tailwind integration                         |

Keep helpers beside their entry points and import cross-domain helpers explicitly.
Locate repository assets from the script location. Explicit user input, portable
diagnostic output and test profiles that declare a checkout working directory retain
their documented current-directory semantics. Versioned patches stay under
`patches/`; orchestration stays in `openclaw/`. Plugin-owned scripts stay in
`plugins/<category>/<plugin-id>/scripts/`; host adapters and integration probes
remain here when they exercise application boundaries.

## Development and test entry points

`validate:product-metadata` validates the product name and both application and
OpenClaw release versions before packaging prepares resources or removes old
outputs. Version validation shares the startup parser: three numeric components,
an optional lowercase `v`, no leading zeros or prerelease/build suffixes. For
example, use `v2026.11.2`, not `v2026.11.02`. Builder configuration loading and
update metadata generation also enforce this rule; invalid values fail with the
field and original value rather than being silently normalized.

`npm test` runs Vitest with standalone Node.js 24. It prepares a private SQLite module under `build/test-dependencies/`, runs Core and discovered app-plugin suites, and removes that private module afterward without replacing the application's Electron bindings. The configuration rejects Electron drivers before suites load; the runner regression uses a disposable harmless suite and Electron in Node mode to verify that refusal. Repair application bindings separately with `npm run rebuild:electron-native`.

`npm run startup:preview -- --route upgrade --language zh --theme light` starts a
loopback browser rehearsal using the actual startup components. Routes are
`fresh`, `migration`, `upgrade` and `normal`; language and theme are closed choices.
The page simulates progress and failures in memory without Main, a user profile,
database maintenance or Gateway. It cannot replace native upgrade validation.

The console executable provides CLI, ACP and the supported Codex app-server entry.
Generation scripts live under `external-agent/`; development launchers are prepared
under `.agent-tasks/external-agent/development/`. See
[Agent CLI / ACP](../docs/features/external-clients/agent-cli.md).

## Runtime and plugin preparation

`openclaw/sync-openclaw-runtime-resources.cjs` reads role templates and channel
documentation from `resources/openclaw/docs/` and assembles them at the native
runtime's `docs/` paths. These are runtime assets; repository design and feature
documentation live in the root `docs/` directory.

`openclaw/prune-openclaw-runtime.cjs` reads `plugins/extensions/prune-policy.json`
to select the upstream OpenClaw extensions retained in the runtime. The policy is
reviewed for the locked OpenClaw version and included in the build fingerprint;
local extension directories are protected separately.

`openclaw/openclaw-bundled-dependencies.cjs` preserves complete dependencies
declared by the authenticated pristine OpenClaw package after npm installation.
Its `runtime-bundled-dependencies.json` records their source, registry base origin
and complete file inventory. The build proof binds that inventory; pruning and
frozen-runtime verification check it without replacing or re-signing existing
artifacts. This keeps OpenClaw's bundled Chrome MCP fixes through preparation.

Gateway bundling reports companion verification and each patch application and
verification stage with elapsed time. Native support checks reuse one complete
declaration index for identical bundle content while independently validating
each helper and owner; changed content is parsed again. Copying bundle assets
does not finish the subsequent patch and syntax checks.

Python preparation verifies a build-only package proof before reusing the locked
dependencies. It reinstalls only when that proof, the preparation inputs or the
installed files no longer match; import checks remain enabled. The proof is kept
beside the runtime at `build/runtimes/python-win-packages-proof.json` and is not
included in the installer. Existing prepared trees install once to create it.

`plugins/sync-bundled-skills.cjs` reads `plugins/skills/builtin-skills.json`, validates the selected application/native skill sources, and synchronizes the prepared runtime. Its callers retain the runtime and packaging lifecycle. The native recipe binds script paths and bytes, including this helper; changed recipe inputs require fresh preparation, never editing or re-signing an old proof.

Plugin-specific preparation and verification scripts belong to
`plugins/extensions/<plugin-id>/scripts/`. Root npm commands and packaging hooks
delegate there; for example, draw.io owns its asset builder and packaged-asset
verifier under `plugins/extensions/drawio/`.

`plugins:app:build` discovers app manifests and produces independent Native/Main/UI
packages plus a portable SDK. `plugins:app:sdk` emits the SDK alone; the builder also
accepts a source directory and destination for author-owned packages. No application
business imports are permitted in these artifacts. `plugins:app:verify` runs portable
SDK and actual built Main/Chromium smoke probes. Additional isolated negative controls in
`scripts/test/plugin-host/` cover authorization lifetimes, retained cleanup, cold process
stop, native execution receipts, resource veto and structured input. See
`docs/plugins/sdk/app-plugin-runtime.md` for supported scope and remaining acceptance.

The implementation lives in `plugins/sdk/app-plugin-build/`, distributed as
`@app-plugin/build`; the public App SDK source is `plugins/sdk/app-plugin-sdk/`. It resolves
installed SDK exports and the public theme preset, without ancestor tsconfig source
aliases. `plugins:runtime:sdk` emits the separate Runtime Services library into
`build/runtime-services-sdk`; preparation and pack commands are in the
[SDK development guide](../docs/plugins/sdk/development-and-distribution.md#distribution). Each app plugin declares its dependencies and has its own
Vitest configuration. Default `npm test` discovers those suites and runs them after
Core tests; explicit `tests/host/` boundaries remain in the Core integration profile.

Required Runtime Services now publishes a pinned, read-only capability binding.
After changing its source, prepare runtime resources before launching the application
(`npm run openclaw:resources` or the full prepared-runtime development command).
Resource assembly verifies the frozen native runtime before emitting the private
managed-execution profile for its actual bundle. App companion preparation alone
does not upgrade a previously prepared Required Service or authorize unknown native
capabilities. No runtime patch is added by this SDK extraction.

The optional source conformance profile uses an explicit `OPENCLAW_SOURCE_ROOT` and
`plugins/extensions/runtime-services/tests/sdk/native-routing.vitest.config.mts`.
It exercises real native registry, authorization, dispatcher and public background
context implementations, with synthetic clients and state; it does not start a
listening Gateway or a model. The optional unused-dependency shim flag only makes
unreached third-party branches throw in an incomplete development dependency tree.

Runtime resource preparation and Electron startup build current app companions through
their npm lifecycle hooks. Native resource sync copies the complete built package so
the executed native entry matches its companion's binding. When invoking
`sync-openclaw-runtime-resources.cjs` directly, run `npm run plugins:app:build` first;
missing artifacts fail explicitly rather than rebuilding a different native entry.

## Windows packaging and licenses

Windows packaging uses `packaging/prepare-windows-build.cjs` to verify and reuse
the prepared locked runtime, or rebuild it from pristine inputs when stale.
`OPENCLAW_FORCE_INSTALL=1` deliberately disables reuse; remove that environment
variable for normal repeated builds. Native fingerprints exclude host compilation
and installer/archive policy; actual native inputs, branding and the full root
dependency lock remain bound. The packaging hook prepares Python, Git and
speech in independent child processes. Runtime compression selects up to four
native workers within CPU/memory limits; `RUNTIME_COMPRESSION_WORKERS=0` keeps the
streaming path, while 2–8 requests a bounded parallel worker count. All packaging,
source-proof and final-archive checks still run. See
[Windows installer](../docs/windows-installer.md) for memory and validation scope.

Windows archives reuse `build/tar/win-resources.tar.zst` only when the selected
source content, packaging recipe and output hashes match
`build/tar/win-resources-proof.json`. Changed timestamps alone do not force
recompression. Cold builds verify the actual tar bytes against their input
inventory and publish archive/metadata/proof with rollback. Final artifact checks
remain enabled; Windows draw.io verification shares the first runtime extraction.

`packaging/installer-animation-assets.cjs` renders the existing application icon
into native installer AVI/bitmap assets under `build/installer/<fingerprint>/`.
Windows NSIS script composition prepares and verifies this cache automatically;
the generator uses Node built-ins, with no new downloaded build or runtime tool.
`packaging/nsis-install-presentation.nsh` owns the native light install page,
while `packaging/nsis-shell-extraction.nsh` reads actual 7-Zip phase progress.
`packaging/nsis-setup-presentation.nsh` combines scope and directory in one native
nsDialogs page, using the existing mode and UAC helpers. It owns per-scope drafts,
path validation, upgrade locking and one accepted Install action. Its images and fonts are
released before the install-progress page takes ownership.
`packaging/nsis-presentation-window.nsh` keeps a shared compact canvas across
these pages, centers only its first display and retains a dragged position on
scope changes and entry into file writing. The native caption supports Minimize
and Close; installation details appear directly without a reveal button.
Each native page owns its caption hairline;
the combined card uses native radio and edit controls. Separate square logo assets avoid
distorting the wider animated scene. The scene's blue light arc makes a complete
orbit, and NSIS selects only a DPI variant whose full canvas fits.
`packaging/installer-clock-assets.cjs` verifies the checked-in native elapsed-time
clock under `resources/installer-clock/win-x86/` before NSIS embeds it. Normal
packaging needs no MSVC installation, SDK, network access or generated clock
cache. Only its explicit `--rebuild` mode uses installed MSVC x86 tools and a
Windows SDK, retaining compiler intermediates under `build/installer-clock/`.
The manifest binds normalized source content, build flags and DLL bytes; missing,
changed or stale assets fail with instructions to refresh the bundle. See
[Windows installer](../docs/windows-installer.md#installation-presentation-and-measured-progress)
for verification and rebuild commands.
The clock uses only Windows system libraries and keeps updating while the
installation worker performs synchronous work; it never calls back into NSIS
script code.
The presentation does not start Electron or initialize a user profile. See
[Windows installer](../docs/windows-installer.md#installation-presentation-and-measured-progress)
for progress boundaries, fallback behavior and validation limits.

The opt-in `tests/packaging/nsis-presentation.test.ts` opens presentation-only native
fixture windows, verifies changing pixels and terminal states, and closes them
automatically. Run it on a visible Windows desktop with
`$env:INSTALLER_PRESENTATION_NATIVE_UI='1'` and
`node node_modules/vitest/vitest.mjs run tests/packaging/nsis-presentation.test.ts`.
It installs no application and saves a sample screenshot at
`build/installer-presentation-preview.png`. Default automated checks skip this
visible-window test; full NSIS compilation and extraction checks remain enabled
when the cached compiler is available.
The screenshot contains a simulated phase percentage; the fixture does not
extract the application payload. Button rendering uses Windows' existing GDI+
through `packaging/nsis-presentation-controls.nsh`, with no new downloaded tool.
`packaging/nsis-presentation-motion.nsh` handles the bounded entrance/exit using
temporary native opacity and position changes; its fixture trace reads the
actual Windows properties and checks style/position restoration.
The same fixture verifies elapsed time with worker polling deliberately paused,
freezes the clock at terminal states, and checks the lower details-list bounds.
Upgrade directory policy fixtures use isolated registry keys and real NSIS callbacks;
they never install the application or modify its registration.
The separate opt-in `tests/packaging/nsis-setup-presentation.test.ts` checks
the native combined setup page with isolated elevation ports and saves
`build/installer-combined-setup.png`.
It checks the visible mark's proportions, the painted caption separator, and
continuous native window coordinates after a drag, scope changes and direct entry
into file writing. The entrance runs once across that whole sequence.

Vite's `scripts/packaging/application-license-assets.cjs` plugin records actual
third-party modules for Renderer, Main and all preload builds. It copies
their original package metadata and legal materials, including transitive
dependencies, to `build/application-licenses/<scope>/`. Each scope has a private
`source-proof.json` binding the compiled output and source legal files. Builder
hooks verify every required scope before packaging and verify the copied public files
under `resources/licenses/application-dependencies/` afterward; private scope
proofs are excluded from the installer. Rebuild the application after changing
compiled inputs or legal materials instead of updating a proof in place. Each scope
publishes its complete staged tree by rename. On Windows, transient `EPERM`,
`EBUSY` or `EACCES` rename failures receive at most five retries with increasing
50 ms delays (750 ms total); owned build paths are revalidated before every
attempt. A persistent failure still blocks the build and removes the unpublished
staging tree.

`packaging/windows-installer-script.cjs` composes upstream NSIS templates at the
project-scoped final-script build seam. It retains electron-builder's two-pass
uninstaller generation/signing, extracts the shell under the selected installation
root and removes the installer EXE copy into the AppData updater cache. Do not use
`nsis.script` for this composition: that skips native uninstaller generation.

`packaging/pack-runtime-resources.cjs` owns the combined Windows archive of OpenClaw, Python, Git and speech resources. Its worker protocol and archive layout are independent of native runtime preparation; the archive cache binds this packer and its helpers separately.

## Chrome adapters

Chrome Assistant owns its source snapshots, assembly script, Markdown renderer
and UI unit tests in `plugins/chrome-extensions/chrome-assistant/`. The stable
`chrome-extension:prepare` command delegates to its `scripts/prepare.cjs`.
`chrome/` retains adapters that reuse application chat rendering, translations
and streaming, together with the desktop Native Messaging helper and registration.

Chrome Assistant assembly and operator-driven webpage probes belong to the distributed plugin. The host Markdown command also builds rich-content and styles from application chat code, so that composite adapter remains in `chrome/`. Commands, prerequisites and validation limits are in the [side panel](../docs/plugins/chrome-extensions/chrome-assistant/side-panel.md) and [webpage entry](../docs/plugins/chrome-extensions/chrome-assistant/website-launch.md) documentation.

Run the isolated native run/result probe with `<runtime>/node-runtime/node[.exe] scripts/test/openclaw/verify-browser-web-result.cjs --runtime-dir <prepared-runtime>`. It requires that selected runtime's bundled Node and verifies its frozen proof before using a disposable Gateway and deterministic loopback model. It never uses an existing user profile, Gateway or real provider; artifacts remain under `.agent-tasks/browser-artifacts/` and private fixture state under `build/`. This is a native capability probe; the Chrome integration's findings and limits remain in the webpage entry documentation.

## Explicit diagnostics

`diagnostics/collect-model-auth-evidence.ps1` extracts a small model-authentication
report from explicitly selected received log files. It works with Windows
PowerShell 5.1 and PowerShell 7. Run it without arguments to choose one or more
Main, Gateway or native JSON log files; it does not search the local application
profile. By default it selects the latest authentication failure and includes
30 minutes before and 5 minutes after it. `-ErrorTime` selects a specific incident;
timestamps without an offset use `-SourceUtcOffset` (default `+08:00`).

The UTF-8 report defaults to a hard 16 KiB limit, including headers and truncation
notes; `-MaxKiB` accepts 4–64 KiB. It includes only recognized events and
allowlisted scalar values, timestamps, source aliases and line numbers. It does
not copy raw log text, filenames, paths, credentials or conversation content.
Repeated mirrored records retain a record count rather than implying independent
failures. Reports are written to the Desktop unless `-OutputDirectory` is given;
the original files remain unchanged. No network, Gateway startup or repair command
is used. See [development diagnostics](../docs/development.md#日志与排障).

### Inspect one native session's stored content

For explicitly requested storage forensics, `diagnostics/inspect-session-storage.cjs`
uses Node.js 24's built-in SQLite reader to open only the selected native database
in read-only/query-only mode. It reads committed WAL data in one snapshot, decodes
current zstd event rows, and reports each record's run identity, persisted active
branch membership, Thinking/Content sizes, tool argument validity and error size.
It never starts Gateway, imports its store, migrates schemas or changes records.

```powershell
$productName = (Get-Content .\package.json -Raw | ConvertFrom-Json).productName
$databasePath = Join-Path $env:APPDATA "$productName\openclaw\state\agents\main\agent\openclaw-agent.sqlite"
node .\scripts\diagnostics\inspect-session-storage.cjs --db $databasePath --session-id '<native-session-id>' --run-id '<run-id>' --include-content
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

## Opt-in verification

These commands are separate from ordinary test discovery. Use only the selected prepared runtime and the prerequisites of the owning contract. Moving a probe does not establish new acceptance evidence or require every Gateway/browser/installer probe during routine builds.

### OpenClaw runtime

`test/openclaw/verify-native-skill-state-runtime.mjs [runtime-directory]` runs opt-in checks
of installed-skill discovery and interactive Code Mode session storage through a
real isolated Gateway and QuickJS executor. It uses synthetic imported skills and
a loopback model, checks exact whole-run terminals, restarts its own Gateway, and
writes local evidence under `.agent-tasks/runtime/skill-state/`. It never reads
user configuration or connects to the running app. Run it against the freshly
prepared runtime, using that runtime's standalone Node executable. This does not validate
real model decisions or MXC isolation.

If a run reached all 16 pre-restart checks but its shutdown checkpoint failed,
`[runtime-directory] --resume-restart <probe-directory>` can continue the restart
checks against that probe's private state. Evidence keeps the earlier failure
and resumed checks separate; this is not a fresh full pass.

`test/openclaw/verify-session-review.cjs [runtime-dir] [evidence-json]` checks T03 against a
prepared Gateway using native session baseline filtering. It creates its own temporary config,
credentials, Git repository and sessions, stops the test Gateway when finished,
and prints only synthetic evidence. It never uses the application's live state.

`node scripts/test/openclaw/verify-code-mode-runtime.mjs [runtime-directory]` checks the
packaged QuickJS Code Mode worker and assets, then exercises execution,
wait/resume, text encoding, errors, and cancellation without model/API calls.
It defaults to `vendor/openclaw-runtime/current` and does not modify the runtime.

`node scripts/test/openclaw/verify-peer-compaction-runtime.mjs [runtime-directory]` starts
a real Gateway with disposable state and a deterministic loopback model. A main
turn sends work to a peer through native `sessions_send`, the peer sends an
acknowledgment, and large native tool results trigger automatic compaction while
history is polled. It checks continued execution, the persisted final reply and
unchanged native session identity. `--provider-overflow` exercises provider-side
overflow; `--abort-during-compaction` checks cancellation; `--provider-failure`
checks durable error persistence after compaction. With an older runtime,
`--expect-writer-error` asserts the original transcript-writer failure. Artifacts
remain under `.agent-tasks/runtime/peer-compaction/<uuid>/`; no live configuration, credentials or transcripts
are read or modified. The model is a fixture, so this does not validate a real
provider's summary quality or the complete product UI.

`test/openclaw/verify-decision-secret-runtime.cjs [runtime-dir]` exercises a prepared Gateway
bundle and its dynamic TypeSafe SDK with an isolated file SecretRef and local
synthetic provider. It covers first use, rotation, unavailable-owner denial and
recovery without a chat model or user credentials.

`node scripts/test/openclaw/prepare-npx-mcp-smoke.cjs` packs the dependency-free local
`tests/openclaw/fixtures/npx-mcp-smoke/` package and primes an isolated offline npm
cache. On Windows it verifies real npx package-bin startup through Main's command
projection and the bundled native MCP transport, including Unicode/space shim
paths and tool calls. It writes form arguments, configuration and verification
evidence under `.agent-tasks/npx-mcp-smoke/` for manual product testing; it never
changes the application's MCP entries or live Gateway state.

`node scripts/test/openclaw/probe-sqlite-retirement.mjs <runtime-directory>` uses
disposable SQLite databases and a real worker to reproduce the retiring WAL
checkpointer's foreground write lock, then verifies nonblocking close while an
older reader remains open. An unpatched runtime supplies the negative control;
already patched runtimes run the fixed case. It never opens native user history.

`node tests/openclaw/runtime/sqlite-retirement-lifecycle.native-smoke.mjs <runtime-directory>`
checks the real prepared-runtime backup, update rollback, deletion exclusion,
integrity receipts, exit callbacks and fresh-process recovery with synthetic
databases. Run with the standalone Node shipped in the target runtime. Successful fixture roots
are removed; failures report and retain only their isolated state for diagnosis.

`<runtime-directory>/node-runtime/node[.exe] tests/openclaw/runtime/plugin-session-current.native-smoke.mjs <runtime-directory>`
verifies the frozen v2026.10.7 execution-session guard using actual native workers and SQLite.
An owner-only update with the same session ID/revision must invalidate the live assertion;
stale initial reads and lifecycle replacement must also fail. It retains synthetic evidence
under `.agent-tasks/runtime/plugin-session-current/` and never starts a Gateway.

The SQLite probes target 10.7: final maintenance stop is awaited, rollback uses
backup-bound migration write receipts, and logical writes invalidate stale authority.
The contention probe imports the current 025 transformer. See the
[current patch inventory](patches/v2026.10.7/README.md) and
[upgrade evidence](../docs/openclaw-upgrades/v2026.10.7/README.md) for executed
cases and the remaining validation scope. Historical 10.4 Node/Electron results
remain in their own upgrade record and do not establish target-version acceptance.

`test/openclaw/run-openclaw-module-contracts.cjs --runtime-dir <frozen-runtime> --source-root <target-source>` runs the Core module gate with exact source-tag and prepared-runtime admission. Optional Team/Workflow send checks are separate plugin commands. Prepared-SDK Vitest profiles are `test/openclaw/acpx.vitest.config.mts`, `test/openclaw/typesafe.vitest.config.mts` and `test/openclaw/workboard-upstream.vitest.config.mts`; run from the checkout root and follow the required runtime/source environment variables in each profile.

### Embedded browser and widgets

`node scripts/test/browser/browser-local-html-smoke.cjs [html-file]` verifies native Chromium
file pages in a disposable Electron guest with the production navigation helpers.
It checks parent-directory assets/links, network modules and frames, Blob workers,
forms, popups and redirects without Gateway, user state or public network access.
The optional HTML file is opened unchanged and checks the globe example's canvas
and loading indicator; that extra check uses the document's own dependencies.

`node scripts/test/browser/widget-viewer-proxy.cjs <runtime-dir>` verifies the dedicated
desktop widget session with the locked native sandbox and canonical HTML wrapper.
It uses a temporary profile and a local fake proxy, checking allowed script routing,
unchanged CSP blocking, storage isolation, trusted-click draft suggestions and
capability revocation. It verifies matching viewport dimensions across the webview,
viewer and both native sandbox frames during inline display, expansion, window
resize and collapse, with bottom controls visible and local input preserved.
It also covers immediate collapse during window resizing and subsequent content
growth. Add `--viewport-content` for a canvas that fills `100vh`, verifying no blank
strip and no retained expanded height. Add `--partial-viewport-content` to reproduce
a standalone canvas container authored with `70vh` and a 480px minimum: expansion
must fit the actual canvas to the full viewport, including tall windows and zoom
changes; collapse must restore 480px without stale canvas overflow growing the card.
The canvas uses its own ResizeObserver to redraw, preserving local input. Ordinary
flow content remains separately covered by the default fixture.
It captures real expanded-size events and
replays them after collapse with up to 1.2 seconds of extra delay to verify that
old layout revisions cannot resize the inline card.
It also checks guest crash/retry recovery, rapid replacement without unhandled
asynchronous IPC rejections, and an unaffected default-session WebSocket during
proxy changes. Add `--workspace` to run the same checks in a real
workspace WebContentsView without the application preload. No personal Gateway
is started and temporary fixture files are removed on completion.
After `npm run build`, add `--built-viewer` to exercise the emitted viewer assets
and minimal preload under the immutable packaged-asset host and production CSP.

`node scripts/test/browser/browser-native-widget-smoke.cjs` verifies real Chromium widget
viewport sizing with an isolated profile and local nested sandbox documents. It
checks expanded height, responsive canvas redraw on resize, draft-suggestion space,
preserved inline height/input and scrolling inside long documents. A real native
sidebar view hides during expansion and returns with the same document on collapse
or unmount. Public network access is blocked; test artifacts stay under
`.agent-tasks/browser/widget-viewport-*/`.

The other `test/browser/` commands cover embedded-browser recording, intervention, PDF/sidebar display, background lifetimes, retries and cron. `test/workspace-window-probe.cjs` exercises workspace windows and uses the fixtures under `tests/workspace-window/`. Their names refer to the embedded browser; Chrome extension verification belongs to its plugin.

### Plugin host and management

`node scripts/test/plugin-host/verify-plugin-host-assumptions.mjs` checks app
plugin architecture assumptions with disposable modules, an in-memory database,
and a hidden Electron window. It verifies ESM generation caching, shared React
Hooks, and the actual immutable renderer host/CSP without user Gateway or app
state. It is a design probe, not a production plugin loader or full Team acceptance.

`node scripts/test/plugin-host/verify-inventory-veto.mjs` exercises the actual Main
manager, registry and journal SQL with private in-memory SQLite and a fixture native
identity. A failed resource inventory must retain its business/deletion fence after
a package preflight veto; this probe does not start a Gateway or use user state.

Run `npm run test:plugins:marketplace -- --runtime <prepared-runtime-root>` for the loopback marketplace probe. Import UI, original fixture reuse and publication-lock commands live in `test/plugin-management/`; prerequisites and retained evidence are documented in [test organization](../tests/README.md) and [marketplace integration](../docs/plugins/marketplace/integration.md#本地市场联调探针).

### Plugin-specific verification

Business probes travel with their owning plugin. Set `APP_PLUGIN_HOST_ROOT` to the host checkout for explicit integration commands; no sibling repository is inferred. `APP_PLUGIN_PROBE_SOURCE_ROOT` selects the source root, and comma-separated `APP_PLUGIN_PROBE_IDS` explicitly selects packages for generic host verification. Missing requested packages fail. With no optional plugins, the generic probes verify empty registries and report the tested package list.

- [Agent Team validation](../docs/plugins/extensions/agent-team/validation.md) owns native send, routing, source identity, discussions, settings and paired Team/Workflow checks.
- [Swarm Workflow validation](../docs/plugins/extensions/swarm-workflow/workflows.md#验证范围) owns native send/smoke commands; [batches](../docs/plugins/extensions/swarm-workflow/batches.md) documents batch boundaries.
- [Smart Canvas delivery and validation](../docs/plugins/extensions/smart-canvas/content-delivery.md#宿主集成验证) owns Gateway, registration, prompt, presentation, retention and dispatch probe commands. The host `test/smart-canvas/` adapters retain their application Widget/renderer dependency.
