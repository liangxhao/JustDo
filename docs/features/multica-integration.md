# Multica integration

JustDo prepares a generated user-local `<productName>-agent` launcher for a Multica custom runtime.
The launcher connects Multica to the running desktop process, so no separately installed agent CLI
is required. The desktop process owns configuration and credentials while the bundled Agent runtime
executes each task in Multica's isolated working directory.

The integration is local-only. It does not call Multica server APIs and does not start, stop, or
restart the Multica daemon. The only Multica CLI commands JustDo may execute are `--version` and
`daemon status ... --output json`; the latter reads the daemon's loopback health endpoint.

## Lifecycle

1. Keep JustDo running or in the tray and enable the integration from Settings → External connections
   → Accept external connections.
2. JustDo detects the desktop-launched Multica profile when available and creates the launcher
   without modifying any Multica profile config or credentials. Launcher creation does not require
   the Multica daemon to be running.
3. On Windows, Multica must call a native executable directly. Batch and PowerShell wrappers are not
   compatible: batch has an 8,191-character command-line limit, while Multica's environment
   preparation calls `binary_path config file` without a custom profile's fixed arguments. Windows
   therefore uses a small native `<productName>-agent.exe` beside the app executable. It removes the
   `ELECTRON_RUN_AS_NODE` variable inherited from Multica Desktop and forwards the original argv and
   output streams to `<productName>.exe`. Development builds a native launcher under
   `%APPDATA%/<productName>/multica/development` with `npm run multica:dev-agent`; it starts the
   current worktree's Electron executable and application bundle directly, without requiring a
   packaged/unpacked app. Release packaging creates the adjacent production launcher automatically.
   Settings renders Windows command paths with forward slashes because Multica's command-line form
   treats backslashes as escape characters.
   On macOS/Linux, the product-named executable script is installed into a writable user-owned
   directory on `PATH`.
4. Settings shows the exact base protocol, display name, command, and description to enter in
   Multica's **Create custom runtime** dialog. Each value has a copy action.
5. The user creates the workspace-scoped profile from Multica. JustDo neither submits that form nor
   verifies it through the Multica server. Disabling removes only the owned local launcher.

The manual profile uses `productName` as its display name. Its command is the exact value shown in
Settings; Windows uses the native `<productName>-agent.exe` bootstrapper, while macOS/Linux use
`<productName>-agent` directly.
Creating it remains a Multica-owned operation: v0.4.32 stores custom runtime profiles on the server
and synchronizes them across the workspace. Existing server-side profiles remain usable, but this
integration neither reads nor mutates them.

Multica's OpenClaw-compatible model picker normally enumerates agent IDs instead of the configured
model catalog. The bridge replaces those discovery responses with temporary, unbranded agent entries
derived from `models.providers`. Each entry binds one configured model and exists only in Multica's
generated task config. Internal desktop agents (including the managed scheduler) are never returned
to Multica, while provider credentials and other model-provider configuration stay in the desktop
process.

Multica v0.4.32's local `runtime profile set-path` escape hatch is not usable for a normal Windows
`.exe`: its daemon checks Unix executable permission bits (`0o111`), which Windows `os.Stat` does not
set for ordinary executable files. The integration therefore shows a native absolute command for
the custom runtime instead of relying on that local override.

### Development workflow

Run `npm run multica:dev-agent` after changing the bridge client or native launcher, then run
`npm run electron:dev:openclaw` and keep that JustDo process open. The status card shows the native
development Agent executable to enter as Multica's command. The launcher writes redacted lifecycle
diagnostics to `%APPDATA%/<productName>/multica/agent-launcher.log`; it records only command class,
argument count, PID, and exit code. Server-side bridge changes take effect when the Electron
development process restarts. Packaged/unpacked validation remains required before release because
runtime resource paths differ from development.

Multica v0.4.32 may omit `launched_by` from `daemon status --output json`. JustDo still limits
detection to Desktop-owned profiles: it accepts the explicit `launched_by: desktop` signal, or the
Desktop profile naming convention together with Multica Desktop's `.desktop-user-id` sidecar.

## Security and sessions

- The launcher accepts only the compatibility command shapes used by Multica.
- A per-process random token protects the local named pipe/Unix socket. Tokens and profile credentials
  are never sent to the renderer or written to logs.
- Only Multica's temporary config path, include roots, and working directory cross the bridge.
- Multica tasks use local mode, so the task workspace remains the Multica worktree.
- Each external session maps to one local Cowork session. It is visible in JustDo with a Multica badge
  and uses the authoritative Gateway history, but it is always read-only.
