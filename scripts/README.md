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

`test/verify-session-review.cjs [runtime-dir] [evidence-json]` checks T03 against a
prepared Gateway using native session baseline filtering. It creates its own temporary config,
credentials, Git repository and sessions, stops the test Gateway when finished,
and prints only synthetic evidence. It never uses the application's live state.

`node scripts/test/verify-code-mode-runtime.mjs [runtime-directory]` checks the
packaged QuickJS Code Mode worker and assets, then exercises execution,
wait/resume, text encoding, errors, and cancellation without model/API calls.
It defaults to `vendor/openclaw-runtime/current` and does not modify the runtime.
