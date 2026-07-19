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

Import plugin services through `src/main/plugins` when a caller needs
multiple plugin capabilities, or through the subdomain barrel such as
`src/main/plugins/mcp` when it only needs one capability. Avoid importing
plugin runtime code from `openclaw/*`; OpenClaw config and runtime code should
depend on this plugin boundary instead.

To connect an enterprise marketplace, implement `PluginMarketplaceProvider` in
`marketplace/types.ts`. Keep private authentication, endpoint configuration,
and response DTO conversion inside that provider. Register it in
`createPluginMarketplaceService`; renderer and generic IPC code then need no
changes. No marketplace provider is registered by default, so product builds
must explicitly register the configured enterprise provider.

Provider IDs must be stable and unique. A provider declares only the values of
`PluginKind` it actually supports. Search pagination and install/update state
are part of the shared contract; private response DTOs stay inside the provider.
