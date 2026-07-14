# Plugin domain

This directory is the main-process boundary for plugin capabilities. A plugin
can contribute skills, MCP servers, extensions, and hooks; those four runtime
areas live here with the marketplace and manager facade.

- `pluginManager.ts` is the application-facing facade.
- `skills/` contains Gateway-backed skill RPC access and local skill file
  import/delete operations.
- `mcp/` contains MCP server persistence, probing, and OpenClaw config sync.
- `extensions/` contains bundled extension registry, local extension runtime
  sync, the ask-user callback server, and interaction routing.
- `hooks/` contains hook persistence and OpenClaw config sync.
- `marketplace/` contains provider-neutral models, routing, and providers.
- `marketplace/openClawClawHubProvider.ts` is the reference implementation. It
  maps ClawHub Skill data to the common Extension/Skill/MCP marketplace model
  and delegates installation to OpenClaw.

Import plugin services through `src/main/libs/plugins` when a caller needs
multiple plugin capabilities, or through the subdomain barrel such as
`src/main/libs/plugins/mcp` when it only needs one capability. Avoid importing
plugin runtime code from `openclaw/*`; OpenClaw config and runtime code should
depend on this plugin boundary instead.

To connect a private ClawHub, implement `PluginMarketplaceProvider` in
`marketplace/types.ts`. Keep private authentication, endpoint configuration,
and response DTO conversion inside that provider. Replace
`OpenClawClawHubProvider` in `createPluginMarketplaceService` with the private
provider. Keep the application-facing source ID `default` for the configured
marketplace source; renderer and IPC code then need no changes.

Provider IDs must be stable and unique. A provider declares only the values of
`PluginKind` it actually supports. Extension and MCP providers can implement the
same contract later without changing the plugin manager.
