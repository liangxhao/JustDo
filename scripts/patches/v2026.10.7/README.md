# OpenClaw v2026.10.7 runtime patches

This inventory was audited against the unmodified `openclaw@2026.10.7` npm archive locked by [source-lock.json](source-lock.json), and source tag `v2026.10.7` (peeled commit `157d8c2bc3ea2fa183afdc11088e69690bf8e64e`). The annotated tag object is `5c101ce5a0637df375c5f6ae49d44d0d27cc26b1`. Dependency patch targets are the exact published `@openclaw/ai@2026.10.7` and `@openclaw/fs-safe@0.26.0` artifacts admitted by `openclaw-patch-dependencies.cjs`.

## Disposition

All 33 v2026.10.6 capabilities retain their original numbers after an independent target source, published artifact and public API audit. The initial version rebase introduced no additional capability number. The later 034 resolves an independently reproduced cumulative commentary ownership gap. All 34 verifiers reject the pristine target, and all 34 transformations apply and verify on its actual source owners. No historical-shape migration is introduced. [pristine-targets.json](pristine-targets.json) records all 80 exact pristine target hashes and each capability's target file set; 034 reuses the already-audited subscriber owner. The source lock binds these to the npm archive. Matching names or old anchors alone do not establish this disposition.

The latest dev rebase refines existing capability 026 to preserve its live delivery policy through the native subscription parameter clone. The fresh C artifact was rebuilt from the locked pristine package and passed the current strict target matrix below. Earlier B source/import/SQLite records are explicitly historical and do not establish C artifact acceptance.

Pre-build rebase checks passed the 51 hermetic .7 admission cases and eight shared historical-admission controls. The new historical .6 subscription suite skips its six native scenarios when no .6 artifact is available and rejects an explicitly selected .7 package. A separate exact .7 raw-source run passed 56 admission cases, including the actual native publication functions and shared SDK declaration transformation; only the then-unavailable frozen-Gateway case was skipped. These overlapping counts are separate runs. Receipts are under `build/upgrade-audit/v2026.10.7/dev-rebase/026-*`; the actual subscription graph, semantic SDK and frozen C checks subsequently passed as recorded below.

The earlier alias-aware canonical-readiness patch remains retired: the pristine verifier confirms the native physical path key, validation receipt lookup and alias publication. Existing native Stop, thinking, history projection, Tool Search, Goal, subagent queue/wait, approval, compaction-budget and peer-writer scope contracts remain in the 13-contract pristine gate.

## Target changes and cross-review

- **005:** native restart recovery adds `safeToolsRequired` and delegated-sender settlement, but has no host-process epoch. The prior-app boundary remains ahead of native recovery dispatch. A tool timeout's new `interrupted` session projection does not authorize replay or broaden the existing running-session settlement helper.
- **019:** native SQLite worker retirement now distinguishes refusal before opening and loss of a physical file. Those database lease facts are separate from plugin execution settlement and managed-tool cleanup. Native asynchronous current-session proofs, synchronous registry actor callbacks, exact `pluginOwnerId` checks and original admitted-entry return values remain intact. Native cancellation publication still needs the exact, single-use late `executionSettled:true` reservation; ordinary cancellation cannot establish whole-run settlement.
- **022:** compaction adds admitted `requestFromEntryId` and pending-request provenance. The wrapper preserves that native recovery body. These changes do not add public preparation-scoped cancellation, final settlement receipts or complete recovery operation events. The real handler-custody export remains `t`, distinct from the in-process `n` binder.
- **024:** plugin capture now uses `createPluginCaptureResolver` and Windows source aliases are rebased for safe copy. The accepted external absolute directory-junction gap remains; the patch preserves the full native reference, hardlink and containment filter.
- **026/028/029/032:** published SDK and AI production streaming contracts are unchanged; the actual AI transport and partitioner filenames remain identical. Agent core now enables asynchronous tool execution only when the tool surface includes `sessions_yield`; an explicitly empty allowed-tool set now means no allowed tools. Recovery still requires complete producer rejection, zero executed IDs, zero committed asynchronous fragments, zero execution batches and an active native signal. Unknown-tool rejection cannot become malformed-JSON recovery. No patch overrides the new asynchronous gate or tool policy.
- **032 request-activity refinement:** a legacy `function_call` response can report meaningful native transport activity while buffering every assistant/tool event until terminal. The existing subscriber-only counter seam cannot observe that interval. The existing `streamWithIdleTimeout` request callback now emits one separate content-free `run-request-activity` status item per second at most, only for meaningful progress from a live, un-aborted request. Modern `run-stream-progress` counters remain unchanged; native bounded snapshots retain both item IDs independently. Per-request throttling, observer failure isolation and the original observation timestamp are retained. No timeout, signal, iterator, authorization or execution behavior changes. Creation-only local streams install the same activity callback. Public generic hooks expose no request signal; registering a replacement Provider would change its owner, and diagnostic activity timestamps have no equivalent public event. Therefore Runtime Services cannot supply this observation for arbitrary configured Providers. This closes an existing reachable blind spot rather than proving an upgrade introduced it. Historical artifact C acceptance below predates this refinement; its current consumer and validation contract is recorded in [chat rendering](../../../docs/architecture/15-chat-rendering.md).
- **026 subscription refinement:** the .6 and .7 native subscription, stream state, reply delivery and lifecycle sources are unchanged. `subscribeEmbeddedAgentSession` wraps `onAgentEvent` by spreading the input before post-prompt admission locks; the spread evaluates the delivery getter too early. The clone now forwards `deferTerminalDelivery` to the original input on every read, so ordinary excluded runs stream immediately while owned, unknown and unlocked runs remain protected. The native event/transcript wrapper and the post-prompt admission boundary remain intact. Public plugins and host adapters cannot change this internal clone. Strict two-property pristine and three-property current clone shapes reject recursive, constant, duplicated and missing accessors, including an already marked prior revision; rebuild from pristine instead of repairing it in place. The native-subscription fixture executes the actual subscription, message/lifecycle handlers and reply delivery for ordinary and structured output, protected paths, cleanup and an in-memory fault control. Model accounting, unused tool/error collaborators and the synthetic session/event producer are fixture seams; this does not establish real model or Gateway transport behavior.
- **031:** native lifecycle persistence rejects duplicate terminals and creates a safe-tools recovery checkpoint for `timeoutPhase:"tool_execution"`. The duplicate-terminal guard remains ahead of Goal terminal observation; the safe-tools checkpoint remains in the same native atomic write after that observation. They do not replace exact predecessor settlement, native handoff arbitration, atomic acceptance/count persistence or revision fences.
- **033:** fs-safe moves from 0.25.0 to 0.26.0. Both patched files, `dist/move-path.js` and `dist/guarded-mutation.js`, are byte-identical between their pristine published packages. The new Root.copyIn/native platform work does not provide receipt-bound, bounded recovery for this extension installation. Retain the same local-NTFS, exact-stage, same-artifact and current-owner checks; backup/restore publication remains outside the opt-in.

