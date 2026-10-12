# OpenClaw v2026.9.8 runtime patches

This is the capability inventory for the pristine `openclaw@2026.9.8` npm
artifact locked in `source-lock.json`. Rebuild from that package; do not migrate
an existing patched runtime. Historical and partial patch markers fail closed.
The sibling source checkout was audited at tag `v2026.9.8` against `v2026.9.6`.

## Disposition

041 (explicit skill discovery refresh) is retired. Use ordinary skills.status
reads with native file watching. The proposed 043 preventive package-copy patch is withdrawn; no alternate
native install protocol is introduced.

Prefer existing native APIs and application-layer fixes. Retain a runtime patch only
for a demonstrated core-function blocker with no reasonable native alternative.
Bounded discovery delays do not justify a patch. This review covers 041–043;
existing product integration patches, including terminal branding 037, are retained.

The retained integration seams include these scope reductions.
032 fixes a Windows session-creation path comparison in 9.8; 033 records loop
exit diagnostics; 034 adds opt-in plugin execution settlement and tool cleanup;
035 populates the existing prompt-hook field with the actual attempt context budget;
036 adds the shared desktop terminal launch and close contract;
037 replaces the operator terminal welcome art with the desktop product name;
038 supplies native compaction lifecycle and operation-scoped cancellation;
039 separates source and peer transcript writer scopes at native turn dispatch;
040 publishes content-free local Windows computer activity for desktop presentation;
042 preserves Windows directory junctions when copying native plugin recovery captures;

- **008:** upstream removed the generic durable task registry. Delete its task
  maintenance patch; retain only the application-process boundary on native
  main-session restart recovery. Gateway restarts within one app epoch retain
  native recovery semantics.
- **021:** upstream removed the OpenAI video-generation provider. Retain isolated
  image-provider configuration only. Video providers register outside this patch:
  the application bundles `video-openai`; Kie, Z.AI and Novita are available only
  when installed separately. Compatibility handling for unreleased custom `/videos`
  settings has been removed.
  no replacement video transport is injected into OpenClaw.

Previously retired 009/024 (native reindex and ACP admission reload) and 017/018
(custom live recovery/order projections) stay retired. Native history owns the
display projection and the ordering of restored messages.

| Patch | Retained capability                   | 9.8 boundary                                                                                                                                                       |
| ----- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 001   | Managed pip environment provenance    | Host and native-hook environment sanitizers                                                                                                                        |
| 002   | Windows MCP npm runner under Electron | Native stdio spawn options                                                                                                                                         |
| 003   | Windows Chrome MCP launcher           | Preserve the new caller-provided launch environment                                                                                                                |
| 005   | Final system prompt replacements      | Final model-aware prompt before routing observation                                                                                                                |
| 006   | Agent metadata and hidden turns       | Chat admission, queued source-to-execution human initiation transfer, and provider transport; native read worker checks parent identity                            |
| 007   | Request-purpose metadata              | Compaction and reviewer provider payloads; async native reviewer identity reads                                                                                    |
| 008   | App-process recovery boundary         | Native main-session restart recovery only                                                                                                                          |
| 013   | Explicit Goal resume after pause      | Goal resume admission only                                                                                                                                         |
| 014   | Provider-safe replay                  | Native assistant transport projection                                                                                                                              |
| 015   | Trusted local file delivery           | MIME fallback and native media display projection                                                                                                                  |
| 016   | Offline official plugin catalog       | Native catalog loader with explicit offline intent                                                                                                                 |
| 019   | No automatic plugin repair downloads  | Installed-index lease writer; explicit installs remain native                                                                                                      |
| 020   | Configured realtime ASR URL           | Native OpenAI realtime provider factory                                                                                                                            |
| 021   | Independent image provider            | Native OpenAI image provider; video seam retired                                                                                                                   |
| 022   | Planning history after reset          | Native display-history boundary; model reset unchanged                                                                                                             |
| 023   | Managed atomic fork                   | Current fork schema/handler and native atomic transcript fork                                                                                                      |
| 025   | MXC external skill paths              | Canonical host read-only materialization                                                                                                                           |
| 026   | Private untrusted turn context        | Authorized agent-only input, raw transcript unchanged                                                                                                              |
| 027   | Shared session-access providers       | Process-wide registry for bundle and SDK instances                                                                                                                 |
| 028   | Managed session cwd                   | Already-authorized operator.admin cwd path; native non-admin containment unchanged                                                                                 |
| 030   | Scheduled task permissions            | Cron schema, job persistence and selected workspace after async preparation                                                                                        |
| 031   | Windows credential launcher ACL       | Exact system launcher/provider and verified TrustedInstaller SID                                                                                                   |
| 032   | Windows session creation publication  | Canonicalize admitted and SQLite namespaced paths; preserve exact case, database identity and current-owner checks                                                 |
| 033   | Content-free loop exit diagnostics    | Record the selected loop exit branch and final response kind; carry through deferred settlement without changing execution or retries                              |
| 034   | Owned plugin execution and cleanup    | General SDK run timeout and managed tool lifetime; exact native registry ownership, whole-run lifecycle, supervisor cleanup and trusted Code Mode wait metadata    |
| 035   | Actual prompt-hook context budget     | Expose the resolved native attempt budget through the existing contextTokenBudget hook field; model selection and context guards remain native                     |
| 036   | Shared desktop terminal               | Admin terminal launch accepts project cwd and shell/args; explicit termination retains native viewer ownership checks                                              |
| 037   | Product terminal welcome              | Welcome text reads validated build-time productName; no lobster art; native buffer seeding and output offsets remain unchanged                                     |
| 038   | Native compaction lifecycle           | Recovery start/update/end events; admin operation status/cancellation covers preparation and cleanup; bounded native receipts retain no transcript or summary      |
| 039   | Peer transcript writer scope          | Detach only source transcript/CLI-history ownership after caller snapshot restoration; preserve native authority, target writer admission, guards and cancellation |
| 040   | Local computer activity presentation  | Admin-only transient start/end heartbeats after native admission and idempotency; no input or image payload, no changes to execution, cancellation or results      |
| 042   | Windows plugin recovery junctions     | Preserve accepted absolute directory links as junctions in recovery copies; keep native file references, hardlink checks, admission and lifecycle unchanged        |

