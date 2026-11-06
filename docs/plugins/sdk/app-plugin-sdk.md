# App Plugin SDK v1

This package defines the public contract between a trusted app companion and its application host. Native, Electron Main, and React code are built as independent artifacts through public SDK contracts.

## Build and package

Use Node 24 as specified by the package metadata. React and ReactDOM are peer dependencies; a browser artifact uses the host's actual React instance.

An independent project installs compatible `@app-plugin/sdk`, `@app-plugin/build`, and its declared dependencies. Supply matching public OpenClaw declarations through `OPENCLAW_SDK_ROOT` or `--sdk-root` for native type checking:

```sh
app-plugin-build check --source ./example-plugin --sdk-root /prepared/openclaw/dist/plugin-sdk
app-plugin-build build --source ./example-plugin --out ./build/app-plugins
```

The builder resolves installed package exports and uses its public Tailwind preset; it does not read application source, host theme files, ancestor TypeScript aliases or sibling plugin implementations. Required running capabilities are separate from npm dependencies; successful compilation does not prove that an arbitrary native runtime supports managed execution.

`@app-plugin/sdk/planning` is a pure application policy contract. Native consumers
can interpret an exact raw session entry; Main consumers inject an authenticated,
identity-checked namespace reader into `readPlanningSnapshot`. Runtime Services
provides only the generic bounded namespace transport and does not interpret Plan
Mode fields. An omitted display projection cannot establish unrestricted execution.
Plugin business protocols and receipt schemas stay inside their owning package.

The source package must include:

- `openclaw.plugin.json` and a single `package.json.openclaw.extensions` native entry.
- `app.plugin.json` with `manifestVersion: 1`, `apiVersion: 1`, the same `id` and `nativePluginId`, a version, Main/browser entry names, declared capabilities, commands, and slots.
- Optional `app.plugin.json.native` declares `{defaultEnabled, userToggleable}` for trusted bundled defaults. External packages cannot self-enable through metadata.
- `package.json.app.main` and `.browser` pointing to source entries.
- Explicit npm dependencies and a LICENSE. The complete package includes license files for actual bundled dependencies and strips install hooks and bundled npm dependency declarations.

The result `output/packages/<id>/<artifact-hash>/` is a complete local native install package with its `app/` companion, native single-file ESM entry, and skills. Install that directory through extension management. Explicit installation or update authorizes the exact app artifact: the host confirms the installed native identity and canonical path, validates the native binding and artifact hashes, retains immutable code, and records hash-bound trust within the same stopped-Gateway package operation. A native capability token or marketplace source does not replace these checks. No second app-code confirmation or restart is needed after a successful managed install. Package changes stop and restart the owned Gateway before admitting the new Main/UI artifact; the application stays open. Native execution remains disabled until explicitly enabled. Unconfirmed installation or failed artifact validation cannot grant trust, and externally modified or previously unapproved code still requires explicit confirmation or re-import. Rebuilding only the plugin changes its artifact hash and does not require rebuilding the application. The supported native profile bundles business dependencies, allows literal public OpenClaw SDK imports, and rejects alternate code loaders. It is a format restriction, not a malicious-code sandbox.

## Main contract

Import types from `@app-plugin/sdk/main` and `@app-plugin/sdk/contracts`. Export a synchronous `register(host)` that returns commands and optional participants. `activate`, `onEnable`, and registration are synchronous; declare async work in commands, deletion preparation, or package mutation preflight. `activate` creates persistent metadata coordinators once; `onEnable` creates business listeners for the current epoch and returns their disposer.

The host provides an explicit session metadata/execution port, the real product SQLite transaction connection through a guarded facade, native state paths, bound Gateway requests, lifecycle receipts, and logging. Do not import host controllers or retain copies of their mutable state. A command and its manifest must declare the same identifier. Submission participants receive a bounded structured envelope whose plugin, mode, and epoch are chosen and rechecked by the host. Resource participants fence and expand deletion cohorts before asynchronous preparation. All participants must agree before any deletion begins.

