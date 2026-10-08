# Detached workspace implementation plan

Status: implemented; plan and final reviews passed; native feasibility and integration gates passed.
Base: `dev` at `efd2ee3ed`.
Worktree: `E:/workspace/JustDo-detached-workspace`.

## Scope and user behavior

Detach the **entire right workspace**, including every current and future tab,
tab actions, breadcrumbs and workspace file tree. This includes browser, terminal,
file/image previews and editing, review, side chat, plan approval, subagents,
agent-team collaboration, Swarm Workflow and recording review. Do not maintain a
detachable-tab allowlist or create another chat/execution session.

- A workspace-level button detaches to one normal, resizable native window.
- The main chat expands; the detached window follows the active main conversation.
- Opening another tool/result routes into the same workspace instance.
- Dock and native window close return that instance to the main window. They do
  not close tabs, reload pages, terminate PTYs or discard drafts.
- Minimizing the main window does not minimize the detached workspace. Main
  close-to-tray hides both windows without disposing tools; restoring Main
  restores a detached shell that was hidden by that action. Closing the detached
  shell while Main is hidden docks and shows Main. Application quit and main
  renderer destruction clean up the workspace and existing tools.
- Remember detached window bounds, restore within available display work areas,
  and recover when displays are removed or their scale/work area changes.
- Initial scope uses buttons, one detached window and existing session retention
  rules. It does not add per-tab windows, pinned conversations or drag detachment.

## Architecture and mandatory feasibility gate

The existing React tree and Redux/service ownership remain in the main renderer.
Gateway remains the execution/transcript authority. A single same-origin workspace
document hosts a stable React portal for the entire workspace subtree. The document
does not bootstrap a second App/Redux store or privileged API.

Create this document through an **exact URL and frame-name allowlisted**
`window.open`, with Electron `setWindowOpenHandler.createWindow` returning the
`webContents` of a `WebContentsView`. Keep the portal target and its document alive
from the first workspace mount. Move the **same native view** between the main
window's contentView and the detached BrowserWindow; do not move DOM across
documents or recreate React components on detach/dock.

Before production changes, an isolated Electron 42 probe must demonstrate:

1. Parent main-world JavaScript can access the fixed trusted document with
   contextIsolation and sandbox enabled.
2. React events and state work in that document without a second renderer app.
3. A live webview guest retains its native ID, page state and navigation count
   after repeated native view moves in both directions.
4. The workspace document and renderer lifecycle survive detached-shell close
   when the view is first removed and returned to the main host.
5. Both development HTTP and packaged file:// documents support this mechanism,
   and the child does not inherit the privileged main preload.
6. Actual Monaco and xterm widgets work in the portal document: editing/undo,
   focus, context menus, selection, resize, paste and composition-event handling.
   Synthetic composition tests are not physical Chinese-IME validation; retain
   that distinction in the final validation report.

If the gate fails, revise and review the architecture before implementation;
never silently ship reload-on-detach or weaker sandbox/security settings.

## Ownership, policies and cross-document details

- Main owns one workspace host manager per main window: view, detached shell,
  geometry, visibility, lifecycle and closed-value IPC state. No task content,
  transcript, terminal output or file draft caches in Main.
- All tool callbacks, subscriptions and original preload calls remain owned by
  the main renderer. Browser registration may accept a guest hosted by its exact
  registered workspace view, while retaining the main renderer as operator owner.
  Validate the main renderer, main frame, host linkage, native guest and partition;
  never admit arbitrary windows or webContents.
- Reuse the main window's browser guest policy for both allowed hosts, including
  preload replacement, navigation/metadata protection, permissions, HTTP auth,
  proxy, downloads, PDFs, context menus, keyboard shortcuts and recording leases.
  Route native dialogs/menus to the currently owning native window where needed.
- The workspace document has a fixed local page, no application script or
  privileged preload, no external navigation/popups, and safe webPreferences.
  Clear the inherited main preload in window-open override preferences before
  Chromium creates the child, including the adopted options.webContents case.
- Share styles/appearance and language from the source document. Keep the native
  detached window title empty; do not publish conversation titles to its manager.
  Provide explicit owner-document/window context for focus, resizing, menus,
  portals, keyboard shortcuts and editors. Audit realm-sensitive instanceof tests,
  owner navigator.clipboard and devicePixelRatio (annotations and PDF rendering).
  Extend default-session clipboard permission only to the exact registered host;
  preserve main-frame and native guest restrictions.
- Mark shared main-document modal overlays and floating question/plan blockers
  explicitly. The portal coordinator observes these markers and main slot
  visibility: hide the docked native view while an intersecting main overlay is
  present. In detached mode mark the workspace inert and show a translated return
  to Main action while a main blocking approval/interaction is active. Workspace
  local modals stay within their own document and do not suppress their own view.
  Settings/main navigation hide only the docked view. Clear stale occlusion during
  teardown; never rely on a main-document z-index to cover a native view.
