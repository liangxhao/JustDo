# Agent Team

Optional OpenClaw collaboration and group discussion plugin, with independent
Native, desktop Main, Browser and history presentation entries.

Install the declared dependencies and compatible `@app-plugin/sdk`,
`@runtime-services/sdk`, and `@app-plugin/build` packages through the owning
workspace's lockfile. Supply matching public OpenClaw declarations with
`OPENCLAW_SDK_ROOT` when OpenClaw is not installed. From this directory:

```sh
npm run check
npm run build
npm test
```

The build output includes complete install packages under
`build/packages/agent-team/<hash>/`. It does not require sibling plugin source,
application source, host theme files or a host dependency-directory link.
This package owns launch policy, discussion input protocols and business ledgers.
Runtime Services provides generic execution admission, inert storage and exact
receipt reconciliation without understanding this plugin's modes or rooms. Plan
restrictions use the pure App SDK policy contract, with no source or enablement
dependency on Plan Mode.
Native backend RPC still requires OpenClaw's trusted installation admission;
desktop companion code approval does not confer that trust.

Business tests use local fixtures of the public SDK ports. Explicit host boundary
tests live in `tests/host/` and require `APP_PLUGIN_HOST_ROOT`; they are excluded
from the independent default suite. `APP_PLUGIN_TEST_SQLITE_MODULE` can explicitly
select a Node-compatible test driver without changing the host's Electron driver.

Uninstalling withdraws business and UI contributions. Existing assistants,
sessions, native history, team metadata and unresolved safety receipts remain for
reinstallation. Unknown sends and launches are never replayed automatically.
