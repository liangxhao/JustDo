# Plugin domain

This directory is the main-process boundary for installed plugin management and
marketplace access.

- `pluginManager.ts` is the application-facing facade.
- `marketplace/` contains provider-neutral models, routing, and providers.
- `marketplace/openClawClawHubProvider.ts` is the reference implementation. It
  maps ClawHub Skill data to the common Extension/Skill/MCP marketplace model
  and delegates installation to OpenClaw.

To connect a private ClawHub, implement `PluginMarketplaceProvider` in
`marketplace/types.ts`. Keep private authentication, endpoint configuration,
and response DTO conversion inside that provider. Replace
`OpenClawClawHubProvider` in `createPluginMarketplaceService` with the private
provider. Keep the application-facing source ID `default` for the configured
marketplace source; renderer and IPC code then need no changes.

Provider IDs must be stable and unique. A provider declares only the values of
`PluginKind` it actually supports. Extension and MCP providers can implement the
same contract later without changing the plugin manager.
