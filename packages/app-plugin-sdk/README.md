# App Plugin SDK v1

This package defines the public contract between a trusted app companion and its application host. Agent Team and Swarm Workflow are complete examples under `plugins/extensions/`. Their native, Electron Main, and React code are built as independent artifacts; none imports application `src`.

## Build and package

Use Node 24.21 and the repository's locked dependencies. Run `npm run plugins:app:sdk` to emit portable JavaScript, declarations, and npm exports into `build/app-plugin-sdk`. `npm pack ./build/app-plugin-sdk` produces a package for an unrelated plugin project. React and ReactDOM are peer dependencies; a browser artifact uses the host's actual React instance.

For a single plugin, run:

```powershell
node scripts/plugins/build-app-plugins.mjs C:\my-plugins\agent-team C:\my-plugins\output
```

The shipped examples also import sibling Runtime Services contracts/general implementations and the pure Plan Mode state contract. When copying an example into another source root, carry those actual source dependencies or replace them with supported packaged equivalents. The builder bundles that dependency graph; an installed output package does not need sibling TypeScript or application source.

The source package must include:

- `openclaw.plugin.json` and a single `package.json.openclaw.extensions` native entry.
- `app.plugin.json` with `manifestVersion: 1`, `apiVersion: 1`, the same `id` and `nativePluginId`, a version, Main/browser entry names, declared capabilities, commands, and slots.
- Optional `app.plugin.json.native` declares `{defaultEnabled, userToggleable}` for trusted bundled defaults. External packages cannot self-enable through metadata.
- `package.json.app.main` and `.browser` pointing to source entries.

The result `output/packages/<id>/<artifact-hash>/` is a complete local native install package with its `app/` companion, native single-file ESM entry, and skills. Install that directory through extension management. External app code requires a separate hash-bound code review and approval; a native capability token does not approve Main/UI code. Restart the application after installation, approval, replacement, or removal. Rebuilding only the plugin changes its artifact hash and does not require rebuilding the application. The supported native profile bundles business dependencies, allows literal public OpenClaw SDK imports, and rejects alternate code loaders. It is a format restriction, not a malicious-code sandbox.

## Main contract

Import types from `@app-plugin/sdk/main` and `@app-plugin/sdk/contracts`. Export a synchronous `register(host)` that returns commands and optional participants. `activate`, `onEnable`, and registration are synchronous; declare async work in commands, deletion preparation, or package mutation preflight. `activate` creates persistent metadata coordinators once; `onEnable` creates business listeners for the current epoch and returns their disposer.

The host provides an explicit session metadata/execution port, the real product SQLite transaction connection through a guarded facade, native state paths, bound Gateway requests, lifecycle receipts, and logging. Do not import host controllers or retain copies of their mutable state. A command and its manifest must declare the same identifier. Submission participants receive a bounded structured envelope whose plugin, mode, and epoch are chosen and rechecked by the host. Resource participants fence and expand deletion cohorts before asynchronous preparation. All participants must agree before any deletion begins.

Cleanup capability declarations and parameter predicates are explicit. Cleanup must not create sessions or send turns. Receipt listeners consume identity/status only. Protected resources are recorded with their owner and exact artifact hash. An old approved artifact may recover cleanup for journal-referenced resources, but receives no business commands or UI. Unknown or failed cleanup vetoes destructive deletion and package changes. Never replay an uncertain send, duplicate native transcripts, or infer settled execution from a chat final.

Use `host.publishEvent(name, payload)` for transient bounded metadata and Browser `host.onEvent(name, listener)` to observe it. The host binds the active plugin ID, artifact hash and business epoch; stale or foreign events are ignored and subscriptions retire with their browser instance. Validate and project native events in the plugin before publication. These events do not create another transcript or configuration authority.

## Browser contract

Import `AppBrowserHost` from `@app-plugin/sdk/browser`; use `@app-plugin/sdk/browser-runtime`, `ui`, `rendering`, `presentation`, `interactions`, and `metadata` for the neutral browser ports and types. Export synchronous `register(host)` and register declared views, composer modes, translations, and metadata projections. Return a disposer and observe `host.signal` for pending tasks. Use the shared host React adapter supplied by the builder, not a separately bundled React runtime.

Current slots: `workspace.tab`, `plugin.settings`, `plugin.history`, `composer.mode`, `chat.action`, `session.summary`, `application.page`, `interactions.presentation`, `session.presentation`, `session.details`, and `messages.presentation`. Unknown or undeclared slots/commands are rejected. Use `host.application` for draft, file, navigation, and metadata operations. Native history remains a host-rendered mounted Gateway projection through `host.renderHistory`; plugins do not get the chat controller or a transcript cache. Composer preparation returns `{prompt, input?}`; the host supplies the owner/epoch envelope and rejects stale preparation before send.

Keep background discovery in an `application.page` observer, independently of whether a summary or workspace tab is open. Publish `summaryAvailable` through `registerSessionPresentation` and call `interactionContextChanged` when that metadata changes; the host can then reveal the session summary once. The summary view only renders the entry. Use `openWorkspace` from the observer for plugin-specific first-discovery navigation, checking the current product session and plugin lifetime before opening.

Disabling a native plugin withdraws all its views, settings/history actions, translations, modes, and cached callbacks. Re-enabling creates a new epoch and does not reopen an old dialog. UI resources are served from immutable hash/epoch routes on the application's origin; Main entry and native binding files are not served to the browser.

## Trust and limits

Main runs trusted code in the Electron process and browser modules run in the application page. The SDK guards lifetimes and accidental misuse; it does not isolate hostile JavaScript. Only SDK v1, the declared native single-file profile, and the current React 18 host adapter are supported. A new host primitive may require an SDK change. Package code is cold-loaded; live binary hot replacement and production installer certification are outside this implementation's acceptance claim.
