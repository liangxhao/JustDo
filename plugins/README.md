# Built-in plugins

All application-owned built-in plugins live in this directory, grouped by type:

```text
plugins/
├── extensions/          # OpenClaw extensions, including their own skills and assets
├── skills/              # Standalone skills and builtin-skills.json
├── mcp-servers/         # Reserved for standalone built-in MCP servers
├── hooks/               # Reserved for standalone built-in hooks
└── browser-extensions/  # Browser-loaded extensions, including browser-assistant
```

Keep extension-owned tools, UI, assets, scripts and unit tests with their
extension. Skills supplied by an extension stay inside that extension;
`skills/` contains the standalone built-in skill library.

`skills/builtin-skills.json` selects the standalone skills and upstream OpenClaw
skills included in the runtime. Build and packaging scripts copy selected skills
to the native runtime's `skills/` and `custodian-skills/` directories, and extensions
to its `dist/extensions/` directory. Development source discovery uses
`plugins/extensions/`; installed applications use the assembled native runtime.

`extensions/prune-policy.json` declares the version-scoped keep/remove policy for
upstream OpenClaw extensions. Runtime pruning rejects unreviewed extensions and
protects local extension directories separately. The policy is a build input
included in the runtime build fingerprint. Development source inventory excludes
this metadata file while continuing to flag unknown entries as incomplete.

`mcp-servers/` and `hooks/` are placeholders without built-in loading or packaging logic.
Application resources such as icons, documentation templates
and runtime preparation caches remain in `resources/`.

Browser extensions have their own browser installation and loading flow.
[`browser-assistant/`](browser-extensions/browser-assistant/README.md) owns its
upstream baseline, conversation overlay, assembly script and unit tests. Host
adapters for shared chat rendering, stream generation and Native Messaging stay
in `scripts/browser/` and the Main browser domain. Its composed Chrome extension
is generated at `build/browser-extension/chrome-extension/` and installed at
`resources/browser-extension/chrome-extension/`; its display name comes from
`productName`, and its existing extension identity is preserved.

CI uses the repository's `npm run lint` entry point for application source checks.
The skill validation job checks selected local sources against the real manifest
and tests skill synchronization; OpenClaw integration checks cover assembly into
the native runtime.
