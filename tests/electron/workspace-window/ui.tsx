import '@xterm/xterm/css/xterm.css';
import '@/libs/openclaw-chat/components/justdo-chat';
import '@/theme/css/themes.css';

import { Terminal } from '@xterm/xterm';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import WindowHeader from '@/app/shell/window/WindowHeader';
import { WorkspaceNotifications } from '@/app/shell/WorkspaceNotifications';
import { MessageBrowserEvent } from '@/features/browser/messageBrowserLinks';
import CoworkDisplayPanel from '@/features/cowork/components/display/CoworkDisplayPanel';
import DisplayTabContextMenu from '@/features/cowork/components/display/DisplayTabContextMenu';
import { useDraggableModal } from '@/features/cowork/components/shared/useDraggableModal';
import { CoworkPet } from '@/features/cowork/components/status/CoworkPet';
import SwarmWorkflowPanel from '@/features/cowork/components/swarm-workflow/SwarmWorkflowPanel';
import TerminalPanel from '@/features/cowork/components/terminal/TerminalPanel';
import { ChatScrollController } from '@/libs/openclaw-chat/controllers/chat-scroll-controller';
import { observeEditorLayout } from '@/shared/dom/observeEditorLayout';
import { useOwnerDocument } from '@/shared/dom/ownerDocument';

window.addEventListener('error', event => {
  if (event.error?.stack) console.error(event.error.stack);
});

const probe = ((window as any).probe = {
  mounts: 0,
  unmounts: 0,
  data: [],
  composition: 0,
  selected: 0,
  webLinks: [],
});
window.addEventListener(MessageBrowserEvent.OpenWebUrl, event => {
  probe.webLinks.push((event as CustomEvent).detail.url);
});

function Tools() {
  const ownerDocument = useOwnerDocument();
  const [count, setCount] = useState(0);
  const [menu, setMenu] = useState(false);
  const [dragProbe, setDragProbe] = useState(false);
  probe.showDragProbe = () => setDragProbe(true);
  probe.hideDragProbe = () => setDragProbe(false);
  const terminalRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const diffRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    probe.mounts++;
    const terminal = new Terminal({ cols: 40, rows: 8, allowProposedApi: true });
    terminal.open(terminalRef.current!);
    terminal.write('retained terminal 中文\r\n');
    terminal.onData(value => probe.data.push(value));
    probe.terminal = terminal;
    probe.editor = monaco.editor.create(editorRef.current!, {
      value: 'retained draft',
      language: 'plaintext',
      automaticLayout: false,
    });
    observeEditorLayout(probe.editor);
    const originalModel = monaco.editor.createModel('original', 'plaintext');
    const modifiedModel = monaco.editor.createModel('modified', 'plaintext');
    probe.diffEditor = monaco.editor.createDiffEditor(diffRef.current!, { automaticLayout: false });
    probe.diffEditor.setModel({ original: originalModel, modified: modifiedModel });
    probe.diffLayoutWidth = () =>
      probe.diffEditor.getOriginalEditor().getLayoutInfo().width +
      probe.diffEditor.getModifiedEditor().getLayoutInfo().width;
    const disposeDiffLayout = observeEditorLayout(probe.diffEditor);
    const scrollHost = ownerDocument.querySelector<HTMLElement>('#probe-scroll-host')!;
    const scrollContent = ownerDocument.createElement('div');
    scrollContent.className = 'chat-container';
    scrollContent.style.height = '300px';
    scrollHost.attachShadow({ mode: 'open' }).append(scrollContent);
    const scrollController = new ChatScrollController(() => {});
    scrollController.connect(scrollHost);
    scrollController.afterRender(1);
    // The application owns the custom-element registry in the source realm.
    const chat = document.createElement('justdo-chat') as any;
    chat.messages = [
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'retained Lit 中文 [Web report](https://example.com/message-report)',
          },
        ],
        timestamp: 1,
      },
    ];
    chatRef.current!.append(chat);
    probe.chat = chat;
    probe.document = ownerDocument;
    probe.click = () => ownerDocument.querySelector<HTMLButtonElement>('#increment')!.click();
    probe.menu = () => ownerDocument.querySelector<HTMLButtonElement>('#menu')!.click();
    probe.move = () =>
      ownerDocument
        .querySelector<HTMLButtonElement>(
          '[aria-label="在独立窗口中打开侧边栏"]',
        )!
        .click();
    probe.snapshot = () => ({
      count: ownerDocument.querySelector('#increment')!.textContent,
      draft: probe.editor.getValue(),
      mounts: probe.mounts,
      unmounts: probe.unmounts,
      childHasApi: typeof (ownerDocument.defaultView as any).electron !== 'undefined',
      childMarker: typeof (ownerDocument.defaultView as any).probeMarker !== 'undefined',
      guestId: (ownerDocument.querySelector('webview') as any).getWebContentsId(),
      terminalText: terminal.buffer.active.getLine(0)?.translateToString(),
      litText: chat.shadowRoot?.textContent,
      litStyles: chat.shadowRoot?.querySelectorAll('style').length,
      menuInChild: !!ownerDocument.querySelector('[role="menu"]'),
      hasAllTabs: ['Browser', 'Terminal', 'agent-team', 'Swarm Workflow', 'Future plugin'].every(
        label =>
          Array.from(ownerDocument.querySelectorAll('[role="tab"]')).some(tab =>
            tab.textContent?.includes(label),
          ),
      ),
      blocker: !!ownerDocument.querySelector('[data-testid="workspace-main-prompt"]'),
      detached: !!ownerDocument.querySelector('[data-window-header]'),
    });
    return () => {
      probe.unmounts++;
      terminal.dispose();
      probe.editor.dispose();
      disposeDiffLayout();
      probe.diffEditor.dispose();
      originalModel.dispose();
      modifiedModel.dispose();
      scrollController.disconnect();
      chat.remove();
    };
  }, [ownerDocument]);
  return (
    <>
      <button id="increment" onClick={() => setCount(value => value + 1)}>
        {count}
      </button>
      <button id="menu" onClick={() => setMenu(true)}>
        Menu
      </button>
      <a
        id="external-link"
        href="https://example.com/workspace-link"
        target="_blank"
        rel="noopener noreferrer"
      >
        External link
      </a>
      <textarea
        id="draft"
        defaultValue="form draft"
        onCompositionStart={() => {
          probe.composition++;
        }}
      />
      <div id="probe-editor-host" ref={editorRef} style={{ height: 140, width: 380 }} />
      <div id="probe-diff-host" ref={diffRef} style={{ height: 140, width: 380 }} />
      <div ref={terminalRef} />
      <div ref={chatRef} style={{ height: 120 }} />
      <div id="probe-scroll-host" style={{ height: 80, overflowY: 'auto' }} />
      <div id="probe-terminal-host" style={{ position: 'relative', height: 180, width: 380 }}>
        <TerminalPanel cwd="" terminalId="probe-terminal" isObscured={false} />
      </div>
      <div id="probe-flow-host" style={{ height: 180, width: 620 }}>
        <SwarmWorkflowPanel
          sessionId="probe-flow"
          tasks={[]}
          onOpenTask={() => {}}
          snapshot={{
            success: true,
            flows: [
              {
                id: 'flow',
                revision: 1,
                goal: 'Responsive workflow',
                createdAt: 1,
                status: 'completed',
                nodes: ['a', 'b', 'c'].map(id => ({
                  id,
                  title: id,
                  kind: 'work',
                  status: 'done',
                  deps: [],
                  sessionKey: id,
                })),
              },
            ],
          }}
        />
      </div>
      {dragProbe && <DragProbe />}
      {React.createElement('webview', {
        src: (window as any).guestUrl,
        style: { width: 380, height: 150 },
      })}
      {menu && (
        <DisplayTabContextMenu
          x={20}
          y={20}
          canClose
          canCloseOthers={false}
          canCloseRight={false}
          onClose={() => {
            probe.selected++;
          }}
          onCloseOthers={() => {}}
          onCloseRight={() => {}}
          onActionComplete={() => {}}
          onDismiss={() => setMenu(false)}
        />
      )}
    </>
  );
}

