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

Multica v0.4.36's local `runtime profile set-path` escape hatch is not usable for a normal Windows
`.exe`: its daemon checks Unix executable permission bits (`0o111`), which Windows `os.Stat` does not
set for ordinary executable files. The integration therefore shows a native absolute command for
the custom runtime instead of relying on that local override.

### Development workflow

Run `npm run multica:dev-agent` after changing the native launcher, then run
`npm run electron:dev:openclaw` to compile the bridge client and keep that JustDo process open. The status card shows the native
development Agent executable to enter as Multica's command. The launcher writes redacted lifecycle
diagnostics to `%APPDATA%/<productName>/multica/agent-launcher.log`; it records only command class,
argument count, PID, and exit code. Server-side bridge changes take effect when the Electron
development process restarts. Packaged/unpacked validation remains required before release because
runtime resource paths differ from development.

Multica v0.4.36 may omit `launched_by` from `daemon status --output json`. JustDo still limits
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

## Direct Skill-Up evaluation

`agent_eval_multca_skillup` imports Multica v0.4.36's open-source Agent backend directly and does
not run Multica Server or a Multica daemon. This mode uses the same launcher and local bridge. Keep
JustDo running or in the tray, enable external connections once, and pass the launcher as the
evaluator's `--agent-executable`.

For Multica's `openclaw` backend, the evaluator's `--model` value is an OpenClaw agent ID rather
than a provider model name. Use `main` to evaluate JustDo's configured main agent. The backend emits
`agent --local --json --session-id ... --timeout ... --agent main --message ...`; the bridge keeps
the Skill-Up workspace as the child process working directory, so a staged `skills/<skill>/SKILL.md`
is discovered by the bundled OpenClaw runtime.

Windows development build:

```powershell
npm run multica:dev-agent
npm run electron:dev:openclaw

Set-Location D:\AI_FOR_WORLD\14_AI_workspace\common_tools\agent_eval_multca_skillup
.\.runtime\windows\python\Scripts\agent-eval.exe run `
  --skill .\skills\example-marker `
  --agent openclaw `
  --model main `
  --agent-executable "$env:APPDATA\JustDo\multica\development\JustDo-agent.exe" `
  --case .\skills\example-marker\evals\cases\marker.yaml `
  --parallelism 1 `
  --iterations 1 `
  --benchmark
```

Linux development build:

```sh
npm run electron:dev:openclaw
# Enable external connections in JustDo once; the UI creates ~/.local/bin/JustDo-agent.

cd /path/to/agent_eval_multca_skillup
./.runtime/linux/python/bin/agent-eval run \
  --skill ./skills/example-marker \
  --agent openclaw \
  --model main \
  --agent-executable "$HOME/.local/bin/JustDo-agent" \
  --case ./skills/example-marker/evals/cases/marker.yaml \
  --parallelism 1 \
  --iterations 1 \
  --benchmark
```

Start cross-platform validation with `--parallelism 1`. Increase it only after verifying that two
simultaneous cases receive distinct external session IDs, Cowork sessions, and working directories.
