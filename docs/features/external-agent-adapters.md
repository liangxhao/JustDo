# External Agent adapter development

External Agents are product capabilities, not user-installed command lines.
The application only lets a user enable an Agent already shipped in that build
and choose the shared ACP permission mode, read-only violation behavior, and
startup/control operation timeout. Agent identity, display metadata, adapter
command, dependencies, and packaged artifacts are owned by source code and the
release pipeline. Model, thinking, and working-directory choices remain
per-task/per-session controls. Tool access is configured separately from the
Agent list: users can expose plugin tools, selected OpenClaw built-in tools, and
enabled local stdio MCP Servers. Each capability defaults off and is persisted
only through the settings page's unified Save action.

The bundled ACPX 0.13.x runtime accepts stdio MCP bootstrap entries. The config
projector therefore excludes HTTP/SSE Servers, disabled Servers, entries without
a command, and the reserved bridge names `openclaw-plugin-tools` and
`openclaw-tools`. Supporting another transport requires an ACPX runtime/schema
update and Agent capability verification; do not merely add a UI switch or pass
an unsupported object shape.

## Registration point

Add one entry to `src/shared/openclaw/externalAgentCatalog.ts`:

```ts
{
  id: 'example-agent',
  name: 'Example Agent',
  descriptionKey: 'externalAgentsExampleDescription',
  defaultEnabled: false,
  adapter: {
    command: ExternalAgentCommandToken.NodeExecutable,
    args: [
      `${ExternalAgentCommandToken.AcpxPluginRoot}/node_modules/example-agent-acp/dist/cli.js`,
      '--stdio',
    ],
  },
},
```

The catalog order controls settings order and the first enabled Agent becomes
OpenClaw's default ACP Agent. IDs must be stable lowercase identifiers matching
`[a-z][a-z0-9-]{0,63}`. New entries should normally use
`defaultEnabled: false`; existing saved settings will receive that default on
the first run of the new build. Removed IDs are discarded when settings load.

Add `descriptionKey` to both the Chinese and English objects in
`src/renderer/services/i18n/translations.ts`. Product names such as Claude,
Gemini, or OpenCode can be used directly as `name`; descriptive text must use
translations.

Omit `adapter` only when this ACPX extension already replaces the upstream
ACPX command with a packaged, offline-safe command for that exact ID. At
present, `claude` and `codex` are prepared this way. Native ACP implementations
are registered as structured commands: `opencode acp`, `dsh --profile acp` for
DeepSeek Harness, and `hermes acp`. Never rely on an ACPX default containing
`npm`, `npx`, a package URL, or another runtime download.

The settings Test action is independent of the enabled checkbox and persisted
settings. The ACPX extension therefore remains enabled as a lazy backend even
when ACP dispatch has no allowed Agents. The config projector writes every
catalog ID to the plugin's `diagnosticAgents` allowlist; `acpx.agent.doctor`
resolves the exact catalog command and performs the ACP initialization probe.
It must not be replaced with a renderer-side executable lookup. A test result
is transient and must never enable an Agent or save the settings page.

## Command templates

Catalog commands and arguments accept these exact tokens:

| Token                 | Runtime value                             | Typical use                                    |
| --------------------- | ----------------------------------------- | ---------------------------------------------- |
| `${NODE_EXECUTABLE}`  | Electron/OpenClaw managed Node executable | Launch a packaged JavaScript adapter           |
| `${ACPX_PLUGIN_ROOT}` | Installed `acpx` extension directory      | Resolve an adapter under this extension        |
| `${OPENCLAW_ROOT}`    | Installed OpenClaw runtime directory      | Resolve a runtime-owned executable or resource |

Tokens can appear inside an argument, for example
`${ACPX_PLUGIN_ROOT}/node_modules/example-agent-acp/dist/cli.js`. Prefer these
tokens to absolute development-machine paths. The resolved command is still
passed as structured argv; do not join it into a shell string.

For a native executable shipped under the extension, use the executable path
as `command`:

```ts
adapter: {
  command: `${ExternalAgentCommandToken.AcpxPluginRoot}/bin/example-agent-acp.exe`,
  args: ['--stdio'],
},
```

