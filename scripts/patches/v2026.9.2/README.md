# OpenClaw v2026.9.2 runtime patches

This directory is the authoritative inventory for the JustDo runtime built from the locked,
pristine `openclaw@2026.9.2` npm artifact. The runtime is never upgraded in place. Historical
or partially applied JustDo markers are rejected; rebuild from `source-lock.json` instead.

The previous 49-patch integration has been reduced to twenty-five product-specific gaps. Live Thinking emission,
history projection, native tool search, most Goal behavior, subagent admission/queueing/join,
approvals, compaction/context-budget behavior and task queries are upstream capabilities and must
not be reimplemented here.

Session Stop also relies on native queue clearing, descendant cancellation through completed
ancestors, partial-cascade failure reporting, immediate terminal events, and run-bound approval
revocation. The pristine contract audit checks those implementation seams before patches are
applied, so removing application-side task/approval discovery cannot silently lose native coverage
when the runtime is rebuilt. These artifact shape checks complement cancellation behavior tests.

The v2026.9.2 audit revalidated the retained gaps against the pristine artifact. Upstream
now starts Chrome MCP stderr capture before connect, so patch 003 no longer owns that behavior and
only supplies the Windows Electron-safe package runner. Patch 007 tracks the prepared
simple-completion transport added upstream, while patch 009 now follows the native forced CLI
reindex intent instead of a JustDo-only environment flag. Native exec and plugin approvals use
OpenClaw's own timeout lifecycle; the automation policy selects a native 2/5/10-minute request
timeout and includes a bounded parameter preview in its description instead of patching
reviewer-only detail forwarding. Patch 013 narrowly
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
Patch 019 disables OpenClaw's configuration-driven plugin package repair so custom Provider IDs,
channel configuration and credential environment variables cannot trigger npm downloads. Explicit
plugin installation and update actions remain available.
Patch 020 lets the OpenAI realtime transcription provider use an explicitly configured intranet
base URL, converting HTTP(S) schemes to WS(S) and deriving the realtime transcription endpoint.
Patch 021 keeps the canonical OpenAI image and video provider IDs while giving each native media
runtime a capability-scoped cloned config view. App-owned media config keys therefore remain
independent from each other and from the language provider without changing manifest resolution.
Patch 008 applies the stable host epoch to both main sessions and durable tasks: a full app restart
interrupts old work, while a Gateway-only restart inside the same app process retains OpenClaw's
native recovery behavior.
Patch 022 keeps reset-separated planning history visible for JustDo-owned sessions while OpenClaw's
native reset boundary still clears the model context used by the implementation turn.
Patch 023 lets an authorized JustDo client atomically fork a transcript through a selected complete
assistant entry into an explicit, unused managed session key. The target remains restricted to the
same agent's `agent:<agent>:justdo:*` namespace; callers without `operator.admin` cannot select it,
and assistant-entry inclusion is unavailable for linked upstream sessions.
Patch 024 classifies the ACP agent allowlist as hot-reloadable. OpenClaw already resolves this
prospective admission policy from the newly published configuration snapshot, so changing the
enabled external-agent roster no longer discards the loaded Gateway runtime.
Patch 025 keeps MXC materialized skills on their canonical external read-only host path. This avoids
claiming an unenforceable nested read-only overlay beneath a writable Windows ProcessContainer
workspace while leaving Docker and SSH path projection unchanged.
Patch 026 lets the authenticated local JustDo backend provide bounded untrusted browser state to
the agent-only turn body while OpenClaw persists the original user text unchanged. Other clients
cannot activate this private context channel.
Patch 028 lets the authenticated local admin client prepare an assistant session in the task's
existing project directory while retaining the assistant's independent bootstrap workspace. The
existing non-admin containment check and runtime sandbox policy remain unchanged.