Cleanup capability declarations and parameter predicates are explicit. Cleanup must not create sessions or send turns. Receipt listeners consume identity/status only. Protected resources are recorded with their owner and exact artifact hash. An old approved artifact may recover cleanup for journal-referenced resources, but receives no business commands or UI. Unknown or failed cleanup vetoes destructive deletion and package changes. Never replay an uncertain send, duplicate native transcripts, or infer settled execution from a chat final.

Use `host.publishEvent(name, payload)` for transient bounded metadata and Browser `host.onEvent(name, listener)` to observe it. The host binds the active plugin ID, artifact hash and business epoch; stale or foreign events are ignored and subscriptions retire with their browser instance. Validate and project native events in the plugin before publication. These events do not create another transcript or configuration authority.

### Managed private data (SDK 1.2)

Declare `app.plugin.json.data: {"directory":"managed-v1"}` for private models,
downloads and caches. Main uses `host.getPluginDataDirectory()` during its current
business lifetime. Native imports `resolvePluginDataDirectory(stateDirectory,
pluginId)` from `@app-plugin/sdk/data`, supplying the public OpenClaw state root and
its own native ID. Both resolve the same host-prepared `plugin-data/<plugin-id>`
directory and verify its `.owner.json` receipt. The resolver never creates a
directory, migrates data or falls back to another path. Missing preparation is
unavailable; do not construct a substitute path.

The optional declaration
`"migrateLegacyDirectory":{"requiredFiles":["selection.json"]}` claims only the
same plugin's former `<state>/<plugin-id>` directory. The host verifies the named
regular files and the entire tree, then renames it while Gateway is stopped.
Reserved state directories, links, hardlinks, unexpected ownership or two existing
data directories prevent migration. It never merges or overwrites directories.
Plugin code and required files remain plugin-owned; the host has no model-specific
layout or download logic.

Updating or disabling a plugin preserves this directory. Uninstalling preserves it
by default and offers an explicit option to delete eligible private data.
Only the receipt-owned managed directory participates; the host stops owned work,
verifies every selected owner's current files and requires successful native
uninstall evidence before cleanup. Size inspection does not grant removal
authority. Keep shared resources, user documents, product database records and
native history outside this directory.
`getNativeStateDirectory()` keeps its existing meaning and retention behavior.

SDK 1.3 adds `data.retention: "retain"` for plugin-owned execution safety records.
The host persists this policy in that directory's owner receipt and excludes the
whole directory from uninstall cleanup, including when the package is unavailable
or a later manifest omits the policy. Existing removable directories can be
strengthened to retained; retained data is never downgraded automatically. The
owner `dataId` and existing files remain unchanged when strengthening the policy.
Default removable directories keep the original three-field ownership record for
SDK 1.2 compatibility; only retained directories add `retention: "retain"`.
Native plugins that require retention pass `{retention: "retain"}` as the third
resolver argument, so a missing durable policy is unavailable. The Main port
enforces this condition automatically for a retained data declaration.

SDK 1.4 adds `host.getRetainedPluginDataDirectory()` for read-only metadata lookup
from current business or cleanup callbacks, including resource checks while the
plugin is disabled. Both the manifest and durable owner receipt must specify
`retention: "retain"`. The ordinary `getPluginDataDirectory()` remains limited to
the business lifetime. The retained lookup does not create directories or grant
write, execution or Gateway authority; open metadata stores read-only and preserve
their own identity checks. A retained filesystem policy does not keep a disposed
instance or an expired cleanup callback alive.

### Managed Python runtime (SDK 1.1)

`await host.getPythonRuntime()` returns the host-managed CPython descriptor published to the current Gateway, or `null`; reads require the current business lifetime and are rechecked after the asynchronous call. Native code imports `resolveHostPythonRuntime`, `assertHostPythonRuntimeCurrent`, and `createHostPythonEnvironment` from `@app-plugin/sdk/runtimes`. The host publishes the same bounded descriptor through the documented `APP_PLUGIN_PYTHON_RUNTIME` Gateway environment field, replacing inherited values. It contains the actual version, platform, architecture, canonical executable, standard-library search paths, and pinned core-file hashes. Missing or changed launch metadata stays unavailable until a normal Gateway restart republishes it. No PATH discovery, interpreter download or package installation occurs.

