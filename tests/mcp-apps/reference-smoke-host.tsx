import React, { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import CoworkDisplayPanel from '../../src/renderer/features/cowork/components/display/CoworkDisplayPanel';
import { useMcpAppReferenceTabs } from '../../src/renderer/features/cowork/components/display/useMcpAppReferenceTabs';
import { useMcpAppTabs } from '../../src/renderer/features/cowork/components/display/useMcpAppTabs';
import { openWorkspaceApp } from '../../src/renderer/features/cowork/components/mcpApps/workspaceApps';
import { McpAppAnchor } from '../../src/renderer/libs/openclaw-chat/components/mcp-app/anchor';
import { getMcpAppPresentations } from '../../src/renderer/libs/openclaw-chat/components/mcp-app/presentations';
import type { McpAppViewContext } from '../../src/renderer/libs/openclaw-chat/components/mcp-app/view';
import { McpAppSession } from '../../src/renderer/libs/openclaw-chat/gateway/mcp-app/mcp-app-session';
import { decodeMcpAppLaunch } from '../../src/renderer/libs/openclaw-chat/pipeline/native-mcp-app';
import { i18nService } from '../../src/renderer/services/i18n';
import { McpAppMethod } from '../../src/shared/plugins/mcpApps';

const fixture = window as any;
i18nService.setLanguage('en', { persist: false });
fixture.calls = [];
let active = true;
const client = {
  generation: 1,
  gatewayUrl: 'ws://127.0.0.1:18789',
  subscribeEvents: () => () => undefined,
  request: async (method: string, params: any) => {
    fixture.calls.push({ method, params });
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
  const [scope, setScope] = useState('conversation');
  const [selected, select] = useState('ordinary');
  const [open, setOpen] = useState(true);
  fixture.currentSelected = selected;
  const ref = useRef<HTMLDivElement>(null);
  const refs = useMcpAppReferenceTabs(scope, select, () => setOpen(true));
  const normal = useMcpAppTabs(scope, select, () => setOpen(true));
  fixture.manager = getMcpAppPresentations();
  fixture.pin = () =>
    fixture.manager.pin(
      fixture.manager.entries.find((entry: any) => entry.preview.viewId === originalPreview.viewId),
    );
  fixture.closeReference = () => refs.tabs[0]?.onClose?.();
  fixture.selectNormal = () => select('ordinary');
  fixture.selectReference = () => refs.tabs[0]?.onSelect();
  fixture.toggleOpen = () => setOpen(value => !value);
  fixture.replaceHistory = (removeOnly = false) => {
    ref.current!.replaceChildren();
    if (!removeOnly) ref.current!.append(anchor());
  };
  fixture.addDuplicate = () => ref.current!.append(anchor());
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
      <CoworkDisplayPanel
        activeTabId={selected}
        isOpen={open}
        onClose={() => setOpen(false)}
        tabs={[...normal.tabs, ...refs.tabs]}
        referenceContent={refs.panel(selected)}
        width={520}
      >
        {normal.panels(selected)}
      </CoworkDisplayPanel>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<Harness />);
