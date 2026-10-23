import React, { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import ChatMessageDisplay from '../../src/renderer/features/cowork/components/chat/ChatMessageDisplay';
import CoworkDisplayPanel from '../../src/renderer/features/cowork/components/display/CoworkDisplayPanel';
import { useMcpAppReferenceTabs } from '../../src/renderer/features/cowork/components/display/tabs/useMcpAppReferenceTabs';
import { useMcpAppTabs } from '../../src/renderer/features/cowork/components/display/tabs/useMcpAppTabs';
import { useWidgetReferenceTabs } from '../../src/renderer/features/cowork/components/display/tabs/useWidgetReferenceTabs';
import { openWorkspaceApp } from '../../src/renderer/features/cowork/components/mcpApps/workspaceApps';
import type { JustDoChatElement } from '../../src/renderer/libs/openclaw-chat/components/justdo-chat';
import { McpAppAnchor } from '../../src/renderer/libs/openclaw-chat/components/mcp-app/anchor';
import { getMcpAppPresentations } from '../../src/renderer/libs/openclaw-chat/components/mcp-app/presentations';
import type { McpAppViewContext } from '../../src/renderer/libs/openclaw-chat/components/mcp-app/view';
import type { NativeWidgetContext } from '../../src/renderer/libs/openclaw-chat/components/native-widget/host';
import { getNativeWidgetPresentations } from '../../src/renderer/libs/openclaw-chat/components/native-widget/presentations';
import { ChatController } from '../../src/renderer/libs/openclaw-chat/gateway/chat-controller';
import { McpAppSession } from '../../src/renderer/libs/openclaw-chat/gateway/mcp-app/mcp-app-session';
import {
  decodeMcpAppLaunch,
  readNativeMcpAppIdentity,
} from '../../src/renderer/libs/openclaw-chat/pipeline/native-mcp-app';
import { i18nService } from '../../src/renderer/services/i18n';
import { McpAppMethod } from '../../src/shared/plugins/mcpApps';

const fixture = window as any;
i18nService.setLanguage('en', { persist: false });
fixture.calls = [];
fixture.compositeCounts = { renders: 0, appLayouts: 0, widgetLayouts: 0 };
fixture.widgetManager = getNativeWidgetPresentations();
const appManager = getMcpAppPresentations();
fixture.surfaceStates = () => {
  const state = (entry: any) =>
    entry
      ? {
          documentUrl: entry.view.ownerDocument.URL,
          ready: entry.surface?.ready,
          failed: entry.surface?.failed,
          update: entry.surface?.lastUpdate ? JSON.parse(entry.surface.lastUpdate) : null,
        }
      : null;
  return { app: state(appManager.entries[0]), widget: state(fixture.widgetManager.entries[0]) };
};
const nativeSnapshots = new Map<string, any>();
const nativeIdentity = (kind: string) => {
  const entry = (kind === 'app' ? appManager : fixture.widgetManager).entries[0] as any;
  const session = kind === 'app' ? entry.view.resources?.session : undefined;
  const authority = session?.binding ?? entry.view.binding?.context;
  return {
    entry,
    view: entry.view,
    binding: kind === 'app' ? entry.binding : entry.view.binding,
    session,
    preview: entry.preview,
    descriptor: kind === 'app' ? readNativeMcpAppIdentity(entry.preview) : undefined,
    capturedContext: kind === 'widget' ? entry.view.binding?.context : undefined,
    guest: kind === 'widget' ? entry.view.guest : undefined,
    authority: Object.fromEntries(
      [
        'client',
        'generation',
        'sessionKey',
        'sessionId',
        'agentId',
        'presentationScope',
        'presentationOwner',
      ].map(key => [key, authority?.[key]]),
    ),
    descriptorValue: JSON.stringify(
      kind === 'app' ? readNativeMcpAppIdentity(entry.preview) : { docId: entry.preview.docId },
    ),
  };
};
fixture.captureNativeIdentity = (kind: string) => {
  nativeSnapshots.set(kind, nativeIdentity(kind));
};
fixture.verifyNativeIdentity = (kind: string) => {
  const previous = nativeSnapshots.get(kind);
  const current = nativeIdentity(kind);
  return {
    objects: [
      'entry',
      'view',
      'binding',
      'session',
      'preview',
      'descriptor',
      'capturedContext',
      'guest',
    ].every(key => current[key as keyof typeof current] === previous[key]),
    authority: Object.keys(previous.authority).every(
      key => current.authority[key] === previous.authority[key],
    ),
    descriptor: current.descriptorValue === previous.descriptorValue,
  };
};
for (const [manager, key] of [
  [appManager, 'appLayouts'],
  [fixture.widgetManager, 'widgetLayouts'],
] as const) {
  const layout = manager.layout;
  manager.layout = () => {
    if (++fixture.compositeCounts[key] > 5000) throw new Error('Unbounded surface layout updates');
    layout();
  };
}
fixture.iconLight =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20" rx="4" fill="#ea580c"/><path d="M5 5h10v10H5z" fill="none" stroke="white"/></svg>',
  );
