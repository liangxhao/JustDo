# Stream progress validation — 2026-10-22

The current contract and public-API/removal audit are in the
[033 capability inventory](../../../scripts/patches/v2026.10.4/README.md#native-bindings-and-ordinary-implementations).
This change retains one observation insertion in the native message-update handler;
stage mapping, retry details, tool progress, rendering and animation remain application code.

The original feature validation below predates the dev merge. The latest integration
evidence is recorded in [Dev integration](#dev-integration--2026-10-22).

## Source and final artifact

- Node 24.21.0; pristine `openclaw@2026.10.4`, with npm integrity and tarball SHA-256
  matching the unchanged source lock (`0a41c2ed708abc812498de58d71d058dde322700488d6e8062c7c070dfdca6dc`).
- Fresh Windows x64 base-runtime installation, current-runtime synchronization and Gateway
  bundling passed, including all 33 source/final-bundle patch checks and manifest generation.
  The first install encountered Windows `EPERM` at the final directory rename; closing the
  isolated preview and retrying the pristine install completed successfully.
- Final Gateway bundle SHA-256:
  `6311846e3b48f52db555d6af67d5df3cf1926147a43eb6d49e5a66fc136c3cca`.
- Native support module SHA-256:
  `762760b92f293735a95f3eb043adad1bf8aaed269299f59310a737ffdbcb1b0d`.
- Direct 033 reapplication to the prepared runtime returned no changed files and preserved
  the exact bytes of its native owner, support module and final bundle.
- After the independent review fixes, another pristine Windows x64 install/sync/bundle passed
  all 33 source/final-bundle checks in 613,736 ms of bundling. The final whitespace-only cleanup
  was followed by another pristine install/sync and a completed 457,437 ms bundle pass. The executable
  bundle hash above remained identical. The final manifest verification and zero-byte-change 033
  reapplication passed against the final helper bytes above.
- An independent compilation of the real pristine subscriber graph passed complete helper
  and call-binding verification. Executing the unmodified native snapshot implementation
  with its real schema accepted and deduplicated 100 progress updates in both `full` and
  `summary` modes, retained the newer actual tool event and cleared progress on retirement.

One post-cleanup validation process exited with Windows `0xC0000005` before writing a manifest.
No verifier exception was reported, and the cause was not established. The supported explicit
rebuild below passed all checks from the already rebuilt, complete current source tree:

```powershell
$env:OPENCLAW_FORCE_INSTALL = '1'
node --max-old-space-size=8192 scripts/openclaw/bundle-openclaw-gateway.cjs
```

`npm run openclaw:patches:verify` and current-shape byte-preserving reapplication passed afterward.

## Application and regression checks

`npm run lint`, `npm run build`, `npm run compile:electron` and the staged `git diff --check`
passed. The final complete `npm test` passed **1,042 test files and 13,183 tests**, with five
conditional file skips and 76 conditional case skips (1,047 files / 13,259 cases discovered).
It completed in 504.92 seconds and restored better-sqlite3 for Electron ABI 146.

Before review, twelve focused test files passed 522 tests, with one conditional skip:
controller/activity, Lit streaming, 033 patch,
pristine contracts, certificate-store setup, ACP plugin setup, native reasoning transport/parser
and runtime manifest coverage. Native text-admission assertions distinguish the content-free
status item from actual assistant/preamble publication, and still reject protected text in
the complete callback payloads.

The initial full suite reported 12,791 passes, six failures and four collection failures.
Those seven affected files were rechecked after native/plugin dependencies and the repository's
HTTP proxy dependency preparation completed, and after reloading the current controller module;
all affected cases passed in the focused runs above and the final complete suite.

The first post-review complete run had one remaining failure: the existing eight-file Goal
patch source/idempotence test took 8.211 seconds and exceeded Vitest's default five-second budget.
The unchanged file passed in isolation (32 cases, nine conditional skips). Only this case received
a local 30-second budget; all four semantic assertions remain. The subsequent complete run passed
as recorded above. No global timeout, retry or skipped assertion was added.

## Independent review follow-up

Three independent agents reviewed native patch boundaries, Renderer behavior and validation.
Five findings were fixed before the final verification:

- Reject a conditionally disabled source observation even when an existing bundle is valid,
  checking AST ownership before any source/support write.
- Ignore content-free metadata for dormant announcements, preserving the existing admission
  of public content and the original buffered lifecycle start.
- Preserve command-output progress while a session is in the background.
- Use the same lifecycle retry/fallback projection in selected and background sessions.
- Keep parallel-tool progress attached to the tool that actually published it.

The focused controller suite passed 19 tests and the native patch suite passed nine tests.
Additional cases cover 150 silent metadata updates before a real announcement, background
silence, exact retained Map values and the 64-call capacity boundary. All semantic assertions
remain; the native observer's executable bytes and its single native insertion are unchanged.

`npm run lint`, `npm run build` and `npm run compile:electron` passed after the fixes.
The final staged-file check found one extra trailing empty line in the new native support module.
Removing it was verified to change trailing whitespace only; its nine patch tests passed again.
No executable code changed after the successful complete suite.

## Real Gateway stream verification

```powershell
node tests/openclaw/runtime/chat-stream-smoke.cjs vendor/openclaw-runtime/current --run-progress
```

The freshly built Gateway and native read tool passed against an isolated loopback model.
The model supplied 65,650 UTF-16 argument characters in slow chunks. The authenticated client
received 21 progress observations, including increasing counts before the remaining arguments
were sent. The native tool did not start early, then returned the expected fixture bytes;
history was read through the public API. Metadata field allowlists and content-exclusion checks
passed. The exact run published `executionSettled:true`; its native lifecycle classifier reported
success. No enterprise model or user Gateway was used.

## Recovery boundary

The native snapshot retains the last available progress item and its original timestamp.
After any item exists, the locked upstream implementation omits later startup statuses; its
public in-flight projection exposes neither these omitted events nor their sequence watermark.
A reconnect during fallback preparation can therefore briefly restore an earlier observed stage
until a new live event arrives. This limitation is documented instead of adding a snapshot patch.

## Browser preview and remaining scope

An isolated browser preview using synthetic events showed increasing long-argument counts,
freshness and retry countdowns. Computed animations remained `working-spark` and
`working-shimmer`; counter updates used `aria-live:off`. Lit tests also verified that updates
retain the same animated DOM elements. This validation does not cover an enterprise model request,
full optional-plugin assembly or installer packaging.

## Dev integration — 2026-10-22

The integration includes dev through `4a649a829`, including resource and source relocation,
model selection, Marketplace feedback, startup/history upgrades and inline-reasoning
source correlation, followed by local speech readiness warnings and native failure receipts.
Three independent reviews found no unresolved product blocker in
the combined Renderer, native patch or startup boundaries. The 033 native seam and its
support module remain unchanged; the updated 029 patch and build recipe require a new
pristine runtime build, so the earlier bundle hash is not proof of this merged tree.

Both browser extension generators were rerun and their committed modules refreshed.
The new sidepanel DOM regression verifies that argument previews and content-free status
items cannot create a running tool card, while native start/result create and complete
the same card. A narrowly scoped Git whitespace attribute preserves meaningful spaces
inside the generated Lit template literals. The native reasoning semantic assertion
now requires an actual preamble, so a progress status cannot satisfy it accidentally.

The merged tree passed `npm run lint`, `npm run build`, `npm run compile:electron`, both
browser extension generators and `browser-extension:prepare`. The offline Chromium
smoke passed authentication rejection, real loopback WebSocket streaming, history,
Thinking, manual collapse, answer and Stop checks with zero page errors. It did not
exercise Native Messaging or a customer history upgrade.

The combined reasoning/progress native suites passed 210 cases with five conditional
skips. The fresh locked Windows x64 installation and current-runtime extraction passed;
the installed build recipe matches the merged source fingerprint
`5d8992be0423251e2ad4f0f26559cab5ad2c920e5be23d3b10e0a932749aac42`.

The new Gateway bundle completed all 33 source/final-bundle patch checks in 578,973 ms.
Its SHA-256 is `b1e0f75a60f75aec3bfd1104406c358ffd72ec2135b830aa21cc720ee7d32620`;
the native progress helper retains the exact `762760b9…cb1b0d` hash recorded above.
`openclaw:patches:verify` passed against the current merged recipe. Reapplying 033
returned no changed files and preserved its owner, helper and final bundle byte for byte.

The later `a6170ea0a` and `4a649a829` commits do not change native sources or the build
recipe; the fingerprint above was checked again after merging them. Their focused
application regressions passed 214 cases across nine files, including 13 new cases for
speech inventory updates, load failures, configuration changes and isolated button actions.
Browser modules were regenerated again after these source changes.

The first dev-integration complete test run, on the `2df4b9f3d` tree, reported 13,373 passes,
80 conditional skips and one failure: the existing session-storage CLI child exceeded its
10-second budget during concurrent native bundle validation. Its unchanged five-case file
passed in isolation in 27.72 seconds. Static inspection found no input-dependent SQL path
or parent/child deadlock, but the precise waiting stage was not established. The original
timeouts and assertions remain unchanged.

The rebuilt real Gateway stream fixture passed: 65,650 argument characters, 22 progress
observations, increasing counts before input completion, no premature tool start, the
expected native read result and public history, followed by the exact settled whole-run
success. This remains an isolated model fixture, not customer migration acceptance.

The final complete `npm test -- --maxWorkers=2` on the `4a649a829` integration tree
passed **1,053 files and 13,404 cases**, with five conditional file skips and 80
conditional case skips (1,058 files / 13,484 cases discovered). It ran alone, completed
in 710.72 seconds and restored and verified Electron ABI 146. The session-storage CLI
file passed with its original budgets and assertions. The final tree also passed lint,
the production build, Electron compilation and the offline Chromium smoke; staged
whitespace/conflict checks passed. Full installer and optional-plugin assembly were
not rerun for this integration.
