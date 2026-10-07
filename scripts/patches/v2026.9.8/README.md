# OpenClaw v2026.9.8 runtime patches

This is the capability inventory for the pristine `openclaw@2026.9.8` npm
artifact locked in `source-lock.json`. Rebuild from that package; do not migrate
an existing patched runtime. Historical and partial patch markers fail closed.
The sibling source checkout was audited at tag `v2026.9.8` against `v2026.9.6`.

## Disposition

The 22 existing integration seams remain necessary, with two important scope reductions.
032 fixes a Windows session-creation path comparison in 9.8; 033 records loop
exit diagnostics; 034 adds opt-in plugin execution settlement and tool cleanup;
035 populates the existing prompt-hook field with the actual attempt context budget;
036 adds the shared desktop terminal launch and close contract:

- **008:** upstream removed the generic durable task registry. Delete its task
  maintenance patch; retain only the application-process boundary on native
  main-session restart recovery. Gateway restarts within one app epoch retain
  native recovery semantics.
- **021:** upstream removed the OpenAI video-generation provider. Retain isolated
  image-provider configuration only. Video settings accept the native Kie, Z.AI
  or Novita provider; compatibility handling for unreleased custom `/videos`
  settings has been removed.
  no replacement video transport is injected into OpenClaw.

Previously retired 009/024 (native reindex and ACP admission reload) and 017/018
(custom live recovery/order projections) stay retired. Native history owns the
display projection and the ordering of restored messages.

| Patch | Retained capability                   | 9.8 boundary                                                                                                                                                    |
| ----- | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 001   | Managed pip environment provenance    | Host and native-hook environment sanitizers                                                                                                                     |
| 002   | Windows MCP npm runner under Electron | Native stdio spawn options                                                                                                                                      |
| 003   | Windows Chrome MCP launcher           | Preserve the new caller-provided launch environment                                                                                                             |
| 005   | Final system prompt replacements      | Final model-aware prompt before routing observation                                                                                                             |
| 006   | Agent metadata and hidden turns       | Chat admission, queued source-to-execution human initiation transfer, and provider transport; native read worker checks parent identity                         |
| 007   | Request-purpose metadata              | Compaction and reviewer provider payloads; async native reviewer identity reads                                                                                 |
| 008   | App-process recovery boundary         | Native main-session restart recovery only                                                                                                                       |
| 013   | Explicit Goal resume after pause      | Goal resume admission only                                                                                                                                      |
| 014   | Provider-safe replay                  | Native assistant transport projection                                                                                                                           |
| 015   | Trusted local file delivery           | MIME fallback and native media display projection                                                                                                               |
| 016   | Offline official plugin catalog       | Native catalog loader with explicit offline intent                                                                                                              |
| 019   | No automatic plugin repair downloads  | Installed-index lease writer; explicit installs remain native                                                                                                   |
| 020   | Configured realtime ASR URL           | Native OpenAI realtime provider factory                                                                                                                         |
| 021   | Independent image provider            | Native OpenAI image provider; video seam retired                                                                                                                |
| 022   | Planning history after reset          | Native display-history boundary; model reset unchanged                                                                                                          |
| 023   | Managed atomic fork                   | Current fork schema/handler and native atomic transcript fork                                                                                                   |
| 025   | MXC external skill paths              | Canonical host read-only materialization                                                                                                                        |
| 026   | Private untrusted turn context        | Authorized agent-only input, raw transcript unchanged                                                                                                           |
| 027   | Shared session-access providers       | Process-wide registry for bundle and SDK instances                                                                                                              |
| 028   | Managed session cwd                   | Already-authorized operator.admin cwd path; native non-admin containment unchanged                                                                              |
| 030   | Scheduled task permissions            | Cron schema, job persistence and selected workspace after async preparation                                                                                     |
| 031   | Windows credential launcher ACL       | Exact system launcher/provider and verified TrustedInstaller SID                                                                                                |
| 032   | Windows session creation publication  | Canonicalize admitted and SQLite namespaced paths; preserve exact case, database identity and current-owner checks                                              |
| 033   | Content-free loop exit diagnostics    | Record the selected loop exit branch and final response kind; carry through deferred settlement without changing execution or retries                           |
| 034   | Owned plugin execution and cleanup    | General SDK run timeout and managed tool lifetime; exact native registry ownership, whole-run lifecycle, supervisor cleanup and trusted Code Mode wait metadata |
| 035   | Actual prompt-hook context budget     | Expose the resolved native attempt budget through the existing contextTokenBudget hook field; model selection and context guards remain native                  |
| 036   | Shared desktop terminal               | Admin terminal launch accepts project cwd and shell/args; explicit termination retains native viewer ownership checks                                             |

Each module header records its scope, native safety boundary and removal condition.
No upstream issue number is claimed without an actual filed issue.

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
`filesystem.clearPolicyOnExit` configuration still require the product build
patch in `scripts/openclaw/patch-mxc-sandbox-plugin.cjs`. Preserve filesystem
permissions and emit the supported native lifecycle configuration. Binary hashes
are unchanged from 9.6 and are verified against `mxcNativeBinaries.json`.

For feature-level integration and validation results see
[the upgrade audit](../../../docs/openclaw-upgrades/v2026.9.8.md).