The parent, native-contract and provider/plugin agents independently cross-reviewed retention and implementation. Actual target imports were separately checked for the native session-current proof, source assertion, read-only session metadata, competing-work admission, pending queue, reply registry, event generation and manual compaction custody. Fresh final-bundle verification remains a separate requirement.

## Capability gaps and removal conditions

The old-ID column below refers to the pre-v2026.10.6 lineage. IDs 001–033 are unchanged from v2026.10.6 to v2026.10.7; 034 is a later independently removable fix.

| Patch                                                                                            | Old ID | Retained capability / target gap                                                                                                                                      | Remove when                                                                                                                                    |
| ------------------------------------------------------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [001-managed-pip-config-environment.cjs](001-managed-pip-config-environment.cjs)                 | 001    | pass only the application-proven pip config and Python user-base values to child tools.                                                                               | OpenClaw provides a trusted, value-bound allow-list for managed Python settings.                                                               |
| [002-final-system-prompt-replacements.cjs](002-final-system-prompt-replacements.cjs)             | 002    | apply the application system-prompt replacements to the model-aware final prompt.                                                                                     | upstream offers a supported final system prompt hook with equivalent timing.                                                                   |
| [003-agent-request-metadata.cjs](003-agent-request-metadata.cjs)                                 | 003    | attach stable agent session/parent metadata, one-shot human initiation evidence, and an internal chat.send user-turn visibility control.                              | upstream exposes equivalent request metadata and chat user-turn visibility controls.                                                           |
| [004-request-purpose-metadata.cjs](004-request-purpose-metadata.cjs)                             | 004    | distinguish session compaction and model-backed exec review requests.                                                                                                 | upstream exposes equivalent provider request-purpose metadata.                                                                                 |
| [005-app-startup-task-recovery-boundary.cjs](005-app-startup-task-recovery-boundary.cjs)         | 005    | retire active work accepted before the current application process.                                                                                           | upstream exposes a host-instance recovery epoch in durable session state.                                                                      |
| [006-goal-resume-after-pause.cjs](006-goal-resume-after-pause.cjs)                               | 006    | resume a paused Goal whose preceding run was intentionally aborted.                                                                                                   | upstream Goal resume admits an idle paused session after its run is aborted.                                                                   |
| [007-assistant-display-block-replay.cjs](007-assistant-display-block-replay.cjs)                 | 007    | exclude assistant display-only blocks from provider transcript replay.                                                                                                | upstream provider replay excludes OpenClaw display blocks before AI conversion.                                                                |
| [008-trusted-local-file-media.cjs](008-trusted-local-file-media.cjs)                             | 008    | deliver trusted local MEDIA files whose MIME type cannot be detected and keep the original MEDIA references in the chat display projection.                           | upstream safely downloads generic trusted local files and exposes original MEDIA references to authenticated local chat clients.               |
| [009-offline-official-plugin-catalog.cjs](009-offline-official-plugin-catalog.cjs)               | 009    | keep plugin inventory reads local by disabling hosted official-catalog refreshes.                                                                                     | upstream exposes an offline plugin-management catalog setting.                                                                                 |
| [010-disable-configured-plugin-auto-install.cjs](010-disable-configured-plugin-auto-install.cjs) | 010    | prevent provider/channel configuration from downloading or repairing plugins.                                                                                         | upstream exposes a host policy that disables configured-plugin package repair.                                                                 |
| [011-reset-display-history.cjs](011-reset-display-history.cjs)                                   | 011    | preserve display history across context-clearing resets for the application sessions.                                                                                 | upstream supports a reset boundary that clears model context without hiding display history.                                                   |
| [012-managed-session-fork-target-key.cjs](012-managed-session-fork-target-key.cjs)               | 012    | let the trusted application host choose the managed key and atomically include a selected assistant response in a message fork.                                   | upstream sessions.fork supports a collision-safe, host-selected target key.                                                                    |
| [013-mxc-external-skill-paths.cjs](013-mxc-external-skill-paths.cjs)                             | 013    | let the Windows MXC backend consume the already materialized sandbox skills directory as an external read-only ProcessContainer root.                                 | OpenClaw exposes a backend-owned skill prompt/read path mapping.                                                                               |
| [014-private-untrusted-context.cjs](014-private-untrusted-context.cjs)                           | 014    | carry trusted-local, untrusted external context to an agent turn without storing that context as the visible user message.                                            | upstream exposes a trusted-client per-turn context field with separate transcript and model projections.                                       |
| [015-admin-session-cwd.cjs](015-admin-session-cwd.cjs)                                           | 015    | let an authenticated operator.admin client start a sandboxed agent session in an explicit task directory while the agent keeps its separate bootstrap workspace.      | upstream honors the documented operator.admin cwd contract for sandboxed sessions.                                                             |
| [016-cron-session-permission.cjs](016-cron-session-permission.cjs)                               | 016    | persist per-task native session permission modes and apply them on every run.                                                                                         | upstream cron supports per-run native session permission modes.                                                                                |
| [017-windows-servicing-credential-launcher.cjs](017-windows-servicing-credential-launcher.cjs)   | 017    | accept Windows servicing ownership for the managed credential launcher.                                                                                               | native exec validation recognizes Windows servicing ACLs safely.                                                                               |
| [018-windows-session-creation-path.cjs](018-windows-session-creation-path.cjs)                   | 018    | compare the admitted session database path with node:sqlite's Windows namespaced filename without widening database or creation ownership.                            | upstream canonicalizes both spellings before this exact comparison.                                                                            |
| [019-plugin-owned-execution.cjs](019-plugin-owned-execution.cjs)                                 | 019    | durable exact plugin execution facts and run-owned tool cleanup.                                                                                                      | upstream supplies equivalent settlement and cleanup evidence.                                                                                  |
| [020-shared-terminal-launch.cjs](020-shared-terminal-launch.cjs)                                 | 020    | share the desktop terminal with the chat agent in its project directory.                                                                                              | native terminal.open accepts cwd/shell/args and terminal.close can terminate a shared PTY.                                                     |
| [021-terminal-product-banner.cjs](021-terminal-product-banner.cjs)                               | 021    | display the desktop product name in fresh operator terminals.                                                                                                         | upstream offers a product-owned terminal intro setting.                                                                                        |
| [022-native-compaction-lifecycle.cjs](022-native-compaction-lifecycle.cjs)                       | 022    | observable recovery compaction and authoritative manual cancellation.                                                                                                 | upstream exposes operation-scoped cancellation/settlement covering preparation and emits complete recovery compaction lifecycle events.        |
| [023-computer-overlay-activity.cjs](023-computer-overlay-activity.cjs)                           | 023    | content-free activity for the local Windows desktop overlay.                                                                                                          | native Gateway publishes equivalent local desktop activity events.                                                                             |
| [024-windows-plugin-recovery-junctions.cjs](024-windows-plugin-recovery-junctions.cjs)           | 024    | retain captured Windows host-directory junctions during plugin recovery.                                                                                              | native recovery copies Windows directory junctions without symlink privilege.                                                                  |
| [025-nonblocking-sqlite-retirement.cjs](025-nonblocking-sqlite-retirement.cjs)                   | 025    | retire SQLite handles without blocking foreground session writes.                                                                                                     | native final checkpoints no longer block concurrent foreground writers.                                                                        |
| [026-scoped-finalize-hook-admission.cjs](026-scoped-finalize-hook-admission.cjs)                 | 026    | freeze per-attempt finalization-hook admission after prompt assembly, sharing registrations and preserving the live delivery policy through native subscription copies. | native finalization hooks expose equivalent immutable admission and preserve its delivery policy through subscription before the first model byte.               |
| [027-prepared-history-response-publication.cjs](027-prepared-history-response-publication.cjs)   | 028    | reject history/startup response publication while its synchronous canonical-read frame is still pending.                                                              | native history publication checks the active canonical-read frame before responding.                                                           |
| [028-reasoning-completions-streaming.cjs](028-reasoning-completions-streaming.cjs)               | 029    | stream normalized public text to replaceable Agent previews, keeping private tag recovery separate from terminal/durable reply gates.                                 | native normalized text/thinking streams reach Agent listeners incrementally with strict-mode, unclosed-tag and terminal retraction protection. |
| [029-tool-call-format-recovery.cjs](029-tool-call-format-recovery.cjs)                           | 030    | continue from existing results after a completed, atomic pre-dispatch rejection of malformed tool calls, within the initial native candidate and a two-request limit. | native producers and the same runner provide equivalent rejection evidence, exclusive bounded continuation and native terminal settlement.     |
| [030-mcp-app-session-workspace.cjs](030-mcp-app-session-workspace.cjs)                           | 031    | prepare manual Apps in the same persisted session workspace as model runs, retaining their native runtime and local resources across turns.                           | upstream manual App preparation uses the native session ingress workspace resolver and fences changes during preparation.                      |
| [031-goal-continuation-admission.cjs](031-goal-continuation-admission.cjs)                       | 032    | admit a conditional backend Goal successor after exact settlement and native handoff arbitration, atomically recording acceptance and cumulative automatic count.     | upstream agent ingress supplies equivalent final admission, durable acceptance/count and exact settled predecessor observation.                |
| [032-run-progress-observations.cjs](032-run-progress-observations.cjs)                           | 033    | expose exact tool/model counters and buffered-request activity through separate existing native status items.                                                                         | native Gateway publishes equivalent provider-independent stream progress before tool execution, including bounded replay.                      |
| [033-windows-plugin-directory-publication.cjs](033-windows-plugin-directory-publication.cjs)     | 034    | recover a refused local Windows plugin-directory publication within the same copied artifact, guarded transaction and bounded wait.                                   | native plugin installs provide equivalent receipt-bound, bounded Windows publication recovery.                                                 |
| [034-commentary-block-ownership.cjs](034-commentary-block-ownership.cjs)                       | —      | declare whole-message commentary snapshot ownership for scoped generic delivery, preserving complete native text filtering.                                         | native delivery exposes an equivalent explicit cumulative commentary range across updates, mixed phases and terminal publication.              |

