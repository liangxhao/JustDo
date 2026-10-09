// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import SwarmWorkflowNodeHistory from './SwarmWorkflowNodeHistory';

const native = vi.hoisted(() => {
  class Controller {
    state = {
      sessionKey: '',
      chatMessages: [] as string[],
      transcript: { activeTurn: null as { text: string } | null },
      initialHistoryReady: false,
      lastError: null as string | null,
    };
    listeners = new Set<(state: Controller['state']) => void>();
    disconnect = vi.fn();
    constructor() {
      instances.push(this);
    }
    subscribe(listener: (state: Controller['state']) => void) {
      this.listeners.add(listener);
      return () => {
        this.listeners.delete(listener);
      };
    }
    publish(update: Partial<Controller['state']>) {
      Object.assign(this.state, update);
      this.listeners.forEach(listener => listener(this.state));
    }
  }
  const instances: Controller[] = [];
  return { Controller, instances, connect: vi.fn(async (_controller: Controller) => true) };
});
vi.mock('@/libs/openclaw-chat/gateway/chat-controller', () => ({
  ChatController: native.Controller,
}));
vi.mock('../chat/JustDoChatWrapper', () => ({ connectToGateway: native.connect }));
vi.mock('../chat/ChatMessageDisplay', async () => {
  const { useEffect, useState } = await import('react');
  return {
    default: function MessageDisplay({
      controller,
    }: {
      controller: InstanceType<typeof native.Controller> | null;
    }) {
      const [, refresh] = useState(0);
      useEffect(() => controller?.subscribe(() => refresh(value => value + 1)), [controller]);
      return (
        <div data-testid="native-messages" data-session={controller?.state.sessionKey}>
          {controller?.state.chatMessages.join('\n')}
          {controller?.state.transcript.activeTurn?.text}
        </div>
      );
    },
  };
});

const props = {
  sessionKey: 'agent:reviewer:subagent:swarm-workflow-first',
  workingDirectory: '/project',
  agentId: 'reviewer',
  name: 'Reviewer',
};
const progressListeners = new Set<(engine: { phase: string }) => void>();
beforeEach(() => {
  vi.useFakeTimers();
  native.instances.length = 0;
  native.connect.mockReset().mockResolvedValue(true);
  progressListeners.clear();
  i18nService.setLanguage('en', { persist: false });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      openclaw: {
        engine: {
          onProgress: (listener: (engine: { phase: string }) => void) => {
            progressListeners.add(listener);
            return () => progressListeners.delete(listener);
          },
        },
      },
    },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

test('selects the node native session and displays history followed by live content', async () => {
  render(<SwarmWorkflowNodeHistory {...props} />);
  await act(async () => {});
  const controller = native.instances[0];
  expect(native.connect).toHaveBeenCalledWith(controller);
  expect(controller.state.sessionKey).toBe(props.sessionKey);
  expect(screen.getByRole('status').textContent).toBe('Loading execution history…');

  act(() => controller.publish({ initialHistoryReady: true, chatMessages: ['Saved result'] }));
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByTestId('native-messages').textContent).toBe('Saved result');
  act(() => controller.publish({ transcript: { activeTurn: { text: 'Live tool activity' } } }));
  expect(screen.getByTestId('native-messages').textContent).toContain('Live tool activity');
});

test('releases native and engine subscriptions and pending timers when closed', async () => {
  const view = render(<SwarmWorkflowNodeHistory {...props} />);
  await act(async () => {});
  const controller = native.instances[0];
  expect(controller.listeners.size).toBeGreaterThan(0);
  expect(progressListeners.size).toBe(1);

  view.unmount();
  expect(controller.listeners.size).toBe(0);
  expect(controller.disconnect).toHaveBeenCalled();
  expect(progressListeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(native.connect).toHaveBeenCalledTimes(1);
});

test('retries a history failure with a fresh controller and ignores the old stream', async () => {
  render(<SwarmWorkflowNodeHistory {...props} />);
  await act(async () => {});
  const failed = native.instances[0];
  act(() => failed.publish({ initialHistoryReady: true, lastError: 'Unavailable' }));
  expect(screen.getByRole('status').textContent).toBe('History is unavailable. Please retry.');

  fireEvent.click(screen.getByRole('button', { name: i18nService.t('sessionDetailsRetry') }));
  await act(async () => {});
  const replacement = native.instances[1];
  expect(failed.disconnect).toHaveBeenCalled();
  expect(failed.listeners.size).toBe(0);
  expect(replacement.state.sessionKey).toBe(props.sessionKey);
  expect(native.connect).toHaveBeenLastCalledWith(replacement);
  act(() => failed.publish({ chatMessages: ['Stale response'] }));
  expect(screen.queryByText('Stale response')).toBeNull();
  act(() => replacement.publish({ initialHistoryReady: true, chatMessages: ['Recovered'] }));
  expect(screen.getByTestId('native-messages').textContent).toBe('Recovered');
  expect(screen.queryByRole('status')).toBeNull();
});

test('clears the previous node history on session changes and reports an empty native session', async () => {
  const view = render(<SwarmWorkflowNodeHistory {...props} />);
  await act(async () => {});
  const first = native.instances[0];
  act(() => first.publish({ initialHistoryReady: true, chatMessages: ['First node'] }));

  const nextKey = 'agent:reviewer:subagent:swarm-workflow-second';
  view.rerender(<SwarmWorkflowNodeHistory {...props} sessionKey={nextKey} />);
  await act(async () => {});
  const second = native.instances[1];
  expect(first.disconnect).toHaveBeenCalled();
  expect(first.listeners.size).toBe(0);
  expect(screen.queryByText('First node')).toBeNull();
  expect(screen.getByTestId('native-messages').getAttribute('data-session')).toBe(nextKey);
  act(() => second.publish({ initialHistoryReady: true }));
  expect(screen.getByRole('status').textContent).toBe('No execution history yet.');
});

test('reports an initial history timeout and cancels the timeout after leaving the view', async () => {
  const view = render(<SwarmWorkflowNodeHistory {...props} />);
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(screen.getByRole('status').textContent).toBe('History is unavailable. Please retry.');
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});
