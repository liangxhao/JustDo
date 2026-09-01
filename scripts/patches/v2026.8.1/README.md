# OpenClaw v2026.8.1 runtime patches

This directory is the authoritative inventory for the JustDo runtime built from the locked,
pristine `openclaw@2026.8.1` npm artifact. The runtime is never upgraded in place. Historical
or partially applied JustDo markers are rejected; rebuild from `source-lock.json` instead.

The previous 49-patch integration has been reduced to nine product-specific gaps. Thinking,
history projection, native tool search, goals, subagent admission/queueing/join, approvals,
compaction/context-budget behavior and task queries are upstream capabilities and must not be
reimplemented here.

| Patch                                        | Retained capability                                                                                                          | Remove when upstream provides                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `001-managed-pip-config-environment.cjs`     | Restores only value-bound JustDo managed `PIP_CONFIG_FILE` and `PYTHONUSERBASE` after the host sanitizer.                    | A trusted, provenance-bound managed Python environment API.                     |
| `002-windows-mcp-package-runner.cjs`         | Runs generic npm/npx MCP packages through the bundled Node/npm path on Windows without Electron GUI startup.                 | An Electron-safe Windows package runner with equivalent hidden-window behavior. |
| `003-chrome-mcp-launch-diagnostics.cjs`      | Uses the Windows-safe Chrome MCP runner and starts stderr capture before connect.                                            | Equivalent upstream Windows launch and early diagnostics.                       |
| `004-chrome-mcp-empty-page-recovery.cjs`     | Creates one `about:blank` page and retries once when Chrome MCP returns no pages.                                            | Native empty-session recovery.                                                  |
| `005-final-system-prompt-replacements.cjs`   | Applies app-managed replacements after all prompt hooks/model additions and before provider dispatch.                        | A final, cache-safe system-prompt-only hook.                                    |
| `006-agent-request-metadata.cjs`             | Sends authenticated session, parent and user-initiated metadata to the built-in model service only.                          | Equivalent provider request metadata.                                           |
| `007-request-purpose-metadata.cjs`           | Marks compaction/reviewer requests for the built-in service without broadening third-party metadata.                         | Equivalent purpose metadata across native summary paths.                        |
| `008-app-startup-task-recovery-boundary.cjs` | Recovers tasks across Gateway restarts in one app process but terminates tasks accepted before the current JustDo app start. | A host-instance recovery epoch in upstream durable task state.                  |
| `009-memory-force-reembed-opt-in.cjs`        | Makes the explicit manual reindex operation bypass the embedding cache once.                                                 | A native one-shot force-reembed option.                                         |

Each patch must fail on ambiguous anchors, verify both source and bundled output where relevant,
and be idempotent only for its exact v2026.8.1 marker shape. `verify-openclaw-pristine-contracts`
proves that the deleted patch capabilities are already present upstream and that each retained
patch still closes a real pristine gap.
