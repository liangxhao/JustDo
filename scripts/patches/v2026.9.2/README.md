# OpenClaw v2026.9.2 runtime patches

This directory is the authoritative inventory for the JustDo runtime built from the locked,
pristine `openclaw@2026.9.2` npm artifact. The runtime is never upgraded in place. Historical
or partially applied JustDo markers are rejected; rebuild from `source-lock.json` instead.

The previous 49-patch integration has been reduced to seventeen product-specific gaps. Live Thinking emission,
history projection, native tool search, most Goal behavior, subagent admission/queueing/join,
approvals, compaction/context-budget behavior and task queries are upstream capabilities and must
not be reimplemented here.

The v2026.9.2 audit revalidated the retained gaps against the pristine artifact. Upstream
now starts Chrome MCP stderr capture before connect, so patch 003 no longer owns that behavior and
only supplies the Windows Electron-safe package runner. Patch 007 tracks the prepared
simple-completion transport added upstream, while patch 009 now follows the native forced CLI
reindex intent instead of a JustDo-only environment flag. Patch 010 recognizes the two exact
approval-timeout build shapes emitted by the shared chunk and worker bundle. Patch 013 narrowly
restores native Goal resume after an intentional pause abort without weakening the remaining
restart-safe admission checks. Patch 014 keeps display-only assistant blocks out of the OpenClaw
provider-safe replay context before the generic AI converter sees them. Patch 015 lets trusted
local assistant MEDIA files with unknown MIME use the existing managed document path and keeps the
original `openclawDelivery.mediaUrls` references in the local chat display projection, without
widening attachment admission. Patch 016 keeps routine plugin inventory reads on the bundled
catalog instead of refreshing OpenClaw's hosted ClawHub feed. Patch 017 retains bounded, sequenced
Thinking/Content segments, including native item/preamble commentary, in native in-flight recovery snapshots and shares their stable identity
with live events. It does not reimplement upstream Thinking emission or durable transcripts.
Patch 018 preserves commentary at its original position inside mixed Thinking/Commentary/Tool
assistant messages when native history opts into commentary recovery. It reuses upstream
fallback admission, sanitization and truncation rather than prepending standalone commentary
rows ahead of their preceding Thinking blocks.
Explicitly hidden messages do not emit standalone fallbacks that would lose their display flag.

| Patch                                          | Retained capability                                                                                                          | Remove when upstream provides                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `001-managed-pip-config-environment.cjs`       | Restores only value-bound JustDo managed `PIP_CONFIG_FILE` and `PYTHONUSERBASE` after the host sanitizer.                    | A trusted, provenance-bound managed Python environment API.                         |
| `002-windows-mcp-package-runner.cjs`           | Runs generic npm/npx MCP packages through the bundled Node/npm path on Windows without Electron GUI startup.                 | An Electron-safe Windows package runner with equivalent hidden-window behavior.     |
| `003-windows-chrome-mcp-launch.cjs`            | Runs Chrome MCP packages through the bundled Node/npm path on Windows while preserving upstream early stderr capture.        | An Electron-safe upstream Windows Chrome MCP package runner.                        |
| `005-final-system-prompt-replacements.cjs`     | Applies app-managed replacements after all prompt hooks/model additions and before provider dispatch.                        | A final, cache-safe system-prompt-only hook.                                        |
| `006-agent-request-metadata.cjs`               | Sends authenticated session, parent and user-initiated metadata to the built-in model service only.                          | Equivalent provider request metadata.                                               |
| `007-request-purpose-metadata.cjs`             | Marks compaction/reviewer requests for the built-in service without broadening third-party metadata.                         | Equivalent purpose metadata across native summary paths.                            |
| `008-app-startup-task-recovery-boundary.cjs`   | Recovers tasks across Gateway restarts in one app process but terminates tasks accepted before the current JustDo app start. | A host-instance recovery epoch in upstream durable task state.                      |
| `009-memory-force-reembed-opt-in.cjs`          | Makes a native forced CLI reindex bypass the embedding cache once; automatic fallback keeps cache reuse.                     | Native forced CLI reindex includes cache bypass.                                    |
| `010-configurable-exec-approval-timeout.cjs`   | Applies the host-selected wait time to OpenClaw's native exec approval lifecycle.                                            | A native exec approval timeout setting.                                             |
| `011-plugin-approval-detail-forwarding.cjs`    | Forwards trusted-policy reviewer detail through the native plugin approval request path.                                     | Native `PluginApprovalRequest.detail` forwarding in before-tool approval calls.     |
| `012-configurable-plugin-approval-timeout.cjs` | Applies the host-selected wait time to policy, CLI-native-tool, and native-hook-relay plugin approvals.                      | A native host-level plugin approval timeout setting.                                |
| `013-goal-resume-after-pause.cjs`              | Lets native Goal resume admit an idle paused session whose preceding run was intentionally aborted.                          | Upstream Goal resume accepts this native paused-session state.                      |
| `014-assistant-display-block-replay.cjs`       | Excludes display-only assistant blocks at OpenClaw's provider-safe replay boundary without changing durable history or UI.   | Upstream provider replay filters non-provider assistant content.                    |
| `015-trusted-local-file-media.cjs`             | Delivers trusted generic local MEDIA and retains original MEDIA references in local chat history responses.                  | Upstream supports generic trusted MEDIA and exposes original references.            |
| `016-offline-official-plugin-catalog.cjs`      | Keeps plugin inventory reads on the bundled catalog without contacting the hosted ClawHub feed.                              | Upstream exposes an offline plugin-management catalog setting.                      |
| `017-segmented-live-progress-snapshot.cjs`     | Retains bounded Thinking/Content/preamble recovery segments with the same identity and sequence as live events.              | Upstream in-flight snapshots preserve independently addressable live text segments. |
| `018-mixed-tool-commentary-order.cjs`          | Preserves original Thinking/Commentary/Tool block order in native mixed assistant history with commentary recovery enabled. | Upstream mixed Tool history restores commentary in place with equivalent visibility and sanitization rules. |

Each patch must fail on ambiguous anchors, verify both source and bundled output where relevant,
and be idempotent only for its exact v2026.9.2 marker shape. `verify-openclaw-pristine-contracts`
proves that the deleted patch capabilities are already present upstream and confirms that no
retained patch verifier already passes on the pristine artifact. The functional gap disposition
in this inventory is maintained by source review; verifier failures alone are not treated as proof
of a missing upstream capability.

The installer also applies one audited packaging-only transform from
`scripts/openclaw-facade-runtime-patch.cjs`. It replaces the v2026.9.2 facade activation
source-loader fallback with a static dist import so esbuild includes that runtime in the packaged
Gateway. It has an exact-version marker plus portable and built-runtime shape tests, and is not
counted as a product capability patch because it does not change the OpenClaw API or agent behavior.
