# Chrome Assistant

This package contains the Chrome extension for page automation, page context
and desktop conversations in the Chrome side panel. Chrome loads the composed
extension; it is independent of OpenClaw's Gateway plugin installation flow.

| Path                                          | Responsibility                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| `openclaw/`                                   | Version-locked upstream relay baseline and its original notices            |
| `conversation-overlay/`                       | Product side panel, options, client modules and bundled browser resources  |
| `scripts/prepare.cjs`                         | Verify source snapshots, compose the extension and inject product metadata |
| `scripts/chrome-extension-markdown-entry.mjs` | Browser-only Markdown renderer                                             |
| `tests/`                                      | Chrome extension UI and client unit tests                                  |

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

The conversation client uses the same base app-server protocol as native clients:
model discovery, Thread/Turn/Item history and standard item notifications.
Browser-only input and rich display data use an explicit `chrome` namespace.
Native Messaging remains version 2; app-server discovery requires version 4.
Update the desktop application and extension together, restart the application
and reload the extension. Old wire names are not silently reused.
The side panel uses the rich browser stream and snapshots as its single message
display source; standard item notifications do not append a second copy.

A compatible desktop application provides Native Messaging, authenticated execution and application build adapters. Moving the source package does not supply those implementations.

## Conversations, media and approvals

The sending side panel displays native command and experimental plugin approvals,
with explicit choices and no preselected permission. Observers cannot answer for
another sending connection. Reject denies only the request; Cancel execution also
requests stopping that exact turn. A Stop acknowledgement does not prove the turn
has finished.

Allow this command for this session appears only when the server explicitly
offers it. It reuses the same command and execution environment within the same
connection and native session; each execution still receives a native one-time
decision. It creates no permanent command rule. Persistent App permission is a
separate, explicitly offered native App action, with its scope shown in the option
description and its permissions managed by the native application.

Switching conversations, stopping, expiry and disconnection withdraw pending
interaction. A withdrawn prompt or an old connection cannot grant later. Password
answer fields are masked, cleared when removed and kept out of the chat draft and
extension storage. This standard form capability does not connect every native
question tool or provide a complete MCP App interface.

Images use standard image input; documents keep browser attachment fields. The
side panel accepts up to five files totaling 4 MiB, supports PNG, JPEG, GIF and
WebP images, and validates them again in the desktop host. Image-only and
document-only sends preserve the empty user text. Sending images requires a
selected model that advertises image support; document attachments do not require
the image modality. The extension does not switch models or retry rejected input
automatically. Local image paths, remote image downloads, audio and upload
file IDs are not part of this side panel's standard input support.

Closing the side panel detaches its viewer and pending interactions. Already
accepted work can continue. Reopening checks the same execution and native
history; it does not replay input whose outcome is unknown. Full desktop Widget,
MCP App, plan review and complex native question interfaces remain outside this
side panel's supported UI.

## Launch conversations from a website

In the extension's site settings, add the exact HTTP(S) origin and grant Chrome
access. Refresh an already open website afterwards. Connection, direct sending
and result sharing are separate permissions. The desktop app must already be
running.

Copy the composed extension's bundled `chrome-assistant.js` to the website's own
assets and load it before binding a button. It has no CDN dependency.

```html
<script src="/assets/chrome-assistant.js"></script>
<button id="assist" type="button">Ask assistant</button>
<script type="module">
  const binding = await window.chromeAssistant.bind(
    document.querySelector('#assist'),
    {
      prompt: 'Summarize this record',
      context: { text: 'Prepared record snapshot' },
      mode: 'draft',
      result: 'final',
    },
    {
      onRequest: request => {
        /* Keep this document-local read/cancel handle. */
      },
      onStatus: receipt => {
        /* Update the button. */
      },
      onResult: receipt => {
        /* Display output.text as text, never raw HTML. */
      },
      onError: error => {
        /* Display a safe message for error.code. */
      },
    },
  );
  // await binding.update({ prompt: 'Updated record', mode: 'draft', result: 'none' });
  // await binding.unbind();
</script>
```

Only a real click on a registered, connected, top-level light DOM button opens
the side panel. Programmatic clicks and timers do not launch work. Prepare
asynchronous business data before the click, using `update()` when needed.
Registration times out after five seconds if the bridge is unavailable.

`mode` defaults to `draft`; `send` requests direct sending subject to permission.
`result` defaults to `none`; `final` requests this launch's final text subject to
separate consent. The side panel uses an independent input and conversation,
default model and ask permission. Existing drafts and attachments are preserved.
Editing external input or reopening an unsubmitted draft requires confirmation.
Website send/result consent is separate from tool approvals, session command
grants and persistent App permissions. Standard image support in ordinary chat
does not add attachments to the website entry.

`onRequest` runs before status/result callbacks. Its handle has requestId,
bindingRevision, an eventual launchId, `read()` and `cancel()`. Cancellation after
dispatch withdraws sharing and returns TOO_LATE; only the trusted side panel can
stop the run. Unknown dispatch is never retried. Navigation, refresh, pagehide
and unbinding terminate sharing; handles do not authorize another document.

Receipts separate request, execution, output and delivery. A completed execution
may still have pending or unavailable output. Only exact settled native evidence
and a corroborated final message can produce a final result; history fragments,
tool output and later turns are not returned. Render results as untrusted text
and handle duplicate events idempotently.

This entry accepts ordinary text and a bounded text snapshot, without webpage
attachments, slash commands, callback URLs, iframe/Shadow DOM buttons, or webpage
control over existing threads, models and permissions. Prompt is limited to
16,000 characters, context to 24,000 characters and the request to 128 KiB UTF-8;
encoded native context has a 24,000-character total budget. Final text is limited
to 256 KiB UTF-8. Oversized input/output is rejected rather than silently truncated.