If the executable name or layout differs by operating system or architecture,
ship a small JavaScript launcher as the stable catalog entry. The launcher
should select a package using `process.platform` and `process.arch`, validate
that the resolved file remains beneath the extension root, and spawn it with
`shell: false` and inherited stdio. Follow the Claude/Codex wrapper preparation
in `openclaw-extensions/acpx/src/codex-auth-bridge.ts` for executable
validation, Windows command handling, error forwarding, and process cleanup.

## Adapter contract

An adapter must:

- speak Agent Client Protocol over stdin/stdout without writing non-protocol
  data to stdout;
- support initialization, session creation/loading, prompt turns,
  cancellation, and session close as required by the declared capability set;
- report protocol errors on stderr and exit non-zero when startup cannot
  continue;
- keep authentication in the Agent's own supported credential store or an
  explicitly provisioned process environment; never place credentials in the
  catalog, logs, arguments, or committed files;
- honor ACP permission requests instead of bypassing the runtime policy;
- stop descendants when stdin closes, cancellation is requested, or the parent
  process exits;
- tolerate paths containing spaces and non-ASCII characters;
- avoid network installation or self-update behavior in the installed app.

If an Agent does not expose ACP directly, implement a dedicated adapter under
`openclaw-extensions/acpx/adapters/<agent-id>/` or add a pinned package to the
extension. Keep Agent-specific authentication, protocol translation, and
compatibility logic inside that adapter rather than branching OpenClaw core or
the settings UI.

## Dependency and packaging changes

For an npm adapter:

1. Add an exact version to `openclaw-extensions/acpx/package.json`.
2. Regenerate `openclaw-extensions/acpx/package-lock.json` with the repository's
   required Node/npm toolchain.
3. Add licenses and notices to `openclaw-extensions/acpx/THIRD_PARTY_NOTICES.md`.
4. If it has platform packages or native executables, extend
   `resolveAcpxRequiredRelativePaths` in
   `scripts/openclaw/sync-openclaw-runtime-resources.cjs` and the artifact verification
   in `scripts/packaging/electron-builder-hooks.cjs`.
5. Rebuild each supported runtime target. Do not copy a `node_modules` tree
   produced for one OS/architecture into another target.

For a repository-owned adapter, commit its source beneath
`openclaw-extensions/acpx/adapters/<agent-id>/`. The normal local-extension
assembly copies it into the target runtime. Add its entry file to the required
artifact checks so packaging fails closed if the file is absent.

Removing an Agent from a product requires removing its catalog entry, package
dependencies, lockfile entries, notices, native artifact checks, and focused
tests. Turning it off in settings only prevents execution; it does not remove
files from an installer.

## Required verification

At minimum, add tests for:

- catalog validation, safe default state, settings rendering, and unified save;
- generated ACP `allowedAgents` and `defaultAgent`, an `agents.entries.<id>` runtime owner with
  `runtime.type="acp"`, the managed main workspace as both owner `workspace` and default ACP
  `cwd`, no embedded-Agent model fallback, and ACPX structured argv;
- one visible subtask per external run when the native task ledger exposes both its
  `subagent` controller wrapper and `acp` backing instance;
- token expansion and paths containing spaces;
- target-specific dependency selection and missing-artifact failure;
- a fully offline `doctor` or initialization handshake using the real packaged
  adapter;
- the per-Agent Gateway doctor route, catalog allowlisting at IPC, and UI test
  success/failure states without persistence;
- session create, prompt, cancellation, close, parent termination, and orphan
  cleanup;
- deny-all, both read-only violation behaviors, and full-access approval behavior;
- authentication missing, executable missing, protocol mismatch, malformed
  output, timeout, and non-zero exit diagnostics;
- Windows plus every release OS/architecture supported by the new adapter.

Run the repository lint, build, Electron compilation, focused ACPX tests, and
the full Vitest suite before packaging. A release artifact is accepted only
when the final packaged runtime—not merely the source directory—contains and
loads the registered adapter without network access.