## Locked target source owners

The following paths were returned by a clean application on the pristine target. Shared source owners compose multiple capabilities; they are not independent transcript/state authorities. Copied native support modules are additionally checked byte-for-byte by their owning patch and the final build recipe.

| Patch | Published target owners |
| --- | --- |
| 001 | `dist/host-env-security-DsfhifNr.mjs`<br>`dist/native-hook-relay/host-env-security-B3DKP9_D.mjs` |
| 002 | `dist/attempt-system-prompt-prepare-77TR2SVS.mjs` |
| 003 | `dist/sessions-DD7AJdsX.mjs`<br>`dist/chat-send-handler-DngLINTE.mjs`<br>`dist/builtin-openclaw-Ci5YBsOb.mjs`<br>`dist/agent-runner-run-Dma8wB1D.mjs` |
| 004 | `dist/settings-manager-DipDVfMv.mjs`<br>`dist/simple-completion-execution-DJB-X6CQ.mjs`<br>`dist/exec-auto-reviewer-BZnNdjo5.mjs` |
| 005 | `dist/main-session-restart-recovery-BePtcRv6.mjs` |
| 006 | `dist/chat-send-handler-DngLINTE.mjs` |
| 007 | `dist/ai-transport-runtime-host-BMqXXSo0.mjs` |
| 008 | `dist/managed-image-attachments-CJRLq6Or.mjs`<br>`dist/chat-display-projection.canvas-OCRpCKvQ.mjs` |
| 009 | `dist/management-catalog-DhwpSUFl.mjs` |
| 010 | `dist/missing-configured-plugin-install-DvHA_e--.mjs` |
| 011 | `dist/session-accessor.sqlite-history-query-Dk-To-Gs.mjs`<br>`dist/session-accessor.sqlite-reset-window-1cTNDN6o.mjs` |
| 012 | `dist/sessions-DD7AJdsX.mjs`<br>`dist/sessions-rewind-BzbhdKUD.mjs`<br>`dist/session-accessor.sqlite-message-cut-DJZrvR55.mjs` |
| 013 | `dist/sandbox-skills-Dcyg2gP3.mjs` |
| 014 | `dist/sessions-DD7AJdsX.mjs`<br>`dist/chat-send-handler-DngLINTE.mjs` |
| 015 | `dist/sessions-create-96JImPdd.mjs` |
| 016 | `dist/src-BaGOtYrI.mjs`<br>`dist/jobs-Dy2-Rvck.mjs`<br>`dist/isolated-agent-B8PgrTVO.mjs`<br>`dist/run-executor.runtime-B5UysGXT.mjs`<br>`dist/cron-Ba1zX-fj.mjs` |
| 017 | `dist/native-hook-relay/resolve-CJB_ZyJe.mjs`<br>`dist/provider-integrations-5RARYxQz.mjs` |
| 018 | `dist/session-accessor.sqlite-entry-cache-publication-state-Fxd3P1w_.mjs` |
| 019 | `dist/server-plugins-BN7J9yLN.mjs`<br>`dist/subagent-registry-ClP8932r.mjs`<br>`dist/server-plugin-runtime-client-CvsL0x_P.mjs`<br>`dist/server-plugin-in-process-dispatch-CQ6TnlII.mjs`<br>`dist/agent-turn-service-DTOXX_Sj.mjs`<br>`dist/agent-tools-LS2RUMFH.mjs`<br>`dist/runtime-rseK5Ug0.mjs`<br>`dist/loader-runtime-load-CiKcVwTw.mjs`<br>`dist/registry-BwDJiK-z.mjs`<br>`dist/attempt-execution.runtime-D8n2qkby.mjs`<br>`dist/embedded-agent-DAqZgJpR.mjs`<br>`dist/code-mode-control-tools-FkhKD315.mjs`<br>`dist/session-binding-runtime-EiGMQwyv.mjs`<br>`dist/agent-events-DwWyqfWg.mjs`<br>`dist/config-contracts-Db6WHFol.d.ts` |
| 020 | `dist/src-BaGOtYrI.mjs`<br>`dist/terminal-DsZscJNQ.mjs`<br>`dist/session-manager-Dyr3p0sF.mjs` |
| 021 | `dist/session-manager-Dyr3p0sF.mjs` |
| 022 | `dist/compact-Cn8Yr-Sj.mjs`<br>`dist/core-method-policy-DkntKRY_.mjs`<br>`dist/delegate-Dm6cUDjR.mjs`<br>`dist/embedded-agent-DAqZgJpR.mjs`<br>`dist/native-hook-relay/call-ByceWlwL.mjs`<br>`dist/session-method-policy-B7o-3I76.mjs`<br>`dist/sessions-DD7AJdsX.mjs`<br>`dist/sessions-compact-CvSoNiGn.mjs`<br>`dist/state/openclaw-state-read.worker.js` |
| 023 | `dist/computer-service-C6lOH7z0.mjs`<br>`dist/computer-B6nlongL.mjs`<br>`dist/server-start-CV36mvtI.mjs` |
| 024 | `dist/plugin-generation-source-lookup-NKaFN9QS.mjs` |
| 025 | `dist/infra/sqlite-readonly-location.worker.js`<br>`dist/managed-handoff-runtime.mjs`<br>`dist/native-hook-relay/openclaw-state-db-cache-CByAT_oB.mjs`<br>`dist/package-update-activation-recovery.mjs`<br>`dist/sqlite-wal-CAPx5bGS.mjs`<br>`dist/state/openclaw-state-read.worker.js` |
| 026 | `dist/hooks-DJ64650m.mjs`<br>`dist/builtin-openclaw-Ci5YBsOb.mjs`<br>`dist/registry-BwDJiK-z.mjs`<br>`dist/config-contracts-Db6WHFol.d.ts` |
| 027 | `dist/session-canonical-key-BT9-Ydgk.mjs`<br>`dist/chat-history-handler-DIyNX568.mjs` |
| 028 | `node_modules/@openclaw/ai/dist/openai-completions-transport-BRjxCG1C.mjs`<br>`dist/builtin-openclaw-Ci5YBsOb.mjs`<br>`dist/server-chat-state-go3yND5C.mjs`<br>`node_modules/@openclaw/ai/dist/reasoning-tag-text-partitioner-CpOy9-IQ.mjs` |
| 029 | `node_modules/@openclaw/ai/dist/openai-completions-transport-BRjxCG1C.mjs`<br>`dist/embedded-agent-DAqZgJpR.mjs`<br>`dist/agent-runner-run-Dma8wB1D.mjs`<br>`dist/attempt-system-prompt-prepare-77TR2SVS.mjs`<br>`dist/agent-core-_YGHB2FC.mjs`<br>`dist/agent-turn-service-DTOXX_Sj.mjs`<br>`dist/config-contracts-Db6WHFol.d.ts` |
| 030 | `dist/mcp-app-extensions-abaft4XG.mjs` |
| 031 | `dist/src-BaGOtYrI.mjs`<br>`dist/agent-request-preflight-DayS66Ki.mjs`<br>`dist/agent-turn-service-DTOXX_Sj.mjs`<br>`dist/session-event-payload-Cq41wHZJ.mjs`<br>`dist/session-lifecycle-admission-USS1EGbr.mjs`<br>`dist/subagent-registry-ClP8932r.mjs`<br>`dist/sessions-read-BXwTspcX.mjs`<br>`dist/session-entry-projection-CE63LQBt.mjs` |
| 032 | `dist/builtin-openclaw-Ci5YBsOb.mjs` |
| 033 | `node_modules/@openclaw/fs-safe/dist/move-path.js`<br>`node_modules/@openclaw/fs-safe/dist/guarded-mutation.js`<br>`dist/install-package-dir-D5h3GpAL.mjs`<br>`dist/npm-managed-root-C6KnxuJp.mjs` |
| 034 | `dist/builtin-openclaw-Ci5YBsOb.mjs` |

