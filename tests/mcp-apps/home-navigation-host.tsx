import { EnginePhase } from '@shared/openclaw/engineStatus';
import React, { createRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';

import { renderCoworkHomeWorkspace } from '@/features/cowork/components/chat/CoworkHomeWorkspace';
import CoworkDisplayPanel from '@/features/cowork/components/display/CoworkDisplayPanel';
import { useMcpAppTabs } from '@/features/cowork/components/display/useMcpAppTabs';
import { useHomeFileApps } from '@/features/cowork/components/mcpApps/useHomeFileApps';
import type { CoworkConfig } from '@/features/cowork/coworkTypes';
import type { McpAppView } from '@/libs/openclaw-chat/components/mcp-app/view';

const fixture = window as unknown as {
  fixturePort: number;
  fixtureBaseline: boolean;
  fixtureReady: boolean;
  fixtureHome: boolean;
  fixtureOpen: () => void;
  fixtureNavigate: (home: boolean) => void;
  fixtureView?: McpAppView;
};
const native = {
  sessionKey: 'agent:main:workspace-preview:fixture',
  gatewaySessionId: 'fixture-incarnation',
  agentId: 'main',
};
window.electron = {
  openclaw: {
    engine: {
      getPort: async () => ({ success: true, port: fixture.fixturePort }),
      getToken: async () => ({ success: true, token: 'isolated-fixture' }),
      getStatus: async () => ({ success: true, status: { phase: EnginePhase.Running } }),
      onProgress: () => () => {},
    },
  },
  mcpApps: {
    prepareWorkspace: async () => ({ success: true, value: native }),
    releaseWorkspace: async () => ({ success: true, value: null }),
  },
  mcp: { onConfigSyncDone: () => () => {} },
  extensions: { onChanged: () => () => {} },
} as unknown as Window['electron'];

const promptInputRef = createRef<never>();
const filePreviewDrawerRefs = { current: new Map() };
const noop = () => {};

function Fixture() {
  const [home, setHome] = useState(true);
  const [activeId, setActiveId] = useState<string | null>(null);
  const homeApps = useHomeFileApps({
    enabled: home,
    cwd: 'E:/fixture-workspace',
    agentId: 'main',
    permissionMode: 'auto',
    addDraft: async () => false,
  });
  const tabs = useMcpAppTabs(home ? '__home__' : 'ordinary-conversation', setActiveId, noop);
  fixture.fixtureHome = home;
  fixture.fixtureReady = homeApps.menu.items.some(item => item.label === 'Fixture editor');
  fixture.fixtureOpen = () => {
    const entry = homeApps.menu.items.find(item => item.label === 'Fixture editor');
    if (!entry) throw new Error('Native global App was not discovered');
    entry.onSelect();
  };
  fixture.fixtureNavigate = value => flushSync(() => setHome(value));
  queueMicrotask(() => {
    fixture.fixtureView = document.querySelector('mcp-app-view') as McpAppView | undefined;
  });

  if (home)
    return renderCoworkHomeWorkspace({
      homeConversationHeader: <div>New conversation</div>,
      mcpAppMenu: homeApps.menu,
      maximumBrowserTabs: 8,
      greetingKey: 'coworkGreetingSupport',
      promptInputRef,
      handleStartSession: async () => false,
      handleStopSession: async () => true,
      isStreaming: false,
      isEngineReady: true,
      config: { workingDirectory: 'E:/fixture-workspace' } as CoworkConfig,
      isDisplayPanelOpen: true,
      hasBrowserPanelOpened: false,
      terminalTabs: [],
      filePreviews: [],
      unsupportedFilePreviews: [],
      recordingReviewTabs: { tabs: [], panels: () => [] },
      mcpAppTabs: tabs,
      hasRetainedRuntimePanels: tabs.hasRetainedPanels,
      activeDisplayTabId: activeId ?? '',
      closeDisplayPanel: noop,
      browserPanelWidth: 680,
      setSessionField: noop,
      displaySessionKey: '__home__',
      homeDisplayTabs: tabs.tabs,
      isWorkspaceFilesOpen: false,
      browserTabs: [],
      handleCreateBrowserTab: noop,
      handleCreateTerminalTab: noop,
      homeWorkspaceFolderPath: '',
      handleOpenWorkspaceFiles: noop,
      terminalWorkingDirectory: '',
      activeFilePreview: undefined,
      activeUnsupportedFilePath: undefined,
      retainedRuntimePanels: [],
      filePreviewDrawerRefs,
      closeFilePreview: async () => true,
      closeUnsupportedFilePreview: noop,
    });

  // The normal conversation keeps the same first App container. Empty React
  // array children matter here: their placement can move a retained iframe.
  return (
    <div className="flex h-full flex-col">
      <div className="cowork-display-host relative flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">Ordinary conversation</div>
        <CoworkDisplayPanel
          key="cowork-display-panel"
          activeTabId=""
          isOpen={false}
          onClose={noop}
          tabs={[]}
          width={680}
        >
          {fixture.fixtureBaseline
            ? [
                false,
                [],
                false,
                [],
                [],
                <div key="mcp-app-panels" className="contents">
                  {tabs.panels(null)}
                </div>,
                false,
                false,
                [],
                [],
                [],
              ]
            : [
                <div key="mcp-app-panels" className="contents">
                  {tabs.panels(null)}
                </div>,
                false,
                [],
                false,
                [],
                [],
                [],
                [],
              ]}
        </CoworkDisplayPanel>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