Each module header records its scope, native safety boundary and removal condition.
No upstream issue number is claimed without an actual filed issue.

Patch 042 fixes Windows plugin replacement preparation during uninstall, toggles,
reloads and other native lifecycle operations. `captureRecoverySource` uses
`fs.cpSync` with `verbatimSymlinks`, but Node recreates directory junctions as
ordinary directory symlinks. Copying the native `node_modules/openclaw` host
junction can consequently fail with EPERM even when the installed plugin
directory is writable and unlocked.

The native uninstall RPC exposes only pluginId/keepFiles. keepFiles still prepares
runtime replacement; CLI --force only skips confirmation, and a CLI connected to
a running Gateway forwards to the same RPC. None skips this native-owned capture.
Offline CLI removal would require stopping the Gateway and interrupting tasks.
Application-owned source preparation cannot repair the already captured boundary;
042 is retained for the reproduced normal-uninstall blocker.

The seam runs the original recovery filter first. Only on Windows, an accepted
existing directory link with an absolute target is recreated as a junction and
excluded from the default copy. It preserves the target without traversing it;
relative, file and dangling links retain native behavior, as do non-Windows
copies. Native file-reference/hardlink handling, ownership checks, recovery
disposal and plugin lifecycle are unchanged. It does not bypass failed runtime
drain or introduce a Gateway restart. Four native source copies and the final
Gateway bundle require exact verification; historical or partial shapes require
a pristine rebuild. Remove when upstream recovery preserves Windows junctions.
Tests: `tests/openclaw/patches/v2026.9.8/windows-plugin-recovery-junctions.test.ts`.

Patch 040 covers the native service/handler/scope-guard chunks, the recovery
monolith, and both minified `dist/worker/worker.mjs` and
`dist/worker/sqlite-store.worker.mjs` copies (four targets per seam before bundling,
five with `gateway-bundle.mjs`). Minified local names are derived from the native
AST; the activity callback captures handler options to avoid a shadowed context
alias. Verify against the complete locked pristine archive, not a subset of dist.

Patch 039 addresses `SessionTranscriptWriterClaimReboundError` during a peer
turn's automatic context recovery. Native `bindAgentToolGatewayRequest` captures
all async-local scopes with `AsyncLocalStorage.snapshot()`. Its subsequent
`agent` dispatch restores the sender's transcript writer along with the caller's
authorization. A target attempt temporarily binds its own writer, but recovery
and terminal persistence outside that attempt can again inherit the sender's
writer and reject the different target. Successful compaction does not rule out
this subsequent persistence failure. Detaching outside the captured caller is
too early: snapshot restoration reinstates the source scope.