## Test ownership

Focused target tests live in `tests/openclaw/patches/v2026.10.7/`. Historical patch/test directories remain historical regression evidence; they do not count as target acceptance. Historical native suites admit only their exact package version: an unavailable or different implicit default skips only artifact-dependent scenarios, while an explicitly supplied missing or wrong-version runtime fails. Hermetic historical controls remain active.

| Capability | Tests |
| --- | --- |
| 001 | `compiled-metadata-verification.test.ts` |
| 002 | `compiled-metadata-verification.test.ts` |
| 003 | `compiled-metadata-verification.test.ts`, `credential-compaction-metadata.test.ts`, `request-metadata.test.ts`, `transport-authority-bundle.test.ts` |
| 004 | `compiled-metadata-verification.test.ts`, `credential-compaction-metadata.test.ts`, `request-metadata.test.ts` |
| 005 | `compiled-metadata-verification.test.ts`, `startup-recovery.test.ts` |
| 006 | `compiled-metadata-verification.test.ts`, `goal-resume.test.ts` |
| 007 | `compiled-metadata-verification.test.ts` |
| 008 | `compiled-metadata-verification.test.ts`, `trusted-media.test.ts` |
| 009 | `patch-marker-guards.test.ts` |
| 010 | `patch-marker-guards.test.ts` |
| 011 | `patch-marker-guards.test.ts`, `reset-display-history.test.ts` |
| 012 | `managed-fork.test.ts`, `patch-marker-guards.test.ts` |
| 013 | `mxc-runtime-paths.test.ts`, `patch-marker-guards.test.ts` |
| 014 | `patch-marker-guards.test.ts`, `private-context.test.ts` |
| 015 | `patch-marker-guards.test.ts` |
| 016 | `cron-permission.test.ts`, `cron-runtime.test.ts`, `patch-marker-guards.test.ts` |
| 017 | `credential-launcher.test.ts` |
| 018 | `windows-session-creation-path.test.ts` |
| 019 | `goal-continuation-admission.test.ts`, `plugin-owned-execution.test.ts`, `plugin-session-current.test.ts`, `execution-settled-publication.test.ts` |
| 020 | `shared-terminal.test.ts` |
| 021 | `terminal-product-banner.test.ts` |
| 022 | `native-compaction-lifecycle.test.ts` |
| 023 | `computer-overlay-activity.test.ts` |
| 024 | `windows-plugin-recovery-junctions.test.ts` |
| 025 | `nonblocking-sqlite-retirement.test.ts` |
| 026 | `scoped-finalize-hook-admission.test.ts`, `scoped-finalize-semantic.test.ts`, `scoped-finalize-native-subscription.test.ts` |
| 027 | compiled-metadata-verification.test.ts, patch-marker-guards.test.ts |
| 028 | `reasoning-completions-semantic.test.ts`, `reasoning-completions-streaming.test.ts`, `tool-call-recovery-producer.test.ts`, `structured-reasoning-stream-parser.test.ts` |
| 029 | `tool-call-recovery-core.test.ts`, `tool-call-recovery-dispatch.test.ts`, `tool-call-recovery-producer.test.ts`, `tool-call-recovery-runner.test.ts`, `tool-call-recovery-support.test.ts` |
| 030 | `mcp-app-session-workspace.test.ts` |
| 031 | `goal-continuation-admission.test.ts`, `goal-tool-timeout-native.test.ts` |
| 032 | `run-progress-observations.test.ts`, `buffered-run-progress.test.ts` |
| 033 | `plugin-directory-publication.test.ts` |
| 034 | `commentary-block-ownership.test.ts`, `reasoning-completions-semantic.test.ts`, Renderer `justdo-chat.streaming.test.ts` |

