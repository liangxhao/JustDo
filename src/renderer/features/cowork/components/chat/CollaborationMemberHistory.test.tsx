// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  readMessages: vi.fn(),
  display: vi.fn(),
  instances: [] as Array<{
    state: {
      sessionKey: string;
      initialHistoryReady: boolean;
      historyWindowStart: number;
      historyHasMore: boolean;
      historyNextCursor: string | null;
      chatMessages: unknown[];
      transcript: { activeTurn: object | null };
      lastError: string | null;
    };
    loadedMessages?: unknown[];
    getLoadedMessages: () => unknown[];
    showOlderHistory: ReturnType<typeof vi.fn>;
    notify: () => void;
    disconnect: ReturnType<typeof vi.fn>;
  }>,
  options: [] as unknown[],
}));
vi.mock('./JustDoChatWrapper', () => ({ connectToGateway: mocks.connect }));
vi.mock('./ChatMessageDisplay', () => ({
  default: (props: unknown) => {
    mocks.display(props);
    return <div>Native messages</div>;
  },
}));
vi.mock('@/libs/openclaw-chat/gateway/chat-controller', () => ({
  ChatController: class {
    state = {
      sessionKey: '',
      initialHistoryReady: false,
      historyWindowStart: 0,
      historyHasMore: false,
      historyNextCursor: null as string | null,
      chatMessages: [] as unknown[],
      transcript: { activeTurn: null as object | null },
      lastError: null as string | null,
    };
    showOlderHistory = vi.fn().mockResolvedValue(false);
    loadedMessages?: unknown[];
    getLoadedMessages = () => this.loadedMessages ?? this.state.chatMessages;
    disconnect = vi.fn();
    notify = () => {};
    constructor(options?: unknown) {
      mocks.options.push(options);
      mocks.instances.push(this);
    }
    subscribe(callback: (state: typeof this.state) => void) {
      this.notify = () => callback(this.state);
      return () => {
        this.notify = () => {};
      };
    }
  },
}));
import CollaborationMemberHistory from './CollaborationMemberHistory';
const member = { agentId: 'review', sessionId: 'peer', sessionKey: 'agent:review:justdo:peer' };
let progress: ((status: { phase: string }) => void) | undefined;
const unsubscribeProgress = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  mocks.instances.length = 0;
  mocks.options.length = 0;
  mocks.connect.mockReset().mockResolvedValue(true);
  mocks.readMessages.mockReset().mockResolvedValue({ success: true, value: [] });
  unsubscribeProgress.mockClear();
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      collaboration: { readMessages: mocks.readMessages },
      openclaw: {
        engine: {
          onProgress: (callback: typeof progress) => {
            progress = callback;
            return unsubscribeProgress;
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
const mount = () =>
  render(
    <CollaborationMemberHistory
      anchorSessionId="main"
      member={member}
      name="Review"
      workingDirectory=""
      peerNames={{ main: 'Main', writer: 'Writer' }}
    />,
  );

describe('peer native history lifecycle', () => {
  it.each(['failed', 'missing'] as const)(
    'retries a %s receipt without changing the selected member',
    async failure => {
      mocks.readMessages
        .mockResolvedValueOnce(
          failure === 'failed'
            ? { success: false, error: 'offline' }
            : { success: true, value: [] },
        )
        .mockResolvedValue({
          success: true,
          value: [
            { deliveryId: 'delivery', message: { role: 'user', content: 'Recovered receipt' } },
          ],
        });
      render(
        <CollaborationMemberHistory
          anchorSessionId="main"
          member={member}
          name="Review"
          workingDirectory=""
          receipt={{ deliveryId: 'delivery', id: 'delivery' }}
        />,
      );
      await act(async () => {});
      expect(mocks.readMessages).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole('button', { name: i18nService.t('sessionDetailsRetry') }));
      await act(async () => {});
      expect(mocks.readMessages).toHaveBeenCalledTimes(2);
      expect(mocks.readMessages).toHaveBeenLastCalledWith('main', ['delivery']);
      expect(mocks.display).toHaveBeenLastCalledWith(
        expect.objectContaining({
          gatewayMessages: [{ role: 'user', content: 'Recovered receipt' }],
        }),
      );
      expect(
        screen.queryByRole('button', { name: i18nService.t('sessionDetailsRetry') }),
      ).toBeNull();
      expect(mocks.instances).toHaveLength(0);
    },
  );

  it('loads an exact receipt through the collaboration message lookup', async () => {
    const expected = { role: 'user', content: 'Actual message' };
    mocks.readMessages.mockResolvedValue({
      success: true,
      value: [{ deliveryId: 'delivery', message: expected }],
    });
    render(
      <CollaborationMemberHistory
        anchorSessionId="main"
        member={member}
        name="Review"
        workingDirectory=""
        receipt={{
          deliveryId: 'delivery',
          id: 'delivery',
        }}
      />,
    );
    await act(async () => {});
    expect(mocks.readMessages).toHaveBeenCalledWith('main', ['delivery']);
    expect(mocks.instances).toHaveLength(0);
    expect(mocks.display).toHaveBeenLastCalledWith(
      expect.objectContaining({ controller: null, gatewayMessages: [expected] }),
    );
  });

  it('reports an exact receipt lookup failure', async () => {
    mocks.readMessages.mockResolvedValue({ success: false, error: 'unavailable' });
    render(
      <CollaborationMemberHistory
        anchorSessionId="main"
        member={member}
        name="Review"
        workingDirectory=""
        receipt={{
          deliveryId: 'old',
          id: 'old',
        }}
      />,
    );
    await act(async () => {});
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(mocks.instances).toHaveLength(0);
  });
  it('loads ordinary session history and keeps execution errors separate from loading errors', async () => {
    mount();
    await act(async () => {});
    expect(mocks.options).toEqual([undefined]);
    const controller = mocks.instances[0];
    act(() => {
      controller.state.initialHistoryReady = true;
      controller.state.chatMessages = [{ role: 'assistant', content: 'Result' }];
      controller.state.lastError = 'Model request failed';
      controller.notify();
    });
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => {
      controller.state.chatMessages = [];
      controller.state.initialHistoryReady = false;
      controller.state.transcript.activeTurn = {};
      controller.notify();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(i18nService.t('collaborationWorking'))).toBeTruthy();
    expect(mocks.display).toHaveBeenLastCalledWith(
      expect.objectContaining({ peerNames: { main: 'Main', writer: 'Writer' } }),
    );
  });

  it('bounds cold-start retries, retries on Gateway running, and cleans up subscriptions', async () => {
    mocks.connect.mockResolvedValue(false);
    const view = mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7000);
    });
    expect(mocks.connect).toHaveBeenCalledTimes(4);
    expect(screen.getByRole('alert')).toBeTruthy();
    mocks.connect.mockResolvedValue(true);
    await act(async () => {
      progress?.({ phase: 'running' });
    });
    expect(mocks.connect).toHaveBeenCalledTimes(5);
    await act(async () => {
      progress?.({ phase: 'running' });
    });
    expect(mocks.connect).toHaveBeenCalledTimes(5);
    view.unmount();
    expect(unsubscribeProgress).toHaveBeenCalledOnce();
    expect(mocks.instances[0].disconnect).toHaveBeenCalled();
  });

  it('starts a fresh history deadline when a cold Gateway becomes running after timeout', async () => {
    mocks.connect.mockResolvedValue(false);
    mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16000);
    });
    expect(screen.getByRole('alert')).toBeTruthy();
    mocks.connect.mockResolvedValue(true);
    await act(async () => {
      progress?.({ phase: 'running' });
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status')).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14999);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('refreshes connection endpoints after a Gateway restart but ignores repeated running events', async () => {
    mount();
    await act(async () => {});
    await act(async () => {
      progress?.({ phase: 'running' });
    });
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    await act(async () => {
      progress?.({ phase: 'starting' });
      progress?.({ phase: 'running' });
    });
    expect(mocks.instances[0].disconnect).toHaveBeenCalledOnce();
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    await act(async () => {
      progress?.({ phase: 'running' });
    });
    expect(mocks.connect).toHaveBeenCalledTimes(2);
  });

  it('serializes a changed endpoint behind an old in-flight connection', async () => {
    let finish: (value: boolean) => void = () => {};
    mocks.connect.mockReturnValueOnce(
      new Promise<boolean>(resolve => {
        finish = resolve;
      }),
    );
    mount();
    await act(async () => {
      progress?.({ phase: 'starting' });
      progress?.({ phase: 'running' });
      progress?.({ phase: 'running' });
    });
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish(true);
    });
    expect(mocks.instances[0].disconnect).toHaveBeenCalledOnce();
    expect(mocks.connect).toHaveBeenCalledTimes(2);
  });

  it('disconnects a late connection after the member panel is closed', async () => {
    let finish: (value: boolean) => void = () => {};
    mocks.connect.mockReturnValue(
      new Promise<boolean>(resolve => {
        finish = resolve;
      }),
    );
    const view = mount();
    view.unmount();
    await act(async () => {
      finish(true);
    });
    expect(mocks.instances[0].disconnect).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(mocks.connect).toHaveBeenCalledOnce();
  });
});