The bound dispatcher exits only native transcript and CLI-history writer scopes
for `agent` RPCs, after snapshot restoration. The original dispatcher receives
the same request, arguments, caller checks, opaque operator authority, target
commit guard and abort signal. Other RPCs retain their original writer scope.
The target still acquires and validates its own native writer fence; no guard is
removed, no session claim is overwritten, and no uncertain launch is retried.
The Gateway bundle and dynamically imported SDK must also share the native
`transcript-write-context` and `cli-history-boundary` state owners, as enforced
by the shared SDK build contract. The detach helper's CLI dependency must use
the same carrier as CLI execution and transcript boundary reads. Upstream
async-work carriers already use global singletons and need no new seam.
All four native dispatcher copies and the final bundle are verified.
Rebuild from the locked pristine package. Remove this seam when upstream
separates these writer scopes after restoring caller authorization. Tests:
`tests/openclaw/patches/v2026.9.8/peer-transcript-write-scope.test.ts` and
`tests/openclaw/runtime/shared-sdk-modules.test.ts`.

Patch 006's bundle pass recognizes numeric local aliases generated by esbuild
for the shared native authority resolver. Pinned native files still require the
exact resolver name; missing or ambiguous assertions fail closed. This is a
fresh-build recognition rule, not repair logic for an older patched runtime.

Patch 038 closes two native 9.8 gaps. Timeout/overflow/budget recovery calls the
context engine directly, bypassing ordinary AgentSession compaction events; its
only existing progress callback requires configured notifier hook messages.
Recovery now emits one unique item/operation identity with start, periodic update
and end, including completed/skipped/failed/aborted outcome and available token
accounting. Hook notifications become updates within that operation. Observation
never waits for remote notification delivery, and pending callbacks suppress
heartbeat updates; terminal delivery and timer cleanup do not block execution.
This seam adds lifecycle and heartbeat observations, not summary streaming.

Manual `sessions.compact` accepts an optional UUID `operationId`. Native admin
methods `sessions.compaction.status` and `sessions.compaction.abort` accept exactly
`{key, operationId}` and return a direct snapshot with `phase` equal to
`in-progress`, `settled` or `unknown`; settled snapshots include `outcome`, `ok`,
`compacted`, `markerExpected` and available token counts. `admitted` distinguishes
an accepted operation from a cancellation fence created before its dispatch.
Abort does not clear the follow-up queue; native `sessions.abort` still owns that
separate capability. Absence of an active embedded run never proves preparation
has settled. Unknown abort IDs are reserved before confirming cancellation,
preventing a delayed original submission from starting. Repeated IDs never run
again. In-progress aborts settle only after the native handler's cleanup releases
its operator/lifecycle custody; RPC responses and `session.operation` terminals
are delivered after that cleanup. The wrapper transfers the native opaque
mutation-authority binding rather than relying on copied request properties.

The Gateway keeps at most 4096 content-free receipts/fences per native runtime
identity for its process lifetime. It never evicts them or expires cancellation
fences, and rejects new admission at capacity. A restart returns unknown; clients
must fence uncertain old IDs before allowing later work and must not reconstruct
their earlier outcome. Receipts contain fixed reason codes, never summaries,
provider error text or transcripts; immediate RPC and live terminal attribution
retain the native reason or error message. Exact native no-op and cancellation
reasons retain their semantics.
Only stock client compaction of a durable transcript advertises an expected
history marker. Server-endpoint, CLI, detached-memory and opaque custom-engine
successes can finish without one.

The new methods retain native operator.admin and session/profile target policy.
Compact parameter and operation-event schema changes are verified with the
handler, native method descriptors, relay descriptors, context-engine delegate,
producer, recovery module and both native workers before writing any target.
Public plugin hooks cannot establish preparation/cleanup settlement or observe
the missing recovery lifecycle, so this capability belongs at the native seam.
Rebuild from the locked pristine package; partial and historical shapes fail
closed. Remove 038 when upstream exposes equivalent operation-scoped settlement
and cancellation covering preparation, plus complete recovery events and marker
provenance. The adjacent `native-compaction-lifecycle.js` contains the serialized
native helpers and is included in the patch input/build-recipe fingerprints;
038 owns all transformations and exact verification. Tests:
`tests/openclaw/patches/v2026.9.8/native-compaction-lifecycle.test.ts`.

Patch 037 renders `Welcome to the <productName>.` using validated `package.json`
metadata, preserving ANSI theme colors and CRLF spacing. The monochrome app icon
loses its cat details at compact terminal sizes, so no replacement ASCII art is
shown. This changes only the native intro composer in the session manager,
recovery module and both native workers, verified again in the Gateway bundle. It preserves native
operator/viewer intro seeding, PTY output, buffers and offsets; no Renderer filtering or
Main output rewriting is added. The product metadata validator is part of the
build recipe proof. Remove when upstream supports product-owned terminal intros.
Tests: `tests/openclaw/patches/v2026.9.8/terminal-product-banner.test.ts`.

