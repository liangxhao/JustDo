// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import NativeSessionHistory from './NativeSessionHistory';

const fixture = vi.hoisted(() => ({
  notify: () => {},
  loadHistory: vi.fn(),
  constructed: 0,
  state: {
    connected: true,
    sessionKey: 'native-peer',
    currentSessionId: 'native-id',
    initialHistoryReady: false,
    historyReadFailed: false,
    historyPreparationPending: false,
    historyPreparationTimedOut: false,
    chatSending: false,
    chatLoading: false,
    chatMessages: [] as unknown[],
    transcript: { activeTurn: null },
    lastError: null,
  },
}));
vi.mock('@/libs/openclaw-chat/gateway/chat-controller', () => ({
  ChatController: class {
    state = fixture.state;
    loadHistory = fixture.loadHistory;
    constructor() {
      fixture.constructed += 1;
    }
    subscribe(update: () => void) {
      fixture.notify = update;
      return () => {};
    }
    onStream() {
      return () => {};
    }
    hasUnconfirmedQueuedInput() {
      return false;
    }
  },
}));
vi.mock('../shared/subagentGatewayConnection', () => ({
  startSubagentGatewayConnection: ({ onConnecting }: { onConnecting(): void }) => {
    onConnecting();
    return () => {};
  },
}));
vi.mock('./JustDoChatWrapper', () => ({ connectToGateway: vi.fn() }));
vi.mock('./ChatMessageDisplay', () => ({ default: () => null }));
vi.mock('../subagents/SessionSubtaskButton', () => ({
  default: () => <button>Native subtasks</button>,
}));
vi.mock('@/features/cowork/coworkService', () => ({ coworkService: {} }));
vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('keeps preparation outside the history deadline and retries the same controller with send admission closed', () => {
  vi.useFakeTimers();
  const onState = vi.fn();
  const props = {
    sessionKey: 'native-peer',
    name: 'Peer',
    workingDirectory: 'project',
    labels: { loading: 'loading', empty: 'empty', error: 'error', retry: 'retry' },
    onState,
    onOpenSubtask: vi.fn(),
    productSessionId: 'product-peer',
  };
  const view = render(<NativeSessionHistory {...props} showSubtaskAction={false} />);
  expect(screen.queryByRole('button', { name: 'Native subtasks' })).toBeNull();
  act(() => {
    fixture.state.historyPreparationPending = true;
    fixture.state.historyPreparationTimedOut = true;
    fixture.notify();
  });
  expect(screen.getByRole('status').textContent).toBe('storageHistoryPreparing');
  expect(onState.mock.lastCall?.[0].ready).toBe(false);
  act(() => {
    vi.advanceTimersByTime(15000);
  });
  expect(screen.getByRole('status').textContent).toBe('storageHistoryPreparing');
  act(() => {
    fixture.state.initialHistoryReady = true;
    fixture.notify();
  });
  expect(onState.mock.lastCall?.[0].ready).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'retry' }));
  expect(fixture.loadHistory).toHaveBeenCalledExactlyOnceWith(true);
  expect(fixture.constructed).toBe(1);
  act(() => {
    fixture.state.historyPreparationPending = false;
    fixture.state.historyPreparationTimedOut = false;
    fixture.notify();
  });
  expect(screen.getByRole('status').textContent).toBe('empty');
  expect(onState.mock.lastCall?.[0].ready).toBe(true);
  view.rerender(<NativeSessionHistory {...props} />);
  expect(screen.getByRole('button', { name: 'Native subtasks' })).toBeTruthy();
  expect(fixture.constructed).toBe(1);
});
