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

`test/verify-session-review.cjs [runtime-dir] [evidence-json]` checks T03 against a
prepared Gateway using native session baseline filtering. It creates its own temporary config,
credentials, Git repository and sessions, stops the test Gateway when finished,
and prints only synthetic evidence. It never uses the application's live state.

`node scripts/test/verify-code-mode-runtime.mjs [runtime-directory]` checks the
packaged QuickJS Code Mode worker and assets, then exercises execution,
wait/resume, text encoding, errors, and cancellation without model/API calls.
It defaults to `vendor/openclaw-runtime/current` and does not modify the runtime.

`test/verify-decision-secret-runtime.cjs [runtime-dir]` exercises a prepared Gateway
bundle and its dynamic TypeSafe SDK with an isolated file SecretRef and local
synthetic provider. It covers first use, rotation, unavailable-owner denial and
recovery without a chat model or user credentials.

`packaging/windows-installer-script.cjs` composes upstream NSIS templates at the
project-scoped final-script build seam. It retains electron-builder's two-pass
uninstaller generation/signing, extracts the shell under the selected installation
root and removes the installer EXE copy into the AppData updater cache. Do not use
`nsis.script` for this composition: that skips native uninstaller generation.
