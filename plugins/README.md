# Built-in plugins

All application-owned built-in plugins live in this directory, grouped by type:

```text
plugins/
├── extensions/   # OpenClaw extensions, including their own skills and assets
├── skills/       # Standalone skills and builtin-skills.json
├── mcp-servers/  # Reserved for standalone built-in MCP servers
└── hooks/        # Reserved for standalone built-in hooks
```

Keep extension-owned tools, UI, assets, scripts and unit tests with their
extension. Skills supplied by an extension stay inside that extension;
`skills/` contains the standalone built-in skill library.

`skills/builtin-skills.json` selects the standalone skills and upstream OpenClaw
skills included in the runtime. Build and packaging scripts copy selected skills
to the native runtime's `skills/` and `custodian-skills/` directories, and extensions
to its `dist/extensions/` directory. Development source discovery uses
`plugins/extensions/`; installed applications use the assembled native runtime.

`mcp-servers/` and `hooks/` are placeholders without built-in loading or packaging logic.
Application resources such as icons, browser extensions, documentation templates
and runtime preparation caches remain in `resources/`.

CI uses the repository's `npm run lint` entry point for application source checks.
The skill validation job checks selected local sources against the real manifest
and tests skill synchronization; OpenClaw integration checks cover assembly into
the native runtime.
