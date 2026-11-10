import '@/theme/css/themes.css';

import React, { useLayoutEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { Provider, useSelector } from 'react-redux';

import BrowserPanel from '@/features/browser/BrowserPanel';
import CoworkDisplayPanel from '@/features/cowork/components/display/CoworkDisplayPanel';
import {
  HOME_DISPLAY_SESSION_KEY,
  useSessionDisplayState,
} from '@/features/cowork/components/display/tabs/useSessionDisplayState';
import { coworkService } from '@/features/cowork/coworkService';
import { setCurrentSession } from '@/features/cowork/coworkSlice';
import type { CoworkSession } from '@/features/cowork/coworkTypes';
import { type RootState,store } from '@/store';

const page = { id: 'local-page', targetId: 'local-page', title: 'Local page', url: new URL('guest.html', location.href).href };
const temporary: CoworkSession = {
  id: 'temp-handoff-probe', title: 'Synthetic', status: 'running', pinned: false,
  cwd: '', executionMode: 'local', permissionMode: 'ask', activeSkillIds: [],
  agentId: 'main', createdAt: 1, updatedAt: 1,
};
interface HandoffProbe {
  commits: { sessionKey: string; open: boolean; runtimeId: string }[];
  finished: boolean;
  error: string;
  start?: () => Promise<void>;
}
const probe: HandoffProbe = ((window as unknown as { handoffProbe: HandoffProbe }).handoffProbe = {
  commits: [],
  finished: false,
  error: '',
});

function Harness() {
  const selected = useSelector((state: RootState) => state.cowork.currentSessionId);
  const display = useSessionDisplayState(selected, 520);
  const { sessionKey, state, states, setSessionField } = display;
  const initializedRef = useRef(false);
  useLayoutEffect(() => {
    probe.commits.push({ sessionKey, open: state.isDisplayPanelOpen, runtimeId: state.runtimeId });
  });
  useLayoutEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;
    setSessionField(HOME_DISPLAY_SESSION_KEY, 'hasBrowserPanelOpened', true);
    setSessionField(HOME_DISPLAY_SESSION_KEY, 'isBrowserPanelOpen', true);
    setSessionField(HOME_DISPLAY_SESSION_KEY, 'isDisplayPanelOpen', true);
    setSessionField(HOME_DISPLAY_SESSION_KEY, 'browserTabs', [page]);
    setSessionField(HOME_DISPLAY_SESSION_KEY, 'browserPanelTargetId', page.targetId);
  }, [setSessionField]);
  probe.start = async () => {
    try {
      // The production home boundary groups its local display transfer with Redux selection.
      flushSync(() => {
        display.promote(HOME_DISPLAY_SESSION_KEY, temporary.id);
        store.dispatch(setCurrentSession(temporary));
      });
      const result = await coworkService.startSession(
        { prompt: 'Synthetic admission only', clientTurnId: 'handoff-probe-turn' },
        {
          beforeSessionSelected: session => display.promote(temporary.id, session.id),
          dispatchInitialTurn: async request => ({ runId: request.clientTurnId }),
        },
      );
      if (!result.session) throw new Error(result.error || 'Synthetic admission failed');
    } catch (error) {
      probe.error = error instanceof Error ? error.message : String(error);
    } finally {
      probe.finished = true;
    }
  };
  return (
    <div className="cowork-display-host" style={{ position: 'relative', height: '100vh', width: '100%' }}>
      <CoworkDisplayPanel
        key="cowork-display-panel"
        browserSessionKey={sessionKey}
        activeTabId={`browser:${page.targetId}`}
        isOpen={state.isDisplayPanelOpen}
        width={520}
        onClose={() => {}}
        tabs={[{ id: `browser:${page.targetId}`, label: 'Local page', icon: null, onSelect: () => {} }]}
      >
        <div key="mcp-app-panels" className="contents" />
        <div key="retained-runtime-panels" className="contents">
          {Object.entries(states).filter(([, value]) => value.hasBrowserPanelOpened).map(([key, value]) => (
            <BrowserPanel
              key={`browser-runtime:${value.runtimeId}`}
              draftKey={key}
              embedded
              isOpen={key === sessionKey && state.isDisplayPanelOpen && !key.startsWith('temp-')}
              keepVisible={key === sessionKey && state.isDisplayPanelOpen && key.startsWith('temp-')}
              width={520}
              initialTabs={value.browserTabs}
              retainedTargetIds={value.browserTabs.map(tab => tab.targetId)}
              activeTargetId={value.browserPanelTargetId}
              onActiveTargetChange={target => setSessionField(key, 'browserPanelTargetId', target)}
              onTabsChange={tabs => setSessionField(key, 'browserTabs', tabs)}
              onClose={() => {}}
              onWidthChange={() => {}}
              onAddAnnotation={() => false}
            />
          ))}
        </div>
      </CoworkDisplayPanel>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Provider store={store}><Harness /></Provider>);
