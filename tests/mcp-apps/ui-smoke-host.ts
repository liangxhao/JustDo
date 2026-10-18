import { McpAppMethod } from '../../src/shared/plugins/mcpApps';
import { McpAppView } from '../../src/renderer/libs/openclaw-chat/components/mcp-app/view';
import { McpAppSession } from '../../src/renderer/libs/openclaw-chat/gateway/mcp-app-session';
import { decodeMcpAppLaunch } from '../../src/renderer/libs/openclaw-chat/pipeline/native-mcp-app';

const fixture = window as unknown as {
  fixturePayload: Record<string, unknown>;
  fixtureCalls: Array<{ method: string; params: unknown }>;
  fixtureReady: boolean;
  fixtureView: McpAppView;
};
fixture.fixtureCalls = [];
const identity = {
  viewId: 'mcp-app-fixture',
  serverName: 'fixture',
  toolName: 'show',
  uiResourceUri: 'ui://fixture/app',
  toolCallId: 'fixture-call',
};
const client = {
  generation: 1,
  gatewayUrl: 'ws://127.0.0.1:18789',
  subscribeEvents: () => () => undefined,
  request: async (method: string, params: unknown) => {
    fixture.fixtureCalls.push({ method, params });
    if (method === McpAppMethod.View)
      return {
        ...fixture.fixturePayload,
        messageSupported: true,
        toolInput: {},
        toolResult: { content: [{ type: 'text', text: 'initial' }] },
      };
    if (method === McpAppMethod.CallTool)
      return { content: [{ type: 'text', text: 'echo:clicked' }] };
    return {};
  },
};
const apps = new McpAppSession(() => ({
  client: client as never,
  generation: 1,
  sessionKey: 'agent:a:fixture',
  sessionId: 'incarnation',
  agentId: 'a',
  isCurrent: () => true,
}));
const view = new McpAppView();
view.preview = decodeMcpAppLaunch({
  viewId: identity.viewId,
  preview: {
    kind: 'canvas',
    mcpApp: identity,
    view: { id: identity.viewId, title: 'MCP App smoke' },
    presentation: { target: 'assistant_message', sandbox: 'scripts' },
  },
});
view.context = {
  apps,
  sessionKey: 'agent:a:fixture',
  isCurrent: () => true,
  canDraft: () => true,
  addDraft: async () => {
    fixture.fixtureCalls.push({ method: 'draft', params: {} });
    return true;
  },
};
if (new URLSearchParams(location.search).has('workspace')) {
  const workspace = document.createElement('iframe');
  workspace.style.cssText = 'width:100%;height:720px;border:0';
  workspace.src = '/workspace';
  const loaded = new Promise<void>(resolve => {
    workspace.onload = () => resolve();
  });
  document.body.append(workspace);
  await loaded;
  workspace.contentDocument!.body.append(view);
} else document.body.append(view);
fixture.fixtureView = view;
fixture.fixtureReady = true;