### 034: upstream commentary block ownership defect

The locked `emitAssistantCommentaryStreamData` scopes Responses snapshots to the active block,
but extracts all generic commentary blocks together and keys that cumulative text to the last
block signature. Two source blocks `A` and `B` therefore publish `id0:A` followed by `id1:A+B`;
the source completion correctly retains both native IDs, so both live rows survive. A shared
028 message scope cannot distinguish a cumulative snapshot from a separate paragraph.

034 applies after 028 at the existing `createReplyDelivery` text entrance. Commentary with an
exact native message scope and a non-Responses source is normalized through the original
whole-message commentary extractor, including the direct mixed-phase publication path.
The original native ID is retained. 028 carries only the explicit
`assistantTextScope.commentarySnapshot: 'message'` fact in its existing scope, captured before
callbacks. The Renderer keeps native items and text but displays the snapshot with the latest
accepted text sequence within each explicitly cumulative scope. Terminal retained IDs take
precedence. Ordinary unmarked preambles, different messages and the final answer remain separate.
Responses and sources without an exact message scope retain their native behavior.

Native blocks are not independent Markdown documents. In particular, internal-context markers
and fenced XML examples can cross block boundaries. Splitting extraction per block changes
the final whole-message sanitizer and is unsafe. This patch retains that complete extraction
and one Markdown container; no markup parser, prefix trimming, text deduplication, publication
ledger or transcript cache is added.