Resolve once for a request, check the plugin's required ABI/platform, and call `assertHostPythonRuntimeCurrent(runtime)` after asynchronous preparation, immediately before process launch, and before accepting its result. The SDK checks core-file hashes and retains file-identity fences on that descriptor. A missing, replaced or incompatible runtime is unavailable; do not fall back to a system interpreter. Descriptors express availability, never file or execution authorization, and stay in Native/Main rather than Browser events.

Use the existing authorized process API to launch `runtime.executable` with `-I -B` and plugin-owned runner resources. Pass `createHostPythonEnvironment()` as an explicit clean base (for example, OpenClaw `runCommandBuffered` with `baseEnv: {}` and `env` set to this result), then supply private temporary/cache directories as needed. An environment overlay alone retains inherited package paths. Windows embedded Python can still import `sitecustomize` through its `._pth` despite `-S`; the runner bootstrap must restrict `sys.path` to `runtime.standardLibraryPaths` plus its own verified dependency directory. Bundle ABI-matched dependencies in plugin-private resources, without changing host or user site-packages.

## Browser contract

Import `AppBrowserHost` from `@app-plugin/sdk/browser`; use `@app-plugin/sdk/browser-runtime`, `ui`, `rendering`, `presentation`, `interactions`, and `metadata` for the neutral browser ports and types. Export synchronous `register(host)` and register declared views, composer modes, translations, and metadata projections. Return a disposer and observe `host.signal` for pending tasks. Use the shared host React adapter supplied by the builder, not a separately bundled React runtime.

Current slots: `workspace.tab`, `plugin.settings`, `plugin.history`, `composer.mode`, `chat.action`, `session.summary`, `application.page`, `interactions.presentation`, `session.presentation`, `session.details`, and `messages.presentation`. Unknown or undeclared slots/commands are rejected. Use `host.application` for draft, file, navigation, and metadata operations. Native history remains a host-rendered mounted Gateway projection through `host.renderHistory`; plugins do not get the chat controller or a transcript cache. Composer preparation returns `{prompt, input?}`; the host supplies the owner/epoch envelope and rejects stale preparation before send.

Keep background discovery in an `application.page` observer, independently of whether a summary or workspace tab is open. Publish `summaryAvailable` through `registerSessionPresentation` and call `interactionContextChanged` when that metadata changes; the host can then reveal the session summary once. The summary view only renders the entry. Use `openWorkspace` from the observer for plugin-specific first-discovery navigation, checking the current product session and plugin lifetime before opening.

Disabling a native plugin withdraws all its views, settings/history actions, translations, modes, and cached callbacks. Re-enabling creates a new epoch and does not reopen an old dialog. UI resources are served from immutable hash/epoch routes on the application's origin; Main entry and native binding files are not served to the browser.

## Tests and source relocation

Keep plugin business tests and native probes in the plugin's own `tests/` and `scripts/` directories.

Each companion can provide its own Vitest configuration and SDK-port fixtures. `@app-plugin/build/testing` installs a supplied public Browser runtime and returns a disposer; it supplies no private application behavior. Business tests run independently by default. Tests that intentionally exercise a real host receive its absolute directory through `APP_PLUGIN_HOST_ROOT`; they skip explicitly when no host was supplied and fail on an invalid supplied host. This test integration does not authorize production imports from host source. Declare and provide all SDK and npm dependencies before building in a separate repository. The host does not fall back to a sibling repository for missing plugins.

## Trust and limits

Main runs trusted code in the Electron process and browser modules run in the application page. The SDK guards lifetimes and accidental misuse; it does not isolate hostile JavaScript. Only SDK v1, the declared native single-file profile, and the current React 18 host adapter are supported. A new host primitive may require an SDK change. Package code is cold-loaded; live binary hot replacement and production installer certification are outside this implementation's acceptance claim.

[返回 SDK 文档索引](README.md)
