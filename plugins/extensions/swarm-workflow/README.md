# Swarm Workflow

Optional OpenClaw durable workflow plugin. Native execution, DAG/batch state,
desktop Main, Browser and history presentation are owned by this package.

Install the declared dependencies and compatible `@app-plugin/sdk`,
`@runtime-services/sdk`, and `@app-plugin/build` artifacts through the workspace
lockfile. Set `OPENCLAW_SDK_ROOT` to matching public declarations if OpenClaw is not
installed, then run from this directory:

```sh
npm run check
npm run build
npm test
```

Complete install packages are emitted under `build/packages/swarm-workflow/<hash>/`.
Builds use installed SDK exports and the public theme preset, without application,
Agent Team, Plan Mode or Required Runtime Services implementation source.

Runtime Services must provide a current generic execution-lane projection and the managed execution
protocol with exact whole-run settlement, run-owned tool cleanup and precise
describe/cancel. Operations retain this plugin's original native executor and
permissions. Unsupported or unverified runtimes reject execution; compilation does
not establish runtime compatibility. Native backend RPC continues to require
OpenClaw's trusted installation admission independently of desktop code approval.

Business tests run independently with public SDK port fixtures. Real host history
boundaries remain in `tests/host/`, require explicit `APP_PLUGIN_HOST_ROOT`, and are
excluded from the default suite. Native persistence uses Node SQLite; product
SQLite is injected by the desktop host rather than shipped as an Electron binary.

Uninstalling withdraws the workflow UI and business entry points while preserving
assistants, sessions, history, flow/batch data and unknown receipts. Compatible
reinstallation reads the same identities without automatically replaying work.