The missing native fact is the publication range, rather than permission to split its body.
The public event previously contained only rendered text and the latest ID; a shared message
scope alone cannot distinguish cumulative commentary from independent blocks. Public provider
wrappers do not control the subscriber's final delivery range. The small native normalization
and explicit range fact let the application own presentation without guessing. Remove 034 when
native delivery supplies equivalent cumulative commentary facts across update, mixed-phase
and terminal paths. Source and bundle must have the same exact shape; historical/partial
shapes, including the rejected per-block variant, require a pristine rebuild.

The earlier 2026-10-26 per-block variant passed ordinary text tests and artifact checks but
failed independent review of cross-block context and fenced XML. Those earlier test counts
do not establish acceptance of this corrected shape. Current acceptance must include real
native filtering, mixed phases, Renderer Markdown, source identity, rollback, public history
and reconnect. Offline synthetic/native checks do not replace a live retest of the originally
reported model/session.

The corrected 2026-10-26 shape passed 2,416 chat tests, ten shared-event contract tests,
and 247 native/patch tests against the freshly rebuilt runtime (five existing pristine-only
controls were conditionally skipped). An independent agent also reran the native tests and
the Renderer/DOM/public-history checks. The complete Windows x64 pristine build passed
13 upstream contracts, rejection of all 34 retained gaps, source/final-bundle patching,
resource preparation, extension precompilation and pruning. Final manifest verification
accepted all 34 patches; reapplying 034 to the actual source and Gateway bundle changed
zero bytes. The isolated bundled Node CLI reported `OpenClaw 2026.10.7 (157d8c2)`.
Application lint/build and Electron type checking passed. These checks do not claim a live
reproduction on the originally reported machine/provider.