| Patch                                                | Retained capability                                                                                                                                                        | Remove when upstream provides                                                                                                            |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `001-managed-pip-config-environment.cjs`             | Restores only value-bound JustDo managed `PIP_CONFIG_FILE` and `PYTHONUSERBASE` after the host sanitizer.                                                                  | A trusted, provenance-bound managed Python environment API.                                                                              |
| `002-windows-mcp-package-runner.cjs`                 | Runs generic npm/npx MCP packages through the bundled Node/npm path on Windows without Electron GUI startup.                                                               | An Electron-safe Windows package runner with equivalent hidden-window behavior.                                                          |
| `003-windows-chrome-mcp-launch.cjs`                  | Runs Chrome MCP packages through the bundled Node/npm path on Windows while preserving upstream early stderr capture.                                                      | An Electron-safe upstream Windows Chrome MCP package runner.                                                                             |
| `005-final-system-prompt-replacements.cjs`           | Applies app-managed replacements after all prompt hooks/model additions and before provider dispatch.                                                                      | A final, cache-safe system-prompt-only hook.                                                                                             |
| `006-agent-request-metadata.cjs`                     | Sends authenticated request metadata and supports hidden internal `chat.send` user turns.                                                                                  | Equivalent provider metadata and user-turn visibility controls.                                                                          |
| `007-request-purpose-metadata.cjs`                   | Marks compaction/reviewer requests for the built-in service without broadening third-party metadata.                                                                       | Equivalent purpose metadata across native summary paths.                                                                                 |
| `008-app-startup-task-recovery-boundary.cjs`         | Recovers work across Gateway restarts in one app process but terminates sessions/tasks accepted before the current app start.                                              | A host-instance recovery epoch in upstream durable session/task state.                                                                   |
| `009-memory-force-reembed-opt-in.cjs`                | Makes a native forced CLI reindex bypass the embedding cache once; automatic fallback keeps cache reuse.                                                                   | Native forced CLI reindex includes cache bypass.                                                                                         |
| `013-goal-resume-after-pause.cjs`                    | Lets native Goal resume admit an idle paused session whose preceding run was intentionally aborted.                                                                        | Upstream Goal resume accepts this native paused-session state.                                                                           |
| `014-assistant-display-block-replay.cjs`             | Excludes display-only assistant blocks at OpenClaw's provider-safe replay boundary without changing durable history or UI.                                                 | Upstream provider replay filters non-provider assistant content.                                                                         |
| `015-trusted-local-file-media.cjs`                   | Delivers trusted generic local MEDIA and retains original MEDIA references in local chat history responses.                                                                | Upstream supports generic trusted MEDIA and exposes original references.                                                                 |
| `016-offline-official-plugin-catalog.cjs`            | Keeps plugin inventory reads on the bundled catalog without contacting the hosted ClawHub feed.                                                                            | Upstream exposes an offline plugin-management catalog setting.                                                                           |
| `017-segmented-live-progress-snapshot.cjs`           | Retains bounded Thinking/Content/preamble recovery segments with the same identity and sequence as live events.                                                            | Upstream in-flight snapshots preserve independently addressable live text segments.                                                      |
| `018-mixed-tool-commentary-order.cjs`                | Preserves original Thinking/Commentary/Tool block order in native mixed assistant history with commentary recovery enabled.                                                | Upstream mixed Tool history restores commentary in place with equivalent visibility and sanitization rules.                              |
| `019-disable-configured-plugin-auto-install.cjs`     | Prevents Provider/channel configuration from automatically downloading or repairing plugin packages.                                                                       | Upstream exposes a host policy that disables configured-plugin package repair.                                                           |
| `020-openai-realtime-transcription-base-url.cjs`     | Routes OpenAI realtime transcription through an explicitly configured intranet endpoint.                                                                                   | Upstream OpenAI realtime transcription accepts a provider base URL.                                                                      |
| `021-isolated-openai-compatible-media-providers.cjs` | Routes native OpenAI image/video providers through capability-scoped config views without sharing language credentials.                                                    | Upstream supports capability-scoped OpenAI-compatible media provider configuration.                                                      |
| `022-justdo-reset-display-history.cjs`               | Keeps JustDo session display history visible across context-clearing reset boundaries without retaining it in model context.                                               | Upstream supports context-only reset boundaries independently from display-history visibility.                                           |
| `023-managed-session-fork-target-key.cjs`            | Lets authorized JustDo forks atomically include a selected complete assistant entry in an explicit same-agent managed session key without overwriting an existing session. | Upstream `sessions.fork` accepts an authorized caller-supplied target key and assistant cut semantics with equivalent lifecycle fencing. |
| `024-acp-allowed-agents-hot-reload.cjs`              | Applies external-agent allowlist changes through native hot reload instead of restarting the Gateway.                                                                      | Upstream classifies `acp.allowedAgents` as hot-reloadable.                                                                               |
| `025-mxc-external-skill-paths.cjs`                   | Uses MXC's external materialized skills directory as the prompt/tool read path instead of a nested path under the writable workspace.                                      | Upstream exposes backend-owned skill prompt/read path mapping for ProcessContainer backends.                                             |
| `026-private-untrusted-context.cjs`                  | Adds bounded, authenticated local per-turn context to the agent body without storing it as the visible user message.                                                       | Upstream exposes a trusted-client per-turn context field with separate transcript and model projections.                                 |
| `027-shared-session-access-registry.cjs`             | Shares the native scoped-session access registry between the Gateway bundle and dynamically loaded SDK modules; preserves exact grant checks.                              | Upstream packaging gives both module instances the same scoped-access registry.                                                          |
| `028-admin-session-cwd.cjs`                          | Honors the documented `operator.admin` explicit cwd contract for sandboxed sessions while preserving separate agent bootstrap workspaces.                                  | Upstream admits an admin-authorized task directory after global workspace authorization.                                                 |
| `030-cron-session-permission.cjs` | Persists admin-authored per-task session permissions and applies them before isolated run preparation. | Upstream cron carries native session permission modes. |

Each patch must fail on ambiguous anchors, verify both source and bundled output where relevant,
and be idempotent only for its exact v2026.9.2 marker shape. `verify-openclaw-pristine-contracts`
proves the upstream-native capabilities identified in this inventory and confirms that no retained
patch verifier already passes on the pristine artifact. A patch can also be deleted because the
product no longer needs its behavior or replaces it outside the runtime; those decisions are
documented by source review rather than inferred from verifier failures.

The installer also applies one audited packaging-only transform from
`scripts/openclaw/openclaw-facade-runtime-patch.cjs`. It replaces the v2026.9.2 facade activation
source-loader fallback with a static dist import so esbuild includes that runtime in the packaged
Gateway. It has an exact-version marker plus portable and built-runtime shape tests, and is not
counted as a product capability patch because it does not change the OpenClaw API or agent behavior.

Patch 024 recognizes its exact current marker in both source formatting and the newline formatting emitted by a fresh esbuild bundle. This is formatting idempotency, not support for historical or partially applied patch revisions.

Patch 030 persists an explicit `payload.permissionMode` (`read-only` or `full`) for isolated
agent-turn jobs. Only an unscoped operator.admin client may author this mode, modify a Full
job (including declaration-key upserts), or manually run a Full job. Manual-run commit
guards recheck the current job before admission and execution. Native scheduled admission remains unchanged. The runner
sets the session mode before tools are created on every fresh run; native Full policy
therefore disables human approvals without changing any agent or global fallback policy.
Legacy unrestricted tool lists do not implicitly opt into Full. Rebuild from the pristine
locked runtime to deploy this capability; do not modify an already patched runtime in place.
Historical or unknown markers for this capability are rejected even when its code shape matches.
