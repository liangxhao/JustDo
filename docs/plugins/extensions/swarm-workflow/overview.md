# Swarm Workflow

Optional OpenClaw durable workflow plugin. Native execution, DAG/batch state,
desktop Main, Browser and history presentation are owned by this package.

## Runtime and data ownership

A host integration must supply the public capabilities described here; having the source or compiling it does not grant access to a host's sessions or tools.

Runtime Services must provide a current generic execution-lane projection and the managed execution
protocol with exact whole-run settlement, run-owned tool cleanup and precise
describe/cancel. Operations retain this plugin's original native executor and
permissions. Unsupported or unverified runtimes reject execution; compilation does
not establish runtime compatibility. Native backend RPC continues to require
OpenClaw's trusted installation admission independently of desktop code approval.

Uninstalling withdraws the workflow UI and business entry points while preserving
assistants, sessions, history, flow/batch data and unknown receipts. Compatible
reinstallation reads the same identities without automatically replaying work.

The host prepares the retained SDK-managed `plugin-data/swarm-workflow/`
directory. Native execution and Main's read-only resource checks use the same
`flows.sqlite` database there, including its SQLite WAL/SHM files. Execution
recovery data is excluded from uninstall cleanup. App SDK 1.4 is required for
Main's retained-data cleanup port; business access remains separately guarded.
Former storage paths are not read or migrated. Batch snapshots and item inputs
and outputs remain in their authorized project workspaces.

## Development and validation

Use the Node version and dependencies declared in this package's `package.json`.
Install them from the configured package source, then run from this package root:

```sh
npm run check
npm run build
npm test
```

The build consumes the installed public App SDK and build-tool packages; it does
not start OpenClaw, install the result into a host or approve native execution.
Distribute the complete artifact through the host's supported installation and
code-admission flow. Rebuilding only a host frontend does not update an installed
plugin artifact.

The scripts under `scripts/native/` are opt-in host integration probes, separate
from the package test suite. They require an explicit compatible host environment
through `APP_PLUGIN_HOST_ROOT` and a separately prepared, verified runtime;
runtime arguments and `SWARM_WORKFLOW_TEST_RUNTIME` vary by probe. These probes
use isolated state and synthetic models, never the user's running Gateway or
credentials. Moving the plugin source alone does not provide that integration
environment. Evidence scope and remaining real-model/platform checks are listed
in the [workflow validation section](workflows.md#验证范围).
