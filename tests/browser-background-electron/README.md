# Isolated shared-profile background browser verification

Run `node scripts/test/verify-background-browser.cjs` from the repository root.
An explicit `--dependencies-root <checkout>` can reuse another checkout's already
installed Electron (matching `package.json`) and esbuild without installing or
rebuilding it.

The opt-in runner builds the production background host, CDP input transport,
actions, shared session policy, `BrowserAgentBridge` and
`EmbeddedBrowserGatewayBridge`. It launches one hidden Electron process against
a synthetic loopback website. It creates no Gateway, opens no user profile and
reads no transcript. All browser profiles are fresh fixture profiles.
Reports, screenshots and a synthetic workspace containing Chinese and spaces
stay under `.agent-tasks/browser-artifacts/`. Home, app-data, session-data, cache
and temporary files use a fresh short `build/bgp-*` root so Chromium's
service-worker LevelDB paths fit Windows limits. Generated bundles stay under
`build/`. The report lists actual native paths and environment roots.

This fixture is deliberately not named `*.test.*`, so ordinary Vitest/Node test
discovery does not launch Electron. Every browser operation has a bounded wait,
and the child process has a final deadline. A failure writes `report.json` and
exits nonzero; it never replaces a failed operation with a mock or retries input.
Read-only upload diagnostics run only after a failed actual request, retain that
failure, and never retry the upload or substitute a successful response.

The original host/input checks cover actual Chinese/emoji input and submission,
selection and editing keys, coordinate and element clicks, double click, hover,
pointer dragging, cancellation releases, chooser interception with explicit
fixture upload, popup denial and exact page ownership. They use the actual
production offscreen host. CDP viewport, full-page and element-clip screenshots,
and Electron `capturePage` with `stayHidden`/`stayAwake`, must produce real
nonblank images. All native windows must remain hidden and unfocused throughout.
The direct input check installs CDP chooser interception itself; the later Main
path independently exercises the production upload authorization and arming.
The foreground pending-upload fixture also registers a real webview through the
production IPC boundary, clicks a dynamic upload control before providing files,
then reads a snapshot, waits and fills the retained chooser exactly once. It
checks the page's click/change counts, retained interaction lease, batch stop and
source cancellation. This verifies intercepted selection requests; it does not
claim to automate an already-visible Windows system dialog.

The shared-profile checks create a real foreground `<webview>` inside a hidden,
sandboxed carrier. Its isolated `embedded` partition is exactly the partition
used by ordinary and cron headless pages. The synthetic website authenticates
with a server-set HttpOnly cookie plus localStorage and IndexedDB. The fixture
never copies cookies or storage. It verifies that already-open ordinary and cron
pages see foreground login, logout and relogin on their next real Main request,
and that a background authentication update is immediately visible in the
webview. The imported and a synthetic named profile have separate native
Sessions and independent authentication data. Named-profile metadata is written
through the production helper inside the fresh isolated userData; there is no
Chrome import or user-profile discovery.

Sharing a profile has normal new-tab semantics: cookies, localStorage,
IndexedDB, CacheStorage and service workers belong to the profile;
sessionStorage and page memory belong to each page. Closing or cancelling a run
revokes its Main authority and destroys its own page. It does not clear shared
workers, clear storage or close the profile's connections. The fixture confirms
that the foreground worker, cached response and existing EventSource connection
survive releasing one or all background runs, and that a sibling background task
continues. A later cron page uses the same live profile with fresh page state.
The report distinguishes unexpected connection closes during these checks from
the expected close when the fixture finally destroys its foreground carrier.
There is deliberately no assertion of zero profile workers, no cold worker
retirement check and no promise that closing a page cancels site-owned shared
worker effects. Explicit profile-data cleanup remains a separate application
operation.

Shared Session handlers come only from the production
`ensureBrowserSessionPolicy`/`configureBrowserSessionUi` APIs. The fixture
supplies explicit synthetic UI delegates: permission requests are recorded and
denied, and foreground downloads save to fixed fixture paths without dialogs.
Only the exact real webview is admitted by the UI ownership predicate. The
checks require these delegates to remain usable before, during and after
background tasks, while background permission prompts are denied without
reaching UI and an unclaimed background download is cancelled. The fixture never
replaces Electron's Session handlers with its own handlers.

