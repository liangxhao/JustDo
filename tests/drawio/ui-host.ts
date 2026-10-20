import { McpAppView } from '../../src/renderer/libs/openclaw-chat/components/mcp-app/view';
import { McpAppSession } from '../../src/renderer/libs/openclaw-chat/gateway/mcp-app-session';
import { decodeMcpAppLaunch } from '../../src/renderer/libs/openclaw-chat/pipeline/native-mcp-app';
import { McpAppMethod } from '../../src/shared/plugins/mcpApps';
import { mountMcpList } from './list-host';
const fixture = window as unknown as {
  fixturePayload: Record<string, unknown>;
  fixtureFile: { name: string; resourceUri: string; xml: string } | null;
  fixtureView: McpAppView;
  downloads: unknown[];
  fixtureModelContext: { updateId: string; content?: unknown } | null;
  fixtureSwitchSession: (active: boolean) => void;
};
fixture.downloads = [];
fixture.fixtureModelContext = null;
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
  toolName: new URLSearchParams(location.search).has('file')
    ? 'open_file'
    : new URLSearchParams(location.search).has('blank')
      ? 'open_editor'
      : 'create_diagram',
  uiResourceUri: 'ui://drawio/editor',
  toolCallId: 'offline-test',
};
const client = {
  generation: 1,
  gatewayUrl: 'ws://127.0.0.1:18789',
  subscribeEvents: () => () => undefined,
  request: async (method: string, params: Record<string, unknown>) => {
    if (method === McpAppMethod.View)
      return {
        ...fixture.fixturePayload,
        messageSupported: true,
        updateModelContextSupported: true,
      };
    if (method === McpAppMethod.UpdateModelContext) {
      fixture.fixtureModelContext = { updateId: crypto.randomUUID(), content: params.content };
      return {};
    }
    if (method === McpAppMethod.ModelContext) return { state: fixture.fixtureModelContext };
    if (method === McpAppMethod.RemoveModelContext) {
      if (fixture.fixtureModelContext?.updateId === params.updateId)
        fixture.fixtureModelContext = null;
      return {};
    }
    if (method === McpAppMethod.ReadResource) {
      if (!fixture.fixtureFile || params.uri !== fixture.fixtureFile.resourceUri)
        throw new Error('Not the opened fixture file');
      return { contents: [{ uri: params.uri, text: fixture.fixtureFile.xml }] };
    }
    return {};
  },
};
let active = true;
const apps = new McpAppSession(() =>
  active
    ? {
        client: client as never,
        generation: 1,
        sessionKey: 'agent:main:offline',
        sessionId: 'offline',
        isCurrent: () => active,
      }
    : undefined,
);
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
const context = () => {
  const binding = apps.bind();
  return {
    apps,
    sessionKey: 'agent:main:offline',
    isCurrent: () => binding.isCurrent(),
    canDraft: () => active,
    addDraft: async () => false,
    resume: () => (active ? context() : undefined),
  };
};
view.context = context();
fixture.fixtureSwitchSession = value => {
  apps.invalidate(true);
  active = value;
  apps.refreshBinding();
  if (active) view.resume();
};
if (new URLSearchParams(location.search).has('list')) mountMcpList();
else document.body.append(view);
fixture.fixtureView = view;