- Native view bounds use the measured main placeholder, zoom-aware DIP conversion
  and container clipping. Fullscreen, collapsed sidebar, main navigation, global
  overlays, empty tabs and window resizing must not leave an invisible input trap.
- Detach/dock are serialized, acknowledged transitions. Failure retains the current
  instance and reports an i18n error; repeated clicks/late events are harmless.
- Main-frame reload/navigation/process loss revokes the old document generation,
  closes its native workspace view/shell, and rejects stale geometry, transitions
  and host registrations even though Main's WebContents ID may survive reload.
  All workspace IPC carries a Main-issued generation identity; prepare/open grants
  are exact, single-use, tied to the current Main document.
- Worktree setup may share the existing dependency directory through a junction;
  build output and source edits stay in the new worktree. Do not rebuild a shared
  native dependency concurrently with another checkout.

## Implementation sequence

1. Independent architecture and lifecycle/security reviews of this plan; resolve
   findings and record outcomes here before implementation.
2. Run and retain the isolated Electron feasibility test. Update the reviewed plan
   with actual evidence and any required design corrections.
3. Define the small shared workspace window/geometry IPC contract. Add main host
   management, exact window-open routing, narrow preload methods and renderer
   declarations. Extend existing browser guest policy to the registered host.
4. Add the stable workspace portal/placeholder and presentation mode to the common
   CoworkDisplayPanel, covering both homepage and conversation use. Add detach,
   dock and focus controls; preserve every tab category without special cases.
5. Complete document-aware overlays, focus, shortcuts, sizing, appearance, browser
   registration and terminal/editor integration. Validate agent-team/Swarm actions.
6. Add behavior tests, architecture/feature documentation and bilingual i18n.
7. Review the completed diff with an agent, resolve findings, and run validation.

## Validation and acceptance

- Host tests: exact allowed open request; reject foreign senders/hosts; detach/dock
  preserves view identity; close means dock; double transition/failure/renderer
  destruction and owner reload while detached; stale-generation rejection;
  offscreen bounds and display removal; overlay visibility.
- Renderer tests: the entire content tree stays mounted; generic/future tabs and
  agent-team/Swarm content remain present; active tab and file tree survive;
  existing close-tab behavior and guarded file navigation remain intact; styles,
  keyboard/focus and error recovery work in the target document.
- Real Electron integration: repeated round trips preserve browser guest ID,
  page form/navigation state, React state/draft and event handling. Validate
  terminal backend identity and no close/reopen RPC on presentation moves.
- Run focused Vitest tests, lint, renderer build, main TypeScript compilation,
  and the repository test suite where dependencies permit. Check the full diff.
- Do not claim two-physical-monitor or macOS/Linux interaction testing unless
  performed. Record environment limits and any remaining manual checks honestly.

## Plan review record

- `plan_architecture_review`: approved revised plan for the mandatory feasibility
  gate. Required production file://, preload isolation, actual widgets, native
  overlay visibility, clipboard/DPI and close-to-tray details were incorporated.
- `plan_lifecycle_review`: approved with Main-document reload/generation cleanup
  condition. This condition is now explicit in ownership and acceptance above.
- Both reviews were read-only. No production code was changed before review.

## Feasibility evidence

Executed the isolated probe with installed Electron **42.7.0** on Windows, in both
HTTP and file:// modes. Each mode performed three native-view detach/dock cycles
and destroyed each empty detached shell after returning the view. The workspace
and browser guest IDs were unchanged; guest JavaScript instance and unsaved form
were retained; React click state advanced with one mount and zero unmounts;
actual Monaco content/typing/undo and xterm output/resize/paste remained live.
The child had no inherited preload marker or application API; sandbox and
contextIsolation stayed enabled. Physical IME, physical mixed-DPI dual displays,
and OS clipboard/focus behavior still require manual environment validation.

## Final review and validation record

Both review agents completed read-only final reviews with no remaining blocking
findings. Implementation review corrected tool visibility after collapsing the
docked panel, source-owned resize capture, display selection, current prepare
grant flags, native top-layer approval blocking, notification/pet placement,
overlapping menu visibility, close-to-tray after minimizing Main, and cleanup when
the detached shell closes before Main during quit.

The retained `scripts/test/workspace-window-probe.cjs` passed both HTTP and file
modes using actual CoworkDisplayPanel, React/Lit, Monaco, xterm, TerminalPanel and
a browser guest. Presentation round trips retain one tool mount, one terminal
create and zero terminal close calls. The probe also covers existing-document
reacquisition after React remount, notification routing during menu occlusion,
minimize/close-to-tray/restore, an existing shadow-root modal during Main approval,
old-generation revocation, and shell-first quit cleanup. Backend terminal calls
are a fixture; this does not claim a live Gateway execution test.