fixture.iconDark = fixture.iconLight.replace('ea580c', 'fb923c');
fixture.iconCatalog = {
  servers: [
    {
      serverName: 'fixture',
      label: 'Fixture',
      icons: [
        { src: fixture.iconLight, theme: 'light' },
        { src: fixture.iconDark, theme: 'dark' },
      ],
      entrypoints: [],
    },
  ],
};
let active = true;
const client = {
  generation: 1,
  gatewayUrl: 'ws://127.0.0.1:18789',
  subscribeEvents: () => () => undefined,
  request: async (method: string, params: any) => {
    fixture.calls.push({ method, params });
    if (method === 'canvas.document.view') {
      if (params.docId !== 'composite-widget') throw new Error('Unexpected widget document');
      return fixture.widgetPayload;
    }
    if (method === McpAppMethod.Discover) return fixture.iconCatalog;
    if (method === McpAppMethod.View)
      return {
        ...fixture.fixturePayload,
        messageSupported: true,
        toolResult: {
          content: [{ type: 'text', text: 'seed' }],
          structuredContent: { id: params.viewId },
        },
      };
    if (method === McpAppMethod.CallTool) return { content: [{ type: 'text', text: 'allowed' }] };
    return {};
  },
};
const widgetController = new ChatController();
Object.assign(widgetController.state, {
  connected: true,
  client,
  sessionKey: 'agent:a:reference',
  currentSessionId: 'incarnation',
  initialHistoryReady: true,
  chatMessages: [
    {
      role: 'toolResult',
      toolName: 'show_widget',
      toolCallId: 'composite-widget-call',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            kind: 'canvas',
            presentation: {
              target: 'assistant_message',
              sandbox: 'scripts',
              title: 'Composite widget',
            },
            view: { id: 'composite-widget' },
          }),
        },
      ],
    },
  ],
});
widgetController.state.visibleChatMessages = widgetController.state.chatMessages;
const captureWidgetContext = (): NativeWidgetContext => ({
  client: client as never,
  generation: 1,
  sessionKey: 'agent:a:reference',
  sessionId: 'incarnation',
  presentationScope: 'conversation',
  isCurrent: () => active,
  canDraft: () => false,
});
const bindWidgetChat = (element: JustDoChatElement | null) => {
  if (element) element.captureWidgetContext = captureWidgetContext;
};
const apps = new McpAppSession(() =>
  active
    ? {
        client: client as never,
        generation: client.generation,
        sessionKey: 'agent:a:reference',
        sessionId: 'incarnation',
        agentId: 'a',
        isCurrent: () => active,
      }
    : undefined,
);
fixture.discoverIcons = () => apps.discover();
function context(): McpAppViewContext {
  const binding = apps.bind();
  return {
    apps,
    sessionKey: 'agent:a:reference',
    presentationScope: 'conversation',
    isCurrent: () => binding.isCurrent(),
    canDraft: () => active,
    addDraft: async () => false,
    resume: () => (active ? context() : undefined),
  };
}
function preview(id: string) {
  return decodeMcpAppLaunch({
    viewId: id,
    preview: {
      kind: 'canvas',
      mcpApp: {
        viewId: id,
        serverName: 'fixture',
        toolName: 'show',
        uiResourceUri: 'ui://fixture/app',
        originSessionKey: 'agent:a:reference',
      },
      view: { id, title: 'Example dashboard' },
      presentation: { target: 'assistant_message', sandbox: 'scripts' },
    },
  })!;
}
const originalPreview = preview('mcp-app-inline');
function anchor() {
  const element = new McpAppAnchor();
  element.preview = originalPreview;
  element.context = context();
  return element;
}
function Harness() {
  if (++fixture.compositeCounts.renders > 250) throw new Error('Unbounded composite React renders');
  const [scope, setScope] = useState('conversation');
  const [selected, select] = useState('ordinary');
  const [open, setOpen] = useState(true);
  const [showWidget, setShowWidget] = useState(false);
  fixture.currentSelected = selected;
  const ref = useRef<HTMLDivElement>(null);
  const refs = useMcpAppReferenceTabs(scope, select, () => setOpen(true));
  const normal = useMcpAppTabs(scope, select, () => setOpen(true));
  const widgetRefs = useWidgetReferenceTabs(scope, select, () => setOpen(true));
  fixture.openWidget = () => {
    ref.current!.style.height = '220px';
    setShowWidget(true);
  };
  fixture.pinWidget = () => fixture.widgetManager.pin(fixture.widgetManager.entries[0]);
  fixture.unpinWidget = () => fixture.widgetManager.unpin(fixture.widgetManager.entries[0]);
  fixture.selectWidget = () => widgetRefs.tabs[0]?.onSelect();
  fixture.manager = getMcpAppPresentations();
  fixture.pin = () =>
    fixture.manager.pin(
      fixture.manager.entries.find((entry: any) => entry.preview.viewId === originalPreview.viewId),
    );
  fixture.closeReference = () => refs.tabs[0]?.onClose?.();
  fixture.selectNormal = () => select('ordinary');
  fixture.openFileTab = () =>
    openWorkspaceApp({
      id: 'file',
      sessionId: 'conversation',
      label: 'Example.file',
      filePath: 'E:/Example.file',
      preview: preview('mcp-app-file'),
      context: context(),
    });
  fixture.closeFileTab = async () => {
    await normal.tabs.find(tab => tab.id === 'file')?.onClose?.();
    select('ordinary');
  };
  fixture.selectReference = () => refs.tabs[0]?.onSelect();
  fixture.toggleOpen = () => setOpen(value => !value);
  fixture.replaceHistory = (removeOnly = false) => {
    ref.current!.replaceChildren();
    if (!removeOnly) ref.current!.append(anchor());
  };
  fixture.addDuplicate = () => ref.current!.append(anchor());
  fixture.cardLayout = (width = 400, language = 'en', long = false, dark = false) => {
    ref.current!.style.width = `${width}px`;
    i18nService.setLanguage(language, { persist: false });
    document.documentElement.classList.toggle('dark', dark);
    originalPreview.title = long
      ? 'A deliberately long document title for checking ellipsis and keeping actions visible'
      : 'Example dashboard';
    ref
      .current!.querySelectorAll<McpAppAnchor>('mcp-app-anchor')
      .forEach(element => element.requestUpdate());
  };
  fixture.overlay = (kind?: string) => {
    document.getElementById('fixture-overlay')?.remove();
    if (!kind) return;
    const element = document.createElement('div');
    element.id = 'fixture-overlay';
    if (kind === 'modal') element.dataset.workspaceOverlay = 'true';
    else element.setAttribute('role', kind);
    Object.assign(element.style, {
      position: 'fixed',
      inset: '0',
      zIndex: '50',
      background: 'white',
    });
    document.body.append(element);
  };
  fixture.switchSession = (value: boolean) => {
    apps.invalidate(true);
    active = value;
    apps.refreshBinding();
    setScope(value ? 'conversation' : 'other');
    if (value) {
      fixture.manager.resume('conversation');
      ref.current!.querySelectorAll<McpAppAnchor>('mcp-app-anchor').forEach(element => {
        element.context = context();
      });
    }
  };
  useLayoutEffect(() => {
    void apps.discover();
    ref.current!.append(anchor());
    openWorkspaceApp({
      id: 'ordinary',
      sessionId: 'conversation',
      label: 'Ordinary App',
      preview: preview('mcp-app-ordinary'),
      context: context(),
    });
  }, []);
  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh' }}>
      <div
        ref={ref}
        style={{
          position: 'absolute',
          left: 12,
          top: 40,
          width: 400,
          height: 650,
          overflow: 'auto',
        }}
      />
      {showWidget && (
        <div
          style={{
            position: 'absolute',
            left: 12,
            top: 300,
            width: 400,
            height: 450,
            display: 'flex',
          }}
        >
          <ChatMessageDisplay
            controller={widgetController}
            onChatElementChange={bindWidgetChat}
            fullWidth
          />
        </div>
      )}
      <CoworkDisplayPanel
        activeTabId={selected}
        isOpen={open}
        onClose={() => setOpen(false)}
        tabs={[...normal.tabs, ...refs.tabs, ...widgetRefs.tabs]}
        referenceContent={refs.panel(selected) ?? widgetRefs.panel(selected)}
        width={520}
      >
        {normal.panels(selected)}
      </CoworkDisplayPanel>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Harness />);
