// @vitest-environment jsdom

import type {
  NativeSessionDispatchRequest,
  NativeSessionDispatchResponse,
} from '@shared/cowork/nativeSessionDispatch';
import { useLayoutEffect } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, useSelector } from 'react-redux';
import { afterEach, expect, it, vi } from 'vitest';

import { type RootState, store } from '@/store';

import { useSessionDisplayState } from './components/display/tabs/useSessionDisplayState';
import { CoworkService } from './coworkService';
import { clearCurrentSession, deleteSession, setCurrentSession } from './coworkSlice';
import type { CoworkSession } from './coworkTypes';

const temporary: CoworkSession = {
  id: 'temp-promotion-visibility',
  title: 'Synthetic',
  status: 'running',
  pinned: false,
  cwd: '',
  executionMode: 'local',
  permissionMode: 'ask',
  activeSkillIds: [],
  agentId: 'main',
  createdAt: 1,
  updatedAt: 1,
};
const canonical: CoworkSession = {
  ...temporary,
  id: 'canonical-promotion-visibility',
  nativeSessionKey: 'agent:main:promotion-visibility',
};

type VisibilityCommit = { selectedId: string | null; open: boolean; runtimeId: string };
const originalElectron = Object.getOwnPropertyDescriptor(window, 'electron');
let root: Root | undefined;
let host: HTMLDivElement | undefined;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

async function mountWorkspace() {
  store.dispatch(setCurrentSession(temporary));
  let display!: ReturnType<typeof useSessionDisplayState>;
  const commits: VisibilityCommit[] = [];
  function Workspace() {
    const selectedId = useSelector((state: RootState) => state.cowork.currentSessionId);
    display = useSessionDisplayState(selectedId, 520);
    useLayoutEffect(() => {
      commits.push({
        selectedId,
        open: display.state.isDisplayPanelOpen,
        runtimeId: display.state.runtimeId,
      });
    });
    return <aside data-open={display.state.isDisplayPanelOpen} />;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  flushSync(() => root!.render(<Provider store={store}><Workspace /></Provider>));
  flushSync(() => display.openBrowserTab(temporary.id, {
    id: 'live-page',
    targetId: 'live-page',
    title: 'Page with unsaved input',
    url: 'https://example.com',
  }, 20));
  await vi.waitFor(() => expect(display.state.isDisplayPanelOpen).toBe(true));
  const originalRuntime = display.state.runtimeId;
  commits.length = 0;
  const beforeSessionSelected = vi.fn((session: CoworkSession) => {
    display.promote(temporary.id, session.id);
  });
  return {
    beforeSessionSelected,
    async expectContinuousVisibility() {
      await vi.waitFor(() => {
        expect(display.sessionKey).toBe(canonical.id);
        expect(display.state.isDisplayPanelOpen).toBe(true);
        expect(display.state.runtimeId).toBe(originalRuntime);
      });
      expect(commits.length).toBeGreaterThan(0);
      expect(commits.every(commit => commit.open)).toBe(true);
      expect(new Set(commits.map(commit => commit.runtimeId))).toEqual(new Set([originalRuntime]));
    },
  };
}

afterEach(() => {
  root?.unmount();
  root = undefined;
  host?.remove();
  host = undefined;
  store.dispatch(clearCurrentSession());
  store.dispatch(deleteSession(canonical.id));
  if (originalElectron) Object.defineProperty(window, 'electron', originalElectron);
  else Reflect.deleteProperty(window, 'electron');
});

it('keeps every committed workspace visible during asynchronous native session handoff', async () => {
  const nativeResult = deferred<{ success: boolean; session: CoworkSession }>();
  let listener!: (request: NativeSessionDispatchRequest) => void;
  const respond = vi.fn(async (_response: NativeSessionDispatchResponse) => {
    nativeResult.resolve({ success: true, session: canonical });
  });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      cowork: {
        startSession: vi.fn(() => nativeResult.promise),
        getSession: vi.fn().mockResolvedValue({ success: true, session: canonical }),
        onNativeSessionDispatch: (next: typeof listener) => { listener = next; return vi.fn(); },
        respondNativeSessionDispatch: respond,
      },
    },
  });
  const workspace = await mountWorkspace();
  const service = new CoworkService();
  const dispatchInitialTurn = vi.fn().mockResolvedValue({ runId: 'visibility-turn' });
  // Keep the external-store selection and queued local-state promotion on their
  // real scheduling lanes rather than batching the asynchronous boundary in act.
  const pending = service.startSession(
    { prompt: 'Synthetic', clientTurnId: 'visibility-turn' },
    { beforeSessionSelected: workspace.beforeSessionSelected, dispatchInitialTurn },
  );
  listener({
    requestId: 'visibility-request',
    clientTurnId: 'visibility-turn',
    sessionId: canonical.id,
    sessionKey: canonical.nativeSessionKey!,
    params: {
      sessionKey: canonical.nativeSessionKey!,
      idempotencyKey: 'visibility-turn',
      message: 'Synthetic',
    },
  });
  await expect(pending).resolves.toMatchObject({ session: { id: canonical.id } });

  await workspace.expectContinuousVisibility();
  expect(workspace.beforeSessionSelected).toHaveBeenCalledOnce();
  expect(dispatchInitialTurn).toHaveBeenCalledOnce();
  expect(respond).toHaveBeenCalledOnce();
});

it.each([
  { label: 'normal first send', appWorkspaceRequestId: undefined },
  { label: 'workspace App adoption', appWorkspaceRequestId: 'workspace-adoption' },
])('keeps every committed workspace visible during $label', async ({ appWorkspaceRequestId }) => {
  const result = deferred<{ success: boolean; session: CoworkSession }>();
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: { cowork: { startSession: vi.fn(() => result.promise) } },
  });
  const workspace = await mountWorkspace();
  const service = new CoworkService();
  const pending = service.startSession(
    { prompt: 'Synthetic', appWorkspaceRequestId },
    { beforeSessionSelected: workspace.beforeSessionSelected },
  );
  result.resolve({ success: true, session: canonical });
  await expect(pending).resolves.toMatchObject({ session: { id: canonical.id } });

  await workspace.expectContinuousVisibility();
  expect(workspace.beforeSessionSelected).toHaveBeenCalledOnce();
});