Patch 036 addresses the native terminal integration gap: `terminal.open` starts in
the role home and does not accept the desktop's selected project or PowerShell
launch arguments; `terminal.close` normally detaches from an adopted shared PTY.
The existing operator.admin RPC accepts optional cwd/shell/args and an explicit
terminate flag. Catalog launches retain their native plan. Sandbox admission,
exact chat incarnation and attached-viewer checks stay native; agent input still
uses native one-time approval unless full execution access applies. Rebuild from
the locked pristine package. Remove this seam when those native launch and close
contracts are available upstream. Source targets are the protocol, terminal RPC,
session manager and the native recovery bundle; final Gateway bundle verification
checks the same behavior. Tests: `tests/openclaw/patches/v2026.9.8/shared-terminal.test.ts`
and `src/main/ipc/app/terminal.test.ts`.

Patch 006 transfers the one-shot human initiation marker from the native queued
source turn to its separately allocated execution ID immediately before execution.
It leaves native run identities and queue behavior unchanged. The current marker
revision rejects older patched inputs; rebuild from the locked pristine package.
The bundle verifier accepts the exact current transfer after esbuild removes its
comment and renames local bindings, checking the adjacent native source and
execution identities. Markerless source files and incomplete transfers still fail.

## Packaging and native evidence

9.8 adds `dist/package-update-activation-recovery.mjs` alongside the two embedded
worker bundles. Audit all copies rather than assuming the former three source
targets. Gateway-only handlers remain in the Gateway ownership boundary; each
transform checks the exact current module topology. Payload helper export aliases
are resolved from the locked artifact, never carried over from the previous hash.

The packaging companion registry covers all 54 native process entrypoints (13
added since 9.6), including the SDK Job launcher reached by file-access runtime. Preserve the original module URL through the new shared process
factory, self-starting workers and runtime-module imports so bundled execution
resolves the shipped worker files rather than the Gateway bundle directory.

`verify-openclaw-pristine-contracts.cjs` checks native thinking/history, tool
discovery, Goals, decision evaluation, subagent queue/wait/delivery, Stop,
approval expiry and compaction before writes. `tasks.list/get` and generic task
events were removed upstream and are no longer claimed as native contracts.

The facade static-import transform remains packaging-only. Final artifact proof
binds the source lock, patch inputs, build recipe, native modules and bundle;
failed proofs must never be repaired by rewriting their manifest.

034 is opt-in for trusted plugin owners. It does not change ordinary plugin
tool lifetime, grant filesystem access, or introduce a Swarm-specific executor.
Managed runs require local native execution; unverified remote, ACP, alternate
harness and sandbox tool backends fail closed. SDK declarations and all four
native code copies are checked, then the production bundle is verified after
esbuild normalization. Historical or partial versions require a pristine rebuild.
The current set passed a full isolated production build (real dependency lock,
asar and artifact metadata), native Code Mode async wait and cleanup probes, and
a real execution lasting over one hour. See the Swarm batch feature plan for
the exact test scope and remaining recovery limits.

035 repairs a missing value, not a new budget policy. The 9.8 public hook type
declares `contextTokenBudget`, but the native prompt assembly did not populate
it. Plugins receive `attempt.contextTokenBudget`, which the native result guards
also consume; they must retain a conservative fallback when it is unavailable.
All four native copies and the production bundle are verified against the
current exact field expression. No model window is guessed from its name.

## MXC

The separately locked `@openclaw/mxc-sandbox@2026.9.8` still uses MXC SDK 0.8.0.
Its external skill paths, host-preparation capability SID and invalid
`filesystem.clearPolicyOnExit` configuration, plus its unrelated IsoEnvBroker
readiness gate, still require the product build
patch in `scripts/openclaw/patch-mxc-sandbox-plugin.cjs`. Preserve filesystem
permissions and emit the supported native lifecycle configuration. Binary hashes
are unchanged from 9.6 and are verified against `mxcNativeBinaries.json`.

Readiness now probes the exact selected executor with `--probe`, including an
explicit `mxcBinaryPath`, and requires a native ProcessContainer isolation tier.
Native tier warnings remain advisory; failed, malformed or unrecognized probes
block backend registration. Main also checks a real isolated process before
admission. Remove this readiness patch when the locked plugin includes the
[upstream executor-based readiness](https://github.com/openclaw/openclaw/blob/main/extensions/mxc/README.md#host-readiness).
Prior product patch revisions are rejected; rebuild the plugin from its locked
pristine package instead of updating a previously patched cache in place.
Tests: `tests/scripts/mxc-sandbox-patches.test.ts` and
`src/main/security/windowsSandboxService.test.ts`.

For feature-level integration and validation results see
[the upgrade audit](../../../docs/openclaw-upgrades/v2026.9.8/v2026.9.8.md).
