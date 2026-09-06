# OpenClaw v2026.8.2 runtime patches

This directory is the authoritative inventory for the JustDo runtime built from the locked,
pristine `openclaw@2026.8.2` npm artifact. The runtime is never upgraded in place. Historical
or partially applied JustDo markers are rejected; rebuild from `source-lock.json` instead.

The previous 49-patch integration has been reduced to fourteen product-specific gaps. Thinking,
history projection, native tool search, most Goal behavior, subagent admission/queueing/join,
approvals, compaction/context-budget behavior and task queries are upstream capabilities and must
not be reimplemented here.

The v2026.8.2 audit revalidated all fourteen retained gaps against the pristine artifact. Patch 007
now tracks the prepared simple-completion transport added upstream, while patch 010 recognizes
the two exact approval-timeout build shapes emitted by the shared chunk and worker bundle. Patch
013 narrowly restores native Goal resume after an intentional pause abort without weakening the
remaining restart-safe admission checks. Patch 014 keeps display-only assistant blocks out of the
OpenClaw provider-safe replay context before the generic AI converter sees them. Patch 015 lets
trusted local assistant MEDIA files with unknown MIME use the existing managed document path and
keeps the original `openclawDelivery.mediaUrls` references in the local chat display projection,
without widening attachment admission.

| Patch                                          | Retained capability                                                                                                          | Remove when upstream provides                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `001-managed-pip-config-environment.cjs`       | Restores only value-bound JustDo managed `PIP_CONFIG_FILE` and `PYTHONUSERBASE` after the host sanitizer.                    | A trusted, provenance-bound managed Python environment API.                     |
| `002-windows-mcp-package-runner.cjs`           | Runs generic npm/npx MCP packages through the bundled Node/npm path on Windows without Electron GUI startup.                 | An Electron-safe Windows package runner with equivalent hidden-window behavior. |
| `003-chrome-mcp-launch-diagnostics.cjs`        | Uses the Windows-safe Chrome MCP runner and starts stderr capture before connect.                                            | Equivalent upstream Windows launch and early diagnostics.                       |
| `005-final-system-prompt-replacements.cjs`     | Applies app-managed replacements after all prompt hooks/model additions and before provider dispatch.                        | A final, cache-safe system-prompt-only hook.                                    |
| `006-agent-request-metadata.cjs`               | Sends authenticated session, parent and user-initiated metadata to the built-in model service only.                          | Equivalent provider request metadata.                                           |
| `007-request-purpose-metadata.cjs`             | Marks compaction/reviewer requests for the built-in service without broadening third-party metadata.                         | Equivalent purpose metadata across native summary paths.                        |
| `008-app-startup-task-recovery-boundary.cjs`   | Recovers tasks across Gateway restarts in one app process but terminates tasks accepted before the current JustDo app start. | A host-instance recovery epoch in upstream durable task state.                  |
| `009-memory-force-reembed-opt-in.cjs`          | Makes the explicit manual reindex operation bypass the embedding cache once.                                                 | A native one-shot force-reembed option.                                         |
| `010-configurable-exec-approval-timeout.cjs`   | Applies the host-selected wait time to OpenClaw's native exec approval lifecycle.                                            | A native exec approval timeout setting.                                         |
| `011-plugin-approval-detail-forwarding.cjs`    | Forwards trusted-policy reviewer detail through the native plugin approval request path.                                     | Native `PluginApprovalRequest.detail` forwarding in before-tool approval calls. |
| `012-configurable-plugin-approval-timeout.cjs` | Applies the host-selected wait time to policy, CLI-native-tool, and native-hook-relay plugin approvals.                      | A native host-level plugin approval timeout setting.                            |
| `013-goal-resume-after-pause.cjs`              | Lets native Goal resume admit an idle paused session whose preceding run was intentionally aborted.                          | Upstream Goal resume accepts this native paused-session state.                  |
| `014-assistant-display-block-replay.cjs`       | Excludes display-only assistant blocks at OpenClaw's provider-safe replay boundary without changing durable history or UI.   | Upstream provider replay filters non-provider assistant content.                |
| `015-trusted-local-file-media.cjs`             | Delivers trusted generic local MEDIA and retains original MEDIA references in local chat history responses.                  | Upstream supports generic trusted MEDIA and exposes original references.        |

Each patch must fail on ambiguous anchors, verify both source and bundled output where relevant,
and be idempotent only for its exact v2026.8.2 marker shape. `verify-openclaw-pristine-contracts`
proves that the deleted patch capabilities are already present upstream and that each retained
patch still closes a real pristine gap.