Final `npm run lint`, `npm run build`, Main TypeScript compilation, and
`git diff --check` passed. The worktree now has independent dependencies installed
from the existing ignored lockfile; shared dependency installation changes cannot
invalidate its checks. The normal local HTTP proxy installation patch and native
Electron rebuild were applied to these dependencies.

The initial implementation's full Vitest run collected 7,395 tests: 7,291 passed, 94 skipped and 10 failed.
After applying the dependency installation patch and isolating the Windows
cleanup/timeout failures, the targeted rerun passed 84 of 85 tests. The remaining
repeatable failures are in untouched baseline tests:

- `tests/build/package-scripts.test.ts`: CLI bootstrap expectation.
- `tests/openclaw/runtime/pristine-contracts.test.ts`: inventory expects 24
  patches while the base contains 28.
- `tests/openclaw/runtime/runtime-patch-manifest.test.ts`: packaged archive
  fixture reports a missing runtime target.
- `src/renderer/features/plugins/PluginsView.test.tsx`: mocked extension API
  lacks `onChanged`.

New workspace geometry, IPC admission, exact browser-host admission, animation
host cancellation and existing floating-question rendering tests passed. These
baseline packaging/plugin failures are outside this feature's changed code.
Physical dual-display/mixed-DPI movement, OS IME, native clipboard and
microphone/system audio remain manual acceptance checks; macOS/Linux were not run.

## Additional multi-agent review (2026-10-08)

At the user's request, three new agents independently reviewed lifecycle,
authorization, and workspace interactions. Five confirmed findings were repaired:

Reviewers: `review_window_lifecycle`, `review_window_security`, and
`review_workspace_interaction`.

1. Mirror root data attributes so theme selectors apply in the passive document,
   including updates and attribute removal.
2. Reuse the source window's safe external-link handler for workspace `_blank`
   links, while continuing to deny additional native windows.
3. Clamp message selection menus to their own document's viewport. Retain the
   independently reproduced iframe regression as a co-located test.
4. Capture the WebContents reference and share invalidation across `destroyed`
   and `render-process-gone`. Revoke the old generation, notify only a live Main,
   reacquire the portal document, and restore its previous detached presentation.
   Intentional reload/quit cleanup and stale notifications do not reopen it.
5. Wait for the old WebContents to finish destruction before notifying recovery,
   and bind the frame name to its generation. A process-loss probe reproduced
   Chromium reacquiring a dying named WindowProxy; the new generation uses a fresh
   name, while normal presentation moves and React remounts retain their live name.

The side-chat autofocus frame also follows its actual document. The three agents
reviewed the repairs without modifying source or dependencies and reported no
remaining evidence-backed defects. A real same-origin force-crash probe confirmed
that host and Main share a renderer process in Electron 42.7.0; child-document
self-close preserves Main and is covered by actual recovery tests. This exceptional
document loss can discard unsaved page state and reports that limitation to users.

The targeted suite passed 53/53 tests. The expanded HTTP/file integration gate
passed theme changes with production CSS, actual external-link clicks, docked and
detached self-close recovery, old-host revocation, new capture-frame identity, and
stale notification rejection. Process-loss handling is separately exercised by
event injection with a live source. Lint, build and Main compilation passed again.

## Dev rebase and integration validation (2026-10-09)

Rebased the single workspace feature commit onto local `dev` at `1b6385173`.
During validation the upstream authentication commit was amended; replayed only
the workspace commit onto its replacement, preserving one feature commit.

Resolved five conflicting files by retaining the new shell grid/header layout,
source-owned workspace notifications, both architecture sections, and the new
message-link opening preferences. Cross-document anchor detection now uses the
same realm-independent DOM predicate as the existing workspace interactions.
Two iframe regressions cover Embedded/Chrome preferences and the local HTML
working-directory/navigation-suffix context. The retained Electron probe also
clicks actual Lit message links while docked and detached, verifying that they
reach the source renderer's embedded-browser event rather than navigating the
passive document.

The focused suite passed 263/263 tests in 13 files using Vitest's threads pool
with two workers. The default forks pool encountered a worker-start timeout on
this host; no project-wide test configuration was changed. HTTP/file Electron
integration passed. Main type checking, lint and build passed after the rebase.
This run did not repeat the initial full suite or physical device acceptance.

## Dev rebase and integration validation (2026-10-10)