## Validation boundary

The 2026-10-27 buffered-activity refinement was applied to a fresh locked `2026.10.7` package (tarball SHA-256 `45dc6dadab3ca4e5286262226d6b61554309435a5e83b5d25c803a3a12ef2f81`) and rebuilt on Node 24.22.1. All **33 final patch validators passed**. A second actual 032 application returned no changed files and preserved the owner, support module, complete Gateway bundle and manifest bytes. The final patch set is `2daa89dc9c101b03e2b88da40b69d6d186ec53112cd35604f31e3a41c3635fa0`, recipe `8e7b216a21b5f0b5a223bb57abee8b67af73a024fdd0110f32198497ab775e5c`, and bundle `bea1a68340948e280e48ed4824db7c2aa7d1fff646294d0000bfa235aaaa8778`.

The four focused native/SDK/semantic/manifest files passed **356 tests** against that explicit runtime; five pristine-only semantic negative controls are intentionally excluded for an already patched graph. The new actual-SDK modern/legacy cases both executed. The chat regression run passed **146 files / 2,586 tests**; the final browser stream/activity run passed **23 tests**, including the new generic-activity DOM case. Lint, production build and Electron TypeScript compilation passed without rebuilding shared native dependencies. Independent agents reviewed native and Renderer changes and the transport/SDK/browser test boundaries.

Both `chat-stream-smoke.cjs --run-progress` and `--buffered-run-progress` passed against the final Gateway bundle, the latter using its bundled Node. Before all 65,650 argument characters arrived, each saw multiple actual request-activity events and retained source times in the native in-flight snapshot, without starting the tool early. Modern arguments also retained independent increasing counters; legacy provisional arguments emitted no public tool-input observations at the barrier. Each fixture executed native `read`, retained history, and classified exact whole-run settlement as success. The fixture client uses supported read-only/no-device options so it does not race Gateway startup by creating shared device state. The actual SDK separately parses 70,072-character nested `tool_call → show_widget` arguments; it does not execute that nested tool, and browser DOM tests inject events. This is layered isolated acceptance, not a real internal-model nested-tool or installer/UI acceptance.

The B/C upgrade receipts below predate the buffered request-activity refinement of 032; their test totals and artifact identities do not establish acceptance of that refinement.

The historical B isolated source pass on Node 24.22.1 verified **13 pristine native contracts**, rejection of **33 retained gaps**, first application and source verification of **33 patches**, syntax of **87 changed JavaScript files** including copied support, and **zero byte changes on a second complete transaction**. Its evidence was `build/upgrade-audit/v2026.10.7/source-pass-result.json` in the previous worktree. The 80 published source/dependency owners, including the shared SDK declaration, are independently identified in `pristine-targets.json`.

