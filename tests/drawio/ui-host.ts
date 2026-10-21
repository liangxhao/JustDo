import { McpAppView } from '../../src/renderer/libs/openclaw-chat/components/mcp-app/view';
import { McpAppAnchor } from '../../src/renderer/libs/openclaw-chat/components/mcp-app/anchor';
import { getMcpAppPresentations } from '../../src/renderer/libs/openclaw-chat/components/mcp-app/presentations';
import { McpAppSession } from '../../src/renderer/libs/openclaw-chat/gateway/mcp-app/mcp-app-session';
import { decodeMcpAppLaunch } from '../../src/renderer/libs/openclaw-chat/pipeline/native-mcp-app';
import { McpAppMethod } from '../../src/shared/plugins/mcpApps';
import {
  DRAWIO_CANVAS_METHOD,
  DRAWIO_CURRENT_METHOD,
} from '../../openclaw-extensions/drawio/contracts';
import { mountMcpList } from './list-host';
const fixture = window as unknown as {
  fixturePayload: Record<string, unknown>;
  fixtureFile: { name: string; resourceUri: string; xml: string } | null;
  fixtureView: McpAppView;
  downloads: unknown[];
  fixtureModelContext: { updateId: string; content?: unknown } | null;
  fixtureSwitchSession: (active: boolean) => void;
  fixtureSnapshot: Record<string, unknown>;
  fixturePrepareDiagram: () => Promise<unknown>;
  fixtureApplyDiagram: (xml: string) => Promise<unknown>;
  fixtureReference: (pinned: boolean) => void;
  fixtureViewReads: number;
};
fixture.downloads = [];
fixture.fixtureModelContext = null;
fixture.fixtureViewReads = 0;
window.electron = {
  mcpApps: {
    downloadFile: async (input: unknown) => {
      fixture.downloads.push(input);
      return { success: true, value: { canceled: false } };
    },
  },
} as never;
const identity = {
  viewId: 'mcp-app-drawio-offline',
  serverName: 'drawio',
  toolName: new URLSearchParams(location.search).has('file')
    ? 'open_file'
    : new URLSearchParams(location.search).has('blank')
      ? 'open_editor'
      : 'create_diagram',
  uiResourceUri: 'ui://drawio/editor',
  toolCallId: 'offline-test',
  originSessionKey: 'agent:main:offline',
};
const listeners = new Set<(event: { event: string; payload: unknown }) => void>();
let operation: Record<string, unknown> | undefined;
let acknowledge: ((value: unknown) => void) | undefined;
const client = {
  generation: 1,
  gatewayUrl: 'ws://127.0.0.1:18789',
  subscribeEvents: (listener: (event: { event: string; payload: unknown }) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  request: async (method: string, params: Record<string, unknown>) => {
    if (method === DRAWIO_CURRENT_METHOD) return { diagram: null };
    if (method === DRAWIO_CANVAS_METHOD) {
      if (params.action === 'prepare') {
        fixture.fixtureSnapshot = params.snapshot as Record<string, unknown>;
        return { token: 'fixture-canvas-token' };
      }
      if (params.action === 'next') {
        const pending = operation;
        operation = undefined;
        return { operation: pending ?? null };
      }
      if (params.action === 'ack') {
        acknowledge?.(params.result);
        acknowledge = undefined;
        return {};
      }
      return {};
    }
    if (method === McpAppMethod.View) {
      fixture.fixtureViewReads++;
      return {
        ...fixture.fixturePayload,
        messageSupported: true,
        updateModelContextSupported: true,
      };
    }
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
        agentId: 'main',
        isCurrent: () => active,
      }
    : undefined,
);
const view = new McpAppView();
fixture.fixturePrepareDiagram = () =>
  apps.prepareChatSend({
    sessionKey: 'agent:main:offline',
    presentationScope: 'conversation',
    sessionId: 'offline',
    idempotencyKey: crypto.randomUUID(),
    message: 'Edit diagram',
  });
fixture.fixtureApplyDiagram = xml =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Editor ACK timed out')), 30_000);
    acknowledge = result => {
      clearTimeout(timer);
      resolve(result);
    };
    operation = {
      operationId: crypto.randomUUID(),
      diagramId: fixture.fixtureSnapshot.diagramId,
      baseContentStamp: fixture.fixtureSnapshot.contentStamp,
      xml,
      title: 'Updated current diagram',
    };
    for (const listener of listeners)
      listener({ event: 'plugin.drawio.canvas-changed', payload: { viewId: identity.viewId } });
  });
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
  if (active) fixture.fixtureView?.resume();
};
if (new URLSearchParams(location.search).has('list')) mountMcpList();
else if (new URLSearchParams(location.search).has('reference')) {
  const anchor = new McpAppAnchor();
  anchor.preview = view.preview;
  anchor.context = context();
  document.body.append(anchor);
  const manager = getMcpAppPresentations();
  const target = document.createElement('div');
  target.style.cssText =
    'position:fixed;top:60px;right:20px;bottom:40px;width:85vw;display:none;background:white';
  document.body.append(target);
  Object.defineProperty(fixture, 'fixtureView', { get: () => manager.entries[0]?.view });
  fixture.fixtureReference = pinned => {
    const entry = manager.entries[0];
    if (pinned) {
      target.style.display = 'block';
      manager.pin(entry);
      manager.setSidebar(entry, target);
    } else {
      manager.unpin(entry);
      target.style.display = 'none';
    }
  };
} else {
  document.body.append(view);
  fixture.fixtureView = view;
}
