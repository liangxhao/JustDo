# Swarm Workflow

Optional OpenClaw durable workflow plugin. Native execution, DAG/batch state,
desktop Main, Browser and history presentation are owned by this package.

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
