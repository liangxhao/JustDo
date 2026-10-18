// Real native history through the production controller and message timeline.
import { JustDoChatElement } from '../../src/renderer/libs/openclaw-chat/components/justdo-chat';
import { ChatController } from '../../src/renderer/libs/openclaw-chat/gateway/chat-controller';

const bootstrap = await fetch(new URL('payload', location.href)).then(response => response.json());
// Only the Save destination is replaced; all history, admission, view reads and
// App interactions use the actual authenticated Gateway connection.
window.electron = {
  mcpApps: {
    downloadFile: async (input: unknown) =>
      fetch(new URL('download', location.href), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }).then(response => response.json()),
  },
} as never;
const controller = new ChatController({ expectInitialHistory: true });
const chat = new JustDoChatElement();
chat.controller = controller;
chat.assistantName = 'Assistant';
chat.canDraftWidget = () => true;
chat.addMcpAppDraft = async () => false;
document.body.append(chat);
Object.assign(window, { liveController: controller, liveChat: chat });
Object.defineProperty(window, 'liveView', {
  get: () => chat.shadowRoot?.querySelector('mcp-app-view'),
});
await controller.connect(bootstrap.gatewayUrl, bootstrap.token, bootstrap.sessionKey);
window.addEventListener('pagehide', () => controller.disconnect(), { once: true });
