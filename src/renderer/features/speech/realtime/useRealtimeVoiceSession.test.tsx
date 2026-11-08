// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configService } from '@/services/config';

import type { RealtimeVoiceViewState } from './realtimeVoiceController';
import { useRealtimeVoiceSession } from './useRealtimeVoiceSession';

interface FakeController {
  start: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  setSpeakerMuted: ReturnType<typeof vi.fn>;
  setMicrophoneMuted: ReturnType<typeof vi.fn>;
  publish(patch: Partial<RealtimeVoiceViewState>): void;
}
const fixture = vi.hoisted(() => ({
  instances: [] as FakeController[],
  progress: undefined as ((value: { phase: string }) => void) | undefined,
}));
vi.mock('./realtimeVoiceController', () => ({
  RealtimeVoiceController: class {
    private state: RealtimeVoiceViewState = {
      phase: 'idle',
      activity: 'listening',
      microphoneMuted: false,
      speakerMuted: false,
      userCaption: '',
      assistantCaption: '',
    };
    constructor(
      _bridge: unknown,
      private changed: (state: RealtimeVoiceViewState) => void,
    ) {
      fixture.instances.push(this);
    }
    publish(patch: Partial<RealtimeVoiceViewState>) {
      this.state = { ...this.state, ...patch };
      this.changed(this.state);
    }
    start = vi.fn(async () => {
      this.publish({ phase: 'active' });
    });
    end = vi.fn(async () => {
      this.publish({ phase: 'idle' });
    });
    dispose = vi.fn();
    setSpeakerMuted = vi.fn((muted: boolean) => this.publish({ speakerMuted: muted }));
    setMicrophoneMuted = vi.fn((muted: boolean) => this.publish({ microphoneMuted: muted }));
  },
}));

describe('composer realtime media owner', () => {
  let config: ReturnType<typeof configService.getConfig>;
  const status = vi.fn();
  const props = { sessionId: 'session-a', allowRealtime: true, startDisabled: false };
  beforeEach(() => {
    fixture.instances.length = 0;
    fixture.progress = undefined;
    config = {
      ...configService.getConfig(),
      voice: { realtimeEnabled: true, inputDeviceId: 'mic-one' },
    };
    vi.spyOn(configService, 'getConfig').mockImplementation(() => config);
    status.mockReset().mockResolvedValue({ available: true });
    vi.stubGlobal('electron', {
      realtimeVoice: { getStatus: status },
      openclaw: {
        engine: {
          onProgress: (listener: typeof fixture.progress) => {
            fixture.progress = listener;
            return vi.fn();
          },
        },
      },
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('keeps an active call and its controls when task activity disables new starts', async () => {
    const hook = renderHook(value => useRealtimeVoiceSession(value), { initialProps: props });
    await waitFor(() => expect(hook.result.current.checking).toBe(false));
    act(() => hook.result.current.start());
    expect(hook.result.current.view.phase).toBe('active');
    hook.rerender({ ...props, startDisabled: true });
    act(() => hook.result.current.toggleSpeaker());
    expect(fixture.instances).toHaveLength(1);
    expect(fixture.instances[0].start).toHaveBeenCalledWith('session-a', 'mic-one');
    expect(fixture.instances[0].end).not.toHaveBeenCalled();
    expect(fixture.instances[0].dispose).not.toHaveBeenCalled();
    expect(hook.result.current.view.speakerMuted).toBe(true);
  });

  it('releases the old owner on chat identity change and ignores its late readiness result', async () => {
    let finish!: (value: { available: boolean; model: string }) => void;
    status
      .mockReturnValueOnce(
        new Promise(resolve => {
          finish = resolve;
        }),
      )
      .mockResolvedValue({ available: true, model: 'new-model' });
    const hook = renderHook(value => useRealtimeVoiceSession(value), { initialProps: props });
    const old = fixture.instances[0];
    hook.rerender({ ...props, sessionId: 'session-b' });
    await waitFor(() => expect(hook.result.current.status.model).toBe('new-model'));
    await act(async () => finish({ available: false, model: 'old-model' }));
    expect(old.dispose).toHaveBeenCalledOnce();
    expect(hook.result.current.status.model).toBe('new-model');
    hook.unmount();
    expect(fixture.instances[1].dispose).toHaveBeenCalledOnce();
  });

  it('stops media when the chat surface is hidden without automatically starting again', async () => {
    const hook = renderHook(() => useRealtimeVoiceSession(props));
    await waitFor(() => expect(hook.result.current.checking).toBe(false));
    act(() => hook.result.current.start());
    act(() => window.dispatchEvent(new Event('speech-surface:hidden')));
    expect(fixture.instances[0].end).toHaveBeenCalledOnce();
    expect(hook.result.current.engaged).toBe(false);
    expect(fixture.instances[0].start).toHaveBeenCalledOnce();
  });

  it('stops active media for an engine outage and for an effective configuration change', async () => {
    const hook = renderHook(() => useRealtimeVoiceSession(props));
    await waitFor(() => expect(hook.result.current.checking).toBe(false));
    act(() => hook.result.current.start());
    act(() => fixture.progress?.({ phase: 'starting' }));
    expect(fixture.instances[0].end).toHaveBeenCalledOnce();
    expect(hook.result.current.status.reason).toBe('gateway-unavailable');
    config = { ...config, voice: { ...config.voice, inputDeviceId: 'mic-two' } };
    await act(async () => window.dispatchEvent(new Event('config-updated')));
    expect(fixture.instances[0].end).toHaveBeenCalledTimes(2);
    expect(fixture.instances[0].start).toHaveBeenCalledOnce();
  });

  it('keeps an unknown creation outcome visible and never retries when checking status', async () => {
    const hook = renderHook(() => useRealtimeVoiceSession(props));
    await waitFor(() => expect(hook.result.current.checking).toBe(false));
    act(() => {
      hook.result.current.start();
      fixture.instances[0].publish({ phase: 'unknown' });
    });
    status.mockResolvedValue({ available: false, reason: 'unknown' });
    await act(async () => hook.result.current.refresh());
    expect(hook.result.current.view.phase).toBe('unknown');
    expect(hook.result.current.engaged).toBe(true);
    expect(fixture.instances[0].start).toHaveBeenCalledOnce();
    await act(async () => hook.result.current.end());
    expect(hook.result.current.engaged).toBe(false);
  });

  it('creates no media owner for a side chat or an unpersisted product session', () => {
    const hook = renderHook(value => useRealtimeVoiceSession(value), {
      initialProps: { ...props, allowRealtime: false },
    });
    expect(fixture.instances).toHaveLength(0);
    hook.rerender({ ...props, sessionId: 'temp-creating' });
    expect(fixture.instances).toHaveLength(0);
    expect(status).not.toHaveBeenCalled();
  });
});