The historical B independent target import audit resolved all **81 introduced import edges** (80 relative bindings and one Node built-in), with no missing modules or mismatched exported aliases; its evidence was `build/upgrade-audit/v2026.10.7/new-import-edges-result.json` in the previous worktree.

The current C strict target matrix selected the independent raw `dev-rebase/dependency-snapshot` and the frozen `win-x64` graph explicitly, including its bundled Node, AI SDK and complete Gateway bundle. All **43 files passed: 1,073 tests passed, zero failed**, in 158.27 seconds with one worker and 120-second test/hook deadlines. The sole skipped case selects the raw 026 publication pipeline only when the frozen pipeline is absent; a separate raw-only invocation passed that exact case. No target case remains unexecuted because of missing resources. All seven native-subscription cases, the actual semantic SDK program and all five native Goal tool-timeout cases executed against C. Before the full matrix, a separate raw graph run passed those seven subscription cases and the actual SDK program; its 24 other semantic cases were excluded only by the exact test-name filter and subsequently passed in the full matrix. The raw publication supplement likewise excluded the other 56 cases only by its exact test-name filter.

The C 031 composition input was generated from the locked unmodified package by applying and verifying actual 001 through 030 patches in order, then reverifying all 30; 031 verification still failed with the exact missing-capability error. Its receipt records the initial 10,628-file JavaScript/declaration snapshot, 76 changed targets, per-patch source/target hashes and unchanged 80 raw owners. Current commands, forced environment, individual assertions, skip names and before/after hashes are recorded in `build/upgrade-audit/v2026.10.7/dev-rebase/target-validation-result-c.json` and `before-goal-admission-receipt.json`; individual console/JSON reports remain alongside them. Each validation phase preserved all **176 protected files**, including all 80 raw owners, frozen owners/support and immutable identity files. C retained manifest `eda11a20c3c4d43187fbf5e92818367e2de221a39f04e1d9d0b0bf7a9f56900d`, patch set `b39e45d846759b03670f0d699b05f17cf1bbadc1fb620395466315061405defa` and recipe `5ad1d32fc9172872daf88266c2d291891f848635b2439fddbb104e3d0dd1c86a`.

The tool-timeout composition runs the frozen native lifecycle snapshot, complete persistence/derive functions, actual terminal/recovery imports, native lifecycle lock, conditional Goal support and final acceptance seam. A settled `tool_execution` error persists `interrupted` with an active Goal and admits a fresh conditional automatic successor. Missing/false settlement and an old session cannot create predecessor evidence; duplicate terminals and candidate receipts do not count another continuation. The duplicate terminal omits the optional expected-writer condition to reach the native duplicate guard directly; all **five tests** passed in the current C matrix. Session storage, Gateway transport and the clear queue/reply/handoff facts are explicit fixture seams. These checks establish native admission, not database durability, model decisions, real tool execution or a complete Gateway handler run. Ordinary Goal continuation remains automatic; the native safe-tools checkpoint is retained without claiming that it restricts every ordinary successor to read-only tools.

For the historical B artifact, both development Node and the frozen bundled Node ran the two isolated SQLite probes. All **six command groups passed**, yielding **18 top-level scenarios**: two actual pristine writer-blocking negative controls, four nonblocking positive controls across patched pristine and frozen sources, and six lifecycle cases per Node. The lifecycle cases cover current-WAL backup, refused and successful update rollback, deletion exclusion, error-close receipts, exit lease release and fresh-process crash recovery. Incomplete checkpoints remained unconfirmed, old readers retained their snapshots, and the original 2,000 ms busy policy was restored. Each lifecycle run completed within its existing per-child deadlines (334.42 and 336.28 seconds overall); no ABI rebuild or native runtime change was needed. Its commands and results were in `build/upgrade-audit/v2026.10.7/sqlite-validation-result.json` in the previous worktree. The probes use synthetic databases and isolated profiles with actual native storage owners; they do not start a Gateway or establish installer/UI or application shutdown acceptance. B artifact and all 80 raw owner hashes remained unchanged afterward; this historical receipt does not establish the C artifact's probe acceptance.

Target tests retain current-shape idempotency, whole-function semantic verification, historical/mixed/partial no-write rejection, minified/renamed final bundle controls, actual native owners and strict SDK TypeScript programs. A source matrix without a prepared dependency graph is diagnostic only: native stream suites require the explicit target runtime. Source proof is separate from a fresh frozen runtime, isolated Gateway behavior, real services, desktop UI and installer acceptance.

The [upgrade record](../../../docs/openclaw-upgrades/v2026.10.7/README.md) owns final artifact identity, complete automatic/native validation and outstanding product acceptance. No source result authorizes announcing long-task, real-model, MXC device or public-network-blocked installer acceptance.