function DragProbe() {
  const ref = useRef<HTMLDivElement>(null);
  const { dialogStyle, dragHandleProps } = useDraggableModal(ref, 'workspace-probe');
  return (
    <div style={{ position: 'fixed', left: 100, top: 120, zIndex: 150 }}>
      <div id="probe-drag-dialog" ref={ref} style={{ ...dialogStyle, width: 300, height: 120 }}>
        <div id="probe-drag-handle" {...dragHandleProps}>
          Drag
        </div>
      </div>
    </div>
  );
}

function Harness() {
  const [epoch, setEpoch] = useState(0);
  const [open, setOpen] = useState(true);
  const [activeTabId, setActiveTabId] = useState('Browser');
  probe.remount = () => setEpoch(value => value + 1);
  probe.toggleOpen = () => setOpen(value => !value);
  return (
    <>
      <div className="bg-background"><WindowHeader /></div>
      <CoworkPet running={false} waiting={false} />
      <WorkspaceNotifications>
        <div id="notice">Notice</div>
      </WorkspaceNotifications>
      <div
        className="cowork-display-host"
        style={{ position: 'relative', width: '100%', height: '100vh' }}
      >
        <CoworkDisplayPanel
          key={epoch}
          activeTabId={activeTabId}
          isOpen={open}
          onClose={() => {}}
          tabs={[
            'Browser',
            'Terminal',
            'agent-team',
            'Swarm Workflow',
            'Future plugin',
            'Plugin 6',
            'Plugin 7',
            'Plugin 8',
          ].map(label => ({
            id: label,
            label,
            icon: null,
            onSelect: () => setActiveTabId(label),
          }))}
        >
          <Tools />
        </CoworkDisplayPanel>
      </div>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Harness />);
