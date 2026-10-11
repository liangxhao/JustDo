// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  readMessages: vi.fn(),
  stopMember: vi.fn(),
  display: vi.fn(),
  instances: [] as Array<{
    state: {
      sessionKey: string;
      connected: boolean;
      currentSessionId: string | null;
      initialHistoryReady: boolean;
      historyWindowStart: number;
      historyHasMore: boolean;
      historyNextCursor: string | null;
      chatMessages: unknown[];
      transcript: {
        activeTurn: {
          runId?: string;
          sessionId?: string;
          sessionKey?: string;
          status?: 'running' | 'final' | 'aborted' | 'error';
        } | null;
      };
      lastError: string | null;
    };
    loadedMessages?: unknown[];
    getLoadedMessages: () => unknown[];
    showOlderHistory: ReturnType<typeof vi.fn>;
    notify: () => void;
    notifyStream: () => void;
    disconnect: ReturnType<typeof vi.fn>;
  }>,
  options: [] as unknown[],
}));
vi.mock('../chat/JustDoChatWrapper', () => ({ connectToGateway: mocks.connect }));
vi.mock('../chat/ChatMessageDisplay', () => ({
  default: (props: unknown) => {
    mocks.display(props);
    return <div>Native messages</div>;
  },
}));
vi.mock('@/libs/openclaw-chat/gateway/chat-controller', () => ({
  ChatController: class {
    state = {
      sessionKey: '',
      connected: true,
      currentSessionId: 'native-peer',
      initialHistoryReady: false,
      historyWindowStart: 0,
      historyHasMore: false,
      historyNextCursor: null as string | null,
      chatMessages: [] as unknown[],
      transcript: {
        activeTurn: null as {
          runId?: string;
          sessionId?: string;
          sessionKey?: string;
          status?: 'running' | 'final' | 'aborted' | 'error';
        } | null,
      },
      lastError: null as string | null,
    };
    showOlderHistory = vi.fn().mockResolvedValue(false);
    loadedMessages?: unknown[];
    getLoadedMessages = () => this.loadedMessages ?? this.state.chatMessages;
    disconnect = vi.fn();
    notify = () => {};
    notifyStream = () => {};
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
    onStream(callback: () => void) {
      this.notifyStream = callback;
      return () => {
        this.notifyStream = () => {};
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
  mocks.stopMember.mockReset().mockResolvedValue({ success: true, value: undefined });
  unsubscribeProgress.mockClear();
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      collaboration: { readMessages: mocks.readMessages, stopMember: mocks.stopMember },
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
  it('shows member Stop when a native execution starts through stream notifications', async () => {
    const view = render(
      <CollaborationMemberHistory
        anchorSessionId="main"
        roomId="room"
        member={member}
        name="Review"
        workingDirectory=""
      />,
    );
    await act(async () => {});
    const controller = mocks.instances[0];
    act(() => {
      controller.state.initialHistoryReady = true;
      controller.notify();
    });
    expect(screen.queryByText(i18nService.t('collaborationWorking'))).toBeNull();
    act(() => {
      controller.state.transcript.activeTurn = {
        status: 'running',
        runId: 'peer-run',
        sessionId: 'native-peer',
        sessionKey: member.sessionKey,
      };
      controller.notifyStream();
    });
    expect(screen.getByText(i18nService.t('collaborationWorking'))).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: i18nService.t('collaborationStopMember') })
        .hasAttribute('disabled'),
    ).toBe(false);

    view.unmount();
    expect(() => controller.notifyStream()).not.toThrow();
  });

  it.each(['final', 'aborted', 'error'] as const)(
    'hides member Stop for a retained %s execution without discarding its messages',
    async status => {
      render(
        <CollaborationMemberHistory
          anchorSessionId="main"
          roomId="room"
          member={member}
          name="Review"
          workingDirectory=""
        />,
      );
      await act(async () => {});
      const controller = mocks.instances[0];
      act(() => {
        controller.state.transcript.activeTurn = {
          status: 'running',
          runId: 'peer-run',
          sessionId: 'native-peer',
          sessionKey: member.sessionKey,
        };
        controller.notify();
      });
      const button = screen.getByRole('button', {
        name: i18nService.t('collaborationStopMember'),
      });
      // A terminal may precede the next render; click-time validation must reject it too.
      controller.state.transcript.activeTurn!.status = status;
      fireEvent.click(button);
      await act(async () => {});
      expect(mocks.stopMember).not.toHaveBeenCalled();
      act(() => controller.notifyStream());
      expect(screen.queryByText(i18nService.t('collaborationWorking'))).toBeNull();
      expect(
        screen.queryByRole('button', { name: i18nService.t('collaborationStopMember') }),
      ).toBeNull();
      expect(controller.state.transcript.activeTurn).not.toBeNull();
      expect(screen.getByText('Native messages')).toBeTruthy();
    },
  );

  it('stops the exact current collaboration member run and keeps native execution authoritative', async () => {
    render(
      <CollaborationMemberHistory
        anchorSessionId="main"
        roomId="room"
        member={member}
        name="Review"
        workingDirectory=""
      />,
    );
    await act(async () => {});
    const controller = mocks.instances[0];
    expect(
      screen.queryByRole('button', { name: i18nService.t('collaborationStopMember') }),
    ).toBeNull();
    act(() => {
      controller.state.transcript.activeTurn = {
        status: 'running',
        runId: 'old-run',
        sessionId: 'native-peer',
        sessionKey: member.sessionKey,
      };
      controller.notify();
    });
    // Resolve identity at click time, even if the previous rendered run has been replaced.
    controller.state.transcript.activeTurn = {
      status: 'running',
      runId: 'current-run',
      sessionId: 'native-peer',
      sessionKey: member.sessionKey,
    };
    fireEvent.click(screen.getByRole('button', { name: i18nService.t('collaborationStopMember') }));
    await act(async () => {});
    expect(mocks.stopMember).toHaveBeenCalledWith({
      sourceSessionId: 'main',
      roomId: 'room',
      targetSessionKey: member.sessionKey,
      nativeSessionId: 'native-peer',
      runId: 'current-run',
    });
    expect(screen.getByText(i18nService.t('collaborationWorking'))).toBeTruthy();
    act(() => {
      controller.state.transcript.activeTurn = null;
      controller.notify();
    });
    expect(
      screen.queryByRole('button', { name: i18nService.t('collaborationStopMember') }),
    ).toBeNull();
  });

  it('does not expose member Stop in group history or historical receipts', async () => {
    const view = mount();
    await act(async () => {});
    act(() => {
      mocks.instances[0].state.transcript.activeTurn = {
        status: 'running',
        runId: 'group-run',
        sessionId: 'native-peer',
        sessionKey: member.sessionKey,
      };
      mocks.instances[0].notify();
    });
    expect(
      screen.queryByRole('button', { name: i18nService.t('collaborationStopMember') }),
    ).toBeNull();
    view.rerender(
      <CollaborationMemberHistory
        anchorSessionId="main"
        roomId="room"
        member={member}
        name="Review"
        workingDirectory=""
        receipt={{ deliveryId: 'delivery', id: 'delivery' }}
      />,
    );
    await act(async () => {});
    expect(
      screen.queryByRole('button', { name: i18nService.t('collaborationStopMember') }),
    ).toBeNull();
    expect(mocks.stopMember).not.toHaveBeenCalled();
  });

  it('does not send an unfenced Stop when current native identity is unavailable', async () => {
    render(
      <CollaborationMemberHistory
        anchorSessionId="main"
        roomId="room"
        member={member}
        name="Review"
        workingDirectory=""
      />,
    );
    await act(async () => {});
    act(() => {
      mocks.instances[0].state.currentSessionId = null;
      mocks.instances[0].state.transcript.activeTurn = {
        status: 'running',
        runId: 'run',
        sessionKey: member.sessionKey,
      };
      mocks.instances[0].notify();
    });
    const button = screen.getByRole('button', { name: i18nService.t('collaborationStopMember') });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(button);
    await act(async () => {});
    expect(mocks.stopMember).not.toHaveBeenCalled();
  });

  it('disables Stop when a live member loses its native connection', async () => {
    render(
      <CollaborationMemberHistory
        anchorSessionId="main"
        roomId="room"
        member={member}
        name="Review"
        workingDirectory=""
      />,
    );
    await act(async () => {});
    const controller = mocks.instances[0];
    act(() => {
      controller.state.transcript.activeTurn = {
        status: 'running',
        runId: 'run',
        sessionId: 'native-peer',
        sessionKey: member.sessionKey,
      };
      controller.notify();
    });
    const button = screen.getByRole('button', { name: i18nService.t('collaborationStopMember') });
    expect(button.hasAttribute('disabled')).toBe(false);
    act(() => {
      controller.state.connected = false;
      controller.notify();
    });
    expect(button.hasAttribute('disabled')).toBe(true);
    fireEvent.click(button);
    expect(mocks.stopMember).not.toHaveBeenCalled();
  });

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
      controller.state.transcript.activeTurn = { status: 'running' };
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
