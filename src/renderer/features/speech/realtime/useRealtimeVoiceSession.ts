import { EnginePhase } from '@shared/openclaw/engineStatus';
import { normalizeLocalSpeechSettings } from '@shared/speech/localSpeechSettings';
import type { RealtimeVoiceStatus } from '@shared/speech/realtimeVoice';
import { SPEECH_SURFACE_HIDDEN_EVENT } from '@shared/speech/speechSettingsNavigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { configService } from '@/services/config';

import { getRealtimeVoiceConfigurationKey } from './realtimeVoiceConfiguration';
import { RealtimeVoiceController, type RealtimeVoiceViewState } from './realtimeVoiceController';

const initialView = (): RealtimeVoiceViewState => ({
  phase: 'idle',
  activity: 'listening',
  microphoneMuted: false,
  speakerMuted: false,
  userCaption: '',
  assistantCaption: '',
});
const mediaPhases = new Set<RealtimeVoiceViewState['phase']>([
  'starting',
  'connecting',
  'active',
  'ending',
]);
const readSettings = () => normalizeLocalSpeechSettings(configService.getConfig().voice);
interface Owner {
  controller: RealtimeVoiceController;
  sessionId: string;
}
interface Options {
  sessionId?: string;
  allowRealtime: boolean;
  startDisabled: boolean;
}

/** One media owner per composer, outside its interchangeable toolbar layouts. */
export function useRealtimeVoiceSession({ sessionId, allowRealtime, startDisabled }: Options) {
  const [enabled, setEnabled] = useState(() => readSettings().realtimeEnabled);
  const [view, setView] = useState(initialView);
  const [status, setStatus] = useState<RealtimeVoiceStatus>({ available: false });
  const [checking, setChecking] = useState(false);
  const [presented, setPresented] = useState(false);
  const owner = useRef<Owner>();
  const generation = useRef(0);
  const viewRef = useRef(view);
  const sessionAllowed = Boolean(sessionId && !sessionId.startsWith('temp-') && allowRealtime);

  const refresh = useCallback(async () => {
    const current = owner.current;
    const bridge = window.electron?.realtimeVoice;
    if (!current || !bridge) return;
    const ticket = ++generation.current;
    setChecking(true);
    try {
      const next = await bridge.getStatus();
      if (owner.current === current && ticket === generation.current) setStatus(next);
    } catch {
      if (owner.current === current && ticket === generation.current)
        setStatus({ available: false, reason: 'gateway-unavailable' });
    } finally {
      if (owner.current === current && ticket === generation.current) setChecking(false);
    }
  }, []);

  useEffect(() => {
    const changed = () => setEnabled(readSettings().realtimeEnabled);
    window.addEventListener('config-updated', changed);
    return () => window.removeEventListener('config-updated', changed);
  }, []);

  useEffect(() => {
    const reset = initialView();
    viewRef.current = reset;
    setView(reset);
    setPresented(false);
    setChecking(false);
    setStatus({ available: false });
    const bridge = window.electron?.realtimeVoice;
    if (!sessionAllowed || !sessionId || !enabled || !bridge) return;
    const instance = new RealtimeVoiceController(bridge, state => {
      if (owner.current?.controller !== instance) return;
      viewRef.current = state;
      setView(state);
    });
    const current: Owner = { controller: instance, sessionId };
    owner.current = current;
    let configurationKey = getRealtimeVoiceConfigurationKey(configService.getConfig());
    const configChanged = () => {
      const nextKey = getRealtimeVoiceConfigurationKey(configService.getConfig());
      if (nextKey !== configurationKey) {
        configurationKey = nextKey;
        void instance.end().then(() => {
          if (owner.current === current) void refresh();
        });
      } else void refresh();
    };
    const hidden = () => {
      setPresented(false);
      void instance.end();
    };
    const unsubscribeEngine = window.electron.openclaw?.engine?.onProgress(progress => {
      if (owner.current !== current) return;
      if (progress.phase === EnginePhase.Running) void refresh();
      else {
        generation.current += 1;
        setChecking(false);
        setStatus({ available: false, reason: 'gateway-unavailable' });
        void instance.end();
      }
    });
    window.addEventListener('config-updated', configChanged);
    window.addEventListener(SPEECH_SURFACE_HIDDEN_EVENT, hidden);
    void refresh();
    return () => {
      generation.current += 1;
      unsubscribeEngine?.();
      window.removeEventListener('config-updated', configChanged);
      window.removeEventListener(SPEECH_SURFACE_HIDDEN_EVENT, hidden);
      if (owner.current === current) owner.current = undefined;
      instance.dispose();
    };
  }, [enabled, refresh, sessionAllowed, sessionId]);

  const engaged = presented || mediaPhases.has(view.phase);
  const canStart = enabled && sessionAllowed && !startDisabled && !checking && !engaged;
  const start = useCallback(() => {
    if (!canStart) return;
    setPresented(true);
    // An unavailable or unknown native outcome is shown for explicit review, never retried.
    if (!status.available) return;
    const current = owner.current;
    if (current) void current.controller.start(current.sessionId, readSettings().inputDeviceId);
  }, [canStart, status.available]);
  const end = useCallback(async () => {
    const current = owner.current;
    if (!current) {
      setPresented(false);
      return;
    }
    await current.controller.end();
    if (owner.current !== current) return;
    setPresented(false);
    const reset = initialView();
    viewRef.current = reset;
    setView(reset);
    void refresh();
  }, [refresh]);
  const toggleMicrophone = useCallback(() => {
    if (viewRef.current.phase === 'active')
      owner.current?.controller.setMicrophoneMuted(!viewRef.current.microphoneMuted);
  }, []);
  const toggleSpeaker = useCallback(() => {
    if (viewRef.current.phase === 'active')
      owner.current?.controller.setSpeakerMuted(!viewRef.current.speakerMuted);
  }, []);

  return {
    enabled: enabled && sessionAllowed,
    view,
    status,
    checking,
    engaged,
    canStart,
    start,
    end,
    refresh,
    toggleMicrophone,
    toggleSpeaker,
  };
}

export type RealtimeVoiceComposerSession = ReturnType<typeof useRealtimeVoiceSession>;
