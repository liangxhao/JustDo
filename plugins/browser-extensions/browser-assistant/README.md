# Browser Assistant

This package contains the browser extension for page automation, page context
and desktop conversations in the Chrome side panel. Chrome loads the composed
extension; it is independent of OpenClaw's Gateway plugin installation flow.

| Path                                           | Responsibility                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------- |
| `openclaw/`                                    | Version-locked upstream relay baseline and its original notices            |
| `conversation-overlay/`                        | Product side panel, options, client modules and bundled browser resources  |
| `scripts/prepare.cjs`                          | Verify source snapshots, compose the extension and inject product metadata |
| `scripts/browser-extension-markdown-entry.mjs` | Browser-only Markdown renderer                                             |
| `tests/`                                       | Browser extension UI and client unit tests                                 |

The desktop application distributes the loadable extension.
The source package name does not determine the browser display name or extension
ID: the existing `productName` injection and fixed public key retain those roles.
The desktop settings page reads the composed manifest's `version`, independently
of the application release version. Users can check the installed version under
Details → Version on Chrome's extensions page. Application release versions are
not injected into the extension's `version_name`.

The desktop application provides Native Messaging connection discovery and owns
permissions and product conversations. The extension owns its side panel,
options, page context and automation relay integration.
