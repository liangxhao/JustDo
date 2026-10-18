import { McpAppView } from '../../src/renderer/libs/openclaw-chat/components/mcp-app/view';
import { McpAppSession } from '../../src/renderer/libs/openclaw-chat/gateway/mcp-app-session';
import { decodeMcpAppLaunch } from '../../src/renderer/libs/openclaw-chat/pipeline/native-mcp-app';
import { McpAppMethod } from '../../src/shared/plugins/mcpApps';
import { mountMcpList } from './list-host';
const fixture = window as unknown as {
  fixturePayload: Record<string, unknown>;
  fixtureView: McpAppView;
  downloads: unknown[];
};
fixture.downloads = [];
window.electron = {
  mcpApps: {
    downloadFile: async (input: unknown) => {
      fixture.downloads.push(input);
      return { success: true, value: { canceled: false } };
    },
  },
} as never;
const identity = {
  viewId: 'drawio-offline',
  serverName: 'drawio',
  toolName: new URLSearchParams(location.search).has('blank') ? 'open_editor' : 'create_diagram',
  uiResourceUri: 'ui://drawio/editor',
  toolCallId: 'offline-test',
};
const client = {
  generation: 1,
  gatewayUrl: 'ws://127.0.0.1:18789',
  subscribeEvents: () => () => undefined,
  request: async (method: string) =>
    method === McpAppMethod.View
      ? {
          ...fixture.fixturePayload,
          messageSupported: true,
        }
      : {},
};
const apps = new McpAppSession(() => ({
  client: client as never,
  generation: 1,
  sessionKey: 'agent:main:offline',
  sessionId: 'offline',
  isCurrent: () => true,
}));
const view = new McpAppView();
view.preview = decodeMcpAppLaunch({
  viewId: identity.viewId,
  preview: {
    kind: 'canvas',
    mcpApp: identity,
    view: { id: identity.viewId, title: 'draw.io' },
    presentation: { target: 'assistant_message', sandbox: 'scripts' },
  },
});
view.context = {
  apps,
  sessionKey: 'agent:main:offline',
  isCurrent: () => true,
  canDraft: () => true,
  addDraft: async () => false,
};
if (new URLSearchParams(location.search).has('list')) mountMcpList();
else document.body.append(view);
fixture.fixtureView = view;
