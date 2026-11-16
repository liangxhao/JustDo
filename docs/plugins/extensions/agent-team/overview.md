# Agent Team

Optional OpenClaw collaboration and group discussion plugin, with independent
Native, desktop Main, Browser and history presentation entries.

This package owns Team mode prompts, discussion input protocols and business
ledgers. The composer sends the selected prompt through ordinary chat. Runtime
Services provides inert storage and exact receipt reconciliation. Team tools use
the pure App SDK policy contract to check planning restrictions where they apply.
Native backend RPC still requires OpenClaw's trusted installation admission;
desktop companion code approval does not confer that trust.

Uninstalling withdraws business and UI contributions. Existing assistants,
sessions, native history, team metadata and unresolved safety receipts remain for
reinstallation. Unknown sends and launches are never replayed automatically.

The host prepares the SDK-managed `plugin-data/agent-team/` directory. Native
discussion and summary receipts use `discussion-receipts/` and
`summary-receipts/`. Uninstall preserves these receipts and any existing
`launch-receipts/` files. Maintenance reconciles previously enrolled launches
through the matching Main and Runtime Services receipts. Product metadata and
workspace attachments keep their own storage ownership.

## Development

Install the declared dependencies in this package, then run:

```bash
npm run check
npm run build
npm test
```

See [test setup](../../../../plugins/extensions/agent-team/tests/README.md) for business fixtures and the optional host profile. The [bundled skill](../../../../plugins/extensions/agent-team/skills/agent-team/SKILL.md) contains model-facing collaboration guidance. Host/native integration probes require an explicitly provided compatible host and prepared runtime.

Supported Node, OpenClaw, SDK and UI dependency ranges come from
[package.json](../../../../plugins/extensions/agent-team/package.json). The Native manifest and desktop companion declaration
are [openclaw.plugin.json](../../../../plugins/extensions/agent-team/openclaw.plugin.json) and
[app.plugin.json](../../../../plugins/extensions/agent-team/app.plugin.json). Build and test success does not grant Native
installation trust or prove production model and installer acceptance.
