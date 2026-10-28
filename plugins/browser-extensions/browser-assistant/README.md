# Browser Assistant

This package contains the browser extension for page automation, page context
and desktop conversations in the Chrome side panel. Chrome loads the composed
extension; it is independent of OpenClaw's Gateway plugin installation flow.

| Path                                           | Responsibility                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| `openclaw/`                                    | Version-locked upstream relay baseline and its original notices            |
| `conversation-overlay/`                        | Product side panel, options, client modules and generated offline bundles  |
| `scripts/prepare.cjs`                          | Verify source snapshots, compose the extension and inject product metadata |
| `scripts/browser-extension-markdown-entry.mjs` | Browser-only Markdown renderer                                             |
| `tests/`                                       | Browser extension UI and client unit tests                                 |

Run `npm run browser-extension:prepare` from the repository root to create the
loadable extension at `build/browser-extension/chrome-extension/`. Packaging copies
it to `resources/browser-extension/chrome-extension/` in the installed application.
The source package name does not determine the browser display name or extension
ID: the existing `productName` injection and fixed public key retain those roles.
The desktop settings page reads the composed manifest's `version`, independently
of the application release version. Users can check the installed version under
Details → Version on Chrome's extensions page. Application release versions are
not injected into the extension's `version_name`.

The host's `scripts/browser/` adapters build shared chat rendering and stream
modules into `conversation-overlay/`, and own the desktop Native Messaging helper.
Main owns connection discovery, permissions and product conversations. Integration
tests remain in `tests/browser-extension/` and `tests/scripts/`; source-only unit
tests live here. Browser extension sources do not import application `src`.

```bash
npm run browser-extension:build-markdown
npm run browser-extension:build-stream
npm run browser-extension:prepare
node node_modules/vitest/vitest.mjs run plugins/browser-extensions/browser-assistant/tests tests/browser-extension tests/scripts/prepare-browser-extension.test.ts
```

See the [side panel contract](../../../docs/features/browser/browser-extension-side-chat.md)
and [Chrome app-server API](../../../docs/app-server-api/browser/README.md) for
connection, security and lifecycle ownership.