Replayed only the single workspace commit onto local `dev` at `df9357d4d`.
Kept the upstream domain organization: workspace composition and its portal hook
live in `display/`, file rendering in `preview/`, terminals in `terminal/`, and
shared UI primitives in `shared/components/ui/`. Updated the integration fixture
imports and current Swarm Workflow naming with the same ownership boundaries.

Resolved the overlapping composer, modal, shell and browser changes while
retaining the upstream plan-mode composer entry, message-copy request guards,
tab styling and overflow navigation, and favicon loading/persistence. The shared
browser-host setup applies the upstream favicon policy to both presentation
surfaces, delivering updates to the source Renderer.

The new tab layout receives its actual presentation window for resize listeners,
observers and animation frames. The overflow menu uses its own document for placement,
portals and focus, including cross-realm keyboard navigation. A co-located iframe
regression covers the child viewport, selected item, keyboard wrap and resizing.
The Electron fixture generates production Tailwind utilities rather than using
partial layout rules and exercises eight tabs with agent-team, Swarm Workflow
and future plugin entries.

The focused suite passed 510/510 tests in 35 files through `npm test`, using the
threads pool with two workers. This includes the upstream tab layout, composer
plan-mode/draft tests, message-copy race guards, browser favicon/history storage,
workspace admission and existing browser/media permission tests. The repository
test wrapper rebuilt the database binding for Node and restored the verified
Electron ABI afterwards. Lint, production build and Main type checking passed.

The expanded real-window focus gate reproduced a runtime scheduler issue:
the WebContents supplied by `window.open` retained background throttling even
though its constructor preferences requested `false`. Once docked it reported
a hidden page and its animation-frame focus callback stopped. The manager now
sets the live WebContents scheduler flag explicitly at creation. The fixture
checks the actual flag and selected-tab focus after every presentation round trip;
it does not repair the flag from test code or override document visibility.

The HTTP/file Electron gate passed with production layout utilities, resizing an
open tab list and selecting tabs while detached and docked. Existing retention,
approval blocking, tray/minimize/restore, navigation and generation-recovery
checks also passed. The final production build and Main type check passed after
the scheduler repair. This run did not repeat the initial full suite or physical
device acceptance.

## Whole-feature independent review (2026-10-10)

Three new agents independently reviewed the complete feature against `dev` at `df9357d4d`,
covering native lifecycle/geometry, process and browser security, and Renderer
interaction across all workspace tabs. The security review also compared the
shared browser-host policies with the base implementation; no new privilege
or admission defect was found. Each agent reviewed the relevant repairs again.

The review closed these defects:

- Source-realm ResizeObserver delivery stopped while Main was minimized, even
  when both documents reported visible. A real Electron experiment observed
  the same child element with source and child constructors: only the child
  observer delivered the changed width. Workspace terminals, collaboration and
  Swarm graphs, browser annotations/intervention/PDF, breadcrumbs and chat scroll
  now construct observers in the actual presentation window. PDF intersection
  observation follows the same ownership rule.
- Monaco's automatic layout also used a source observer. Application-owned
  layout observation now uses the editor container's window for both observer
  and animation scheduling. Normal editor disposal disconnects it; diff instances
  additionally retain explicit cleanup before editor/model disposal.
- The agent-team member-history subtask details dialog used Main's viewport for
  dragging. Its bounds, resize correction and frames now follow its actual window.
  Closing the subtask list restores focus using that window; audio capture errors
  are recognized using its DOMException constructor.
- A remaining display smaller than 480 by 320 DIP could fit geometrically but
  still be enlarged by fixed native minimum dimensions. Creation and display
  recovery now constrain native minimum sizes to the fitted work area.

The expanded HTTP/file gate passed real child-DOM-only resizing while Main was
minimized: TerminalPanel changed backend columns without reopening its terminal;
normal and diff Monaco layouts followed 260/380px containers; the production
Swarm Workflow graph changed column counts; shadow-content expansion kept chat
following the bottom. The actual draggable-modal hook kept the dialog inside
its child viewport after dragging and native resizing. Simulated small-display
events exercised a real 400 by 240 native shell, restoration to normal minimum
sizes, and recovery back to a small work area. Existing retention, menus,
generation revocation, recovery and tray/quit checks still passed.

The focused suite passed 287 tests in 24 files through the repository's npm test
wrapper, with 35 final follow-up tests passing after the test fixture/type cleanup.
The wrapper restored verified Electron ABI 146. Lint, production build, Main type
checking and diff whitespace checks passed. Three isolated real same-origin
renderer-crash experiments using the production manager and Main's reload policy
recovered the owner first; no reload-throttle defect was reproduced.

All confirmed findings above are repaired and reviewed. This review did not
repeat the original full suite, physical dual-display/mixed-DPI acceptance,
OS IME/clipboard/audio-device checks, or macOS/Linux native-window acceptance.