`main-path.cjs` sends explicitly synthetic
`plugin.embedded-browser.requested` events with top-level native-run identity,
`toolCallId` and filesystem policy. The real Main controller prepares the scope
and calls the real browser bridge, host, actions and snapshot/screenshot
implementations. Desktop-session and scheduled-task lookup and outbound resolve
transport are synthetic stubs. This verifies the Main execution path; it does
not claim actual Gateway authentication, model execution, plugin hooks, or a
real scheduled-job launch.

The Main checks also cover ordinary visible defaults and explicit headless mode,
cron omission forcing headless mode, DOM input/snapshots, model-facing viewport,
full-page and element images, workspace-only uploads and external-path denial,
actual PDF and click-triggered download files, exact-call cancellation, no late
resolve, armed upload/dialog cleanup, released-run rejection and older-release
fencing. The local-document negative case seeds a synthetic file page directly
in the test guest before the actual Main request refuses to read it. A delayed
page timer races release, while an observation-only wrapper forwards all native
CDP commands and records any late privileged upload/dialog effects. Renderer
interaction ACK is required and every attempted Renderer send throws. All
headless requests must complete without Renderer participation. Reports retain
observed versions, identities, scopes, image dimensions and artifact paths,
without persisting base64 tool results.

## Real native cron timer probe

This is separate from the 27-check Main fixture above. Run the following with an
explicit prepared runtime and its own bundled Node executable:

```powershell
& '<runtime>/node-runtime/node.exe' scripts/test/verify-browser-cron.cjs --runtime-dir '<runtime>'
```

It validates the frozen runtime's expected version/target, complete prepared
artifact and current patch-set hashes before launching. It records the native
bundle/SDK and freshly compiled Main/plugin hashes. `strictCurrentSourceProof`
remains false: independently compiling current Main/plugin sources with a frozen
native runtime does not validate a fresh complete application/runtime build.
The separate native-source verification outcome and reason are preserved in the
report; an artifact-only pass cannot substitute for that source proof.

The probe gives both the Gateway process and public SDK importer a fresh short
`build/bnc-*` home, state, config, cache and temporary tree. Inherited environment
is restricted to Windows system essentials. Model and website endpoints are
explicitly loopback. This does not claim an OS-level public-network block.
The current embedded-browser plugin is copied and compiled into that isolated
tree. The selected runtime is read-only; no existing user Gateway, credentials,
browser profile or transcript is opened. Native fixture state/logs remain under `build/`; bounded,
redacted summaries and the actual screenshot remain in
`.agent-tasks/browser-artifacts/native-cron-*`.
The disposable fixture disables Node's compile cache through the supported
`NODE_DISABLE_COMPILE_CACHE=1` flag, recorded in its report. Native process
retirement still uses the application's full shutdown allowance and requires a
real successful exit.

A real authenticated `GatewayClient` creates one `cron.add` job with a future
`at` schedule and waits for the native timer. There is no `cron.run` or direct
agent launch. A deterministic local OpenAI-compatible provider receives the real
browser schema and emits `open`, `text` and `screenshot` calls with `headless`
omitted, followed by final text. It requires the actual open result to report
headless mode, the actual page marker to return through the native tool result,
and the actual screenshot image to appear in the next model request.

Authenticated plugin events are forwarded unchanged over process IPC to the
actual Main controller, bridge and Electron host. Main gets the real job through
native `cron.get`, then calls the production `mapGatewayJob`; no job or execution
identity is fabricated. The probe requires exact requested/released/native
whole-run terminal identity, an `end` terminal with `executionSettled:true`,
settled release and owned-page destruction, then the matching persistent
`cron.runs` job/session receipt. Native timer receipts may omit `runId`; the
probe never invents it or derives authority from a session-key suffix. Every
requested command must have been normalized to headless mode, with zero
Renderer calls, native show events or focus events. Both native child processes
must actually exit successfully; a forced kill fails the report.

This exercises a real native timer, Gateway/plugin execution and Main/Electron
browser transport. Its provider is an explicit synthetic protocol fixture, so it
does not validate a company model, SSO, production job persistence or a running
user Gateway. Failures remain failures and are not converted to simulated events
or weaker cleanup assertions.
