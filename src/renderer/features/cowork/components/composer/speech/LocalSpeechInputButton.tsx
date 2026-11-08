import { DocumentArrowUpIcon, MicrophoneIcon, StopIcon } from '@heroicons/react/24/outline';
import { MediaCaptureSurface } from '@shared/app/mediaCapture';
import { EnginePhase } from '@shared/openclaw/engineStatus';
import { LocalSpeechModelKind } from '@shared/speech/localSpeechModels';
import {
  type LocalSpeechInputSource,
  type LocalSpeechSettings,
  normalizeLocalSpeechSettings,
  resolveLocalSpeechInputLanguage,
} from '@shared/speech/localSpeechSettings';
import type { OnlineAsrEvent, OnlineAsrSession } from '@shared/speech/onlineAsr';
import {
  getSpeechProtocolCapability,
  resolveOnlineSpeechBinding,
} from '@shared/speech/onlineSpeechModels';
import { SPEECH_SURFACE_HIDDEN_EVENT } from '@shared/speech/speechSettingsNavigation';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  bytesToBase64,
  floatToG711Ulaw,
  OnlineAsrAudioPump,
} from '@/features/cowork/components/composer/speech/onlineAudioCapture';
import { requestSpeechSettings } from '@/features/speech/speechSettingsNavigation';
import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';
import { recordedAudioToWav, recordedAudioToWavSegments } from '@/shared/audio/localAudioCapture';
import { useOwnerDocument, useOwnerWindow } from '@/shared/dom/ownerDocument';

type RecordingState = 'idle' | 'requesting' | 'recording' | 'transcribing';
type CaptureTrack = { source: 'microphone' | 'system'; stream: MediaStream };

const MAX_IMPORTED_MEDIA_BYTES = 256 * 1024 * 1024;
const MAX_PENDING_MEETING_SEGMENTS = 8;
const MAX_PENDING_ONLINE_AUDIO_CHUNKS = 16;
const MAX_PENDING_ONLINE_STARTUP_SAMPLES = 80_000;

const getCaptureSettingsKey = (settings: LocalSpeechSettings): string => {
  const selection =
    settings.recognitionMode === 'online'
      ? resolveOnlineSpeechBinding(
          configService.getConfig().onlineModelProviders?.['speech-recognition'],
          settings.onlineAsrModelRef,
          settings.onlineAsrBindingId,
          'composer-asr',
        )
      : null;
  return JSON.stringify([
    settings.inputEnabled,
    settings.asrModelId,
    settings.recognitionMode,
    settings.onlineAsrModelRef,
    settings.onlineAsrBindingId,
    settings.inputLanguage,
    settings.recognitionThreads,
    settings.inputDeviceId,
    settings.inputSource,
    settings.meetingMode,
    settings.meetingSegmentSeconds,
    settings.maxRecordingSeconds,
    selection?.binding,
    selection?.provider.baseUrl,
    selection?.provider.apiKey,
  ]);
};

interface LocalSpeechInputButtonProps {
  disabled: boolean;
  onTranscript: (text: string) => void;
}

const showToast = (message: string): void => {
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: message }));
};

const logCaptureDiagnostic = (event: string, details: Record<string, unknown> = {}): void => {
  window.electron.log?.debug(`[LocalSpeechInput] ${event}`, details);
};

const describeCaptureError = (error: unknown): Record<string, unknown> => {
  const candidate = error && typeof error === 'object' ? (error as Record<string, unknown>) : null;
  return {
    errorName: typeof candidate?.name === 'string' ? candidate.name : typeof error,
    errorMessage: typeof candidate?.message === 'string' ? candidate.message : String(error),
  };
};

const formatElapsed = (milliseconds: number): string => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};

const getMicrophoneStream = (deviceId: string, captureWindow: Window): Promise<MediaStream> =>
  captureWindow.navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      autoGainControl: true,
      echoCancellation: true,
      noiseSuppression: true,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
  });

const getSystemStream = async (captureWindow: Window): Promise<MediaStream> => {
  await window.electron.mediaCapture.armSystemAudio(
    captureWindow === window ? MediaCaptureSurface.Main : MediaCaptureSurface.Workspace,
  );
  const display = await captureWindow.navigator.mediaDevices.getDisplayMedia({
    audio: true,
    video: true,
  });
  display.getVideoTracks().forEach(track => track.stop());
  const audioTracks = display.getAudioTracks();
  if (audioTracks.length === 0) {
    throw new DOMException('System audio is unavailable.', 'NotFoundError');
  }
  return new MediaStream(audioTracks);
};

const openCaptureTracks = async (
  source: LocalSpeechInputSource,
  deviceId: string,
  captureWindow: Window,
): Promise<CaptureTrack[]> => {
  if (source === 'microphone') {
    return [{ source: 'microphone', stream: await getMicrophoneStream(deviceId, captureWindow) }];
  }
  if (source === 'system')
    return [{ source: 'system', stream: await getSystemStream(captureWindow) }];
  if (source !== 'microphone-system') return [];
  // Request loopback first so Chromium still sees the original button-click gesture.
  const system = await getSystemStream(captureWindow);
  try {
    return [
      { source: 'microphone', stream: await getMicrophoneStream(deviceId, captureWindow) },
      { source: 'system', stream: system },
    ];
  } catch (error) {
    system.getTracks().forEach(track => track.stop());
    throw error;
  }
};

export function LocalSpeechInputButton({
  disabled,
  onTranscript,
}: LocalSpeechInputButtonProps): React.ReactElement | null {
  const ownerDocument = useOwnerDocument();
  const ownerWindow = useOwnerWindow();
  const [available, setAvailable] = useState(false);
  const [onlineInputMode, setOnlineInputMode] = useState<'recording' | 'realtime'>('realtime');
  const [settings, setSettings] = useState<LocalSpeechSettings>(() =>
    normalizeLocalSpeechSettings(configService.getConfig().voice),
  );
  const [state, setState] = useState<RecordingState>('idle');
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [onlinePartial, setOnlinePartial] = useState('');
  const tracksRef = useRef<CaptureTrack[]>([]);
  const recordersRef = useRef<MediaRecorder[]>([]);
  const recorderStopsRef = useRef(new Map<MediaRecorder, Promise<void>>());
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);
  const activeRef = useRef(false);
  const startedAtRef = useRef(0);
  const transcriptQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingTranscriptionsRef = useRef(0);
  const captureRequestRef = useRef(0);
  const activeCaptureSettingsKeyRef = useRef('');
  const statusRequestRef = useRef(0);
  const transcriptionGenerationRef = useRef(0);
  const onlinePumpRef = useRef(new OnlineAsrAudioPump());
  const onlineSessionRef = useRef<OnlineAsrSession | null>(null);
  const onlineAppendChainRef = useRef<Promise<void>>(Promise.resolve());
  const onlinePendingAppendRef = useRef<{ sessionId: string; count: number } | null>(null);
  const onlineStartupSamplesRef = useRef<Float32Array[]>([]);
  const onlineStartupSampleCountRef = useRef(0);
  const onlineFinalCountRef = useRef(0);
  const onlineCloseWaiterRef = useRef<{ sessionId: string; resolve: () => void } | null>(null);
  const settingsRef = useRef(settings);
  const onTranscriptRef = useRef(onTranscript);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef(true);
  const recordedRequestsRef = useRef(new Set<string>());
  const onlineInputModeRef = useRef(onlineInputMode);
  onlineInputModeRef.current = onlineInputMode;
  settingsRef.current = settings;
  onTranscriptRef.current = onTranscript;

  const releaseCapture = useCallback(() => {
    timersRef.current.forEach(timer => clearTimeout(timer));
    timersRef.current = [];
    tracksRef.current.forEach(({ stream }) => stream.getTracks().forEach(track => track.stop()));
    tracksRef.current = [];
    recordersRef.current = [];
    recorderStopsRef.current.clear();
    onlinePumpRef.current.stop();
  }, []);

  const abortCapture = useCallback(() => {
    activeRef.current = false;
    captureRequestRef.current += 1;
    transcriptionGenerationRef.current += 1;
    transcriptQueueRef.current = Promise.resolve();
    pendingTranscriptionsRef.current = 0;
    activeCaptureSettingsKeyRef.current = '';
    for (const requestId of recordedRequestsRef.current)
      void window.electron.onlineAsr.cancelTranscription?.(requestId).catch(() => {});
    recordedRequestsRef.current.clear();
    const onlineSession = onlineSessionRef.current;
    onlineSessionRef.current = null;
    onlinePendingAppendRef.current = null;
    onlineStartupSamplesRef.current = [];
    onlineStartupSampleCountRef.current = 0;
    onlineCloseWaiterRef.current?.resolve();
    onlineCloseWaiterRef.current = null;
    if (onlineSession)
      void window.electron.onlineAsr.close(onlineSession.sessionId).catch(() => {});
    recordersRef.current.forEach(recorder => {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== 'inactive') recorder.stop();
    });
    releaseCapture();
    if (mountedRef.current) {
      setOnlinePartial('');
      setState('idle');
    }
  }, [releaseCapture]);

  const showTranscriptionFailure = useCallback((error: unknown) => {
    logCaptureDiagnostic('Transcription failed.', describeCaptureError(error));
    const message = error instanceof Error ? error.message : '';
    showToast(
      message === 'No speech was recognized.'
        ? i18nService.t('localAsrNoSpeech')
        : i18nService.t('localAsrFailed'),
    );
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const refresh = () => {
      const requestId = statusRequestRef.current + 1;
      statusRequestRef.current = requestId;
      const nextSettings = normalizeLocalSpeechSettings(configService.getConfig().voice);
      const binding =
        nextSettings.recognitionMode === 'online'
          ? resolveOnlineSpeechBinding(
              configService.getConfig().onlineModelProviders?.['speech-recognition'],
              nextSettings.onlineAsrModelRef,
              nextSettings.onlineAsrBindingId,
              'composer-asr',
            )
          : null;
      const inputMode =
        binding && getSpeechProtocolCapability(binding.binding.protocolId) === 'transcription'
          ? 'recording'
          : 'realtime';
      onlineInputModeRef.current = inputMode;
      setOnlineInputMode(inputMode);
      if (
        activeCaptureSettingsKeyRef.current &&
        activeCaptureSettingsKeyRef.current !== getCaptureSettingsKey(nextSettings)
      )
        abortCapture();
      setSettings(nextSettings);
      const statusRequest =
        nextSettings.recognitionMode === 'online'
          ? window.electron.onlineAsr.getStatus()
          : window.electron.localAsr.getStatus(nextSettings.asrModelId);
      void statusRequest
        .then(status => {
          if (mountedRef.current && statusRequestRef.current === requestId) {
            setAvailable(status.available);
            if (
              'inputMode' in status &&
              (status.inputMode === 'recording' || status.inputMode === 'realtime')
            )
              setOnlineInputMode(status.inputMode);
          }
        })
        .catch(() => {
          if (mountedRef.current && statusRequestRef.current === requestId) setAvailable(false);
        });
    };
    refresh();
    window.addEventListener('config-updated', refresh);
    window.addEventListener(SPEECH_SURFACE_HIDDEN_EVENT, abortCapture);
    const unsubscribeEngine = window.electron.openclaw?.engine?.onProgress(status => {
      if (settingsRef.current.recognitionMode !== 'online') return;
      if (onlineInputModeRef.current === 'recording') return;
      if (status.phase === EnginePhase.Running) {
        refresh();
      } else {
        statusRequestRef.current += 1;
        setAvailable(false);
      }
    });
    const unsubscribeModels = window.electron.localSpeechModels.onChanged(status => {
      if (
        settingsRef.current.recognitionMode === 'local' &&
        status.kind === LocalSpeechModelKind.Asr
      ) {
        refresh();
      }
    });
    return () => {
      mountedRef.current = false;
      activeRef.current = false;
      captureRequestRef.current += 1;
      statusRequestRef.current += 1;
      transcriptionGenerationRef.current += 1;
      window.removeEventListener('config-updated', refresh);
      window.removeEventListener(SPEECH_SURFACE_HIDDEN_EVENT, abortCapture);
      unsubscribeEngine?.();
      unsubscribeModels();
      abortCapture();
    };
  }, [abortCapture]);

  const transcribeWav = useCallback(
    async (
      wav: Uint8Array,
      source?: CaptureTrack['source'],
      elapsed = 0,
      generation = transcriptionGenerationRef.current,
    ) => {
      if (!mountedRef.current || generation !== transcriptionGenerationRef.current) return;
      let text: string;
      if (settings.recognitionMode === 'online') {
        const requestId = crypto.randomUUID();
        recordedRequestsRef.current.add(requestId);
        try {
          const result = await window.electron.onlineAsr.transcribe({
            requestId,
            audioWav: wav,
            language: resolveLocalSpeechInputLanguage(
              settings.inputLanguage,
              i18nService.getLanguage(),
            ),
          });
          if (result.requestId !== requestId)
            throw new Error('Transcription response belongs to another request.');
          text = result.text;
        } finally {
          recordedRequestsRef.current.delete(requestId);
        }
      } else {
        const result = await window.electron.localAsr.transcribe(wav, {
          modelId: settings.asrModelId,
          language: resolveLocalSpeechInputLanguage(
            settings.inputLanguage,
            i18nService.getLanguage(),
          ),
          numThreads: settings.recognitionThreads,
        });
        if (!result.success) throw new Error(result.error || 'Speech recognition failed.');
        text = result.text ?? '';
      }
      if (!text.trim()) throw new Error('No speech was recognized.');
      if (!mountedRef.current || generation !== transcriptionGenerationRef.current) return;
      text = text.trim();
      if (!settings.meetingMode || !source) {
        onTranscript(text);
        return;
      }
      const sourceLabel = i18nService.t(
        source === 'microphone' ? 'localAsrSourceMicrophoneShort' : 'localAsrSourceSystemShort',
      );
      onTranscript(`[${formatElapsed(elapsed)}] ${sourceLabel}: ${text}`);
    },
    [onTranscript, settings],
  );

  const enqueueTranscription = useCallback(
    (blob: Blob, source: CaptureTrack['source'], elapsed: number) => {
      if (pendingTranscriptionsRef.current >= MAX_PENDING_MEETING_SEGMENTS) {
        logCaptureDiagnostic('Meeting transcription queue is full.', {
          pendingSegments: pendingTranscriptionsRef.current,
        });
        showToast(i18nService.t('localAsrQueueFull'));
        return;
      }
      const generation = transcriptionGenerationRef.current;
      pendingTranscriptionsRef.current += 1;
      transcriptQueueRef.current = transcriptQueueRef.current
        .then(async () => {
          if (generation !== transcriptionGenerationRef.current) return;
          await transcribeWav(await recordedAudioToWav(blob), source, elapsed, generation);
        })
        .catch(error => {
          if (mountedRef.current && generation === transcriptionGenerationRef.current)
            showTranscriptionFailure(error);
        })
        .finally(() => {
          if (generation === transcriptionGenerationRef.current)
            pendingTranscriptionsRef.current = Math.max(0, pendingTranscriptionsRef.current - 1);
        });
    },
    [showTranscriptionFailure, transcribeWav],
  );

  const startRecorder = useCallback(
    (track: CaptureTrack) => {
      if (
        !activeRef.current ||
        !track.stream.active ||
        track.stream.getAudioTracks().every(audioTrack => audioTrack.readyState === 'ended')
      ) {
        return;
      }
      const recorder = new MediaRecorder(track.stream);
      const captureRequest = captureRequestRef.current;
      const generation = transcriptionGenerationRef.current;
      const chunks: Blob[] = [];
      const segmentStartedAt = Date.now() - startedAtRef.current;
      let markStopped: () => void = () => undefined;
      const stopped = new Promise<void>(resolve => {
        markStopped = resolve;
      });
      recorderStopsRef.current.set(recorder, stopped);
      recorder.ondataavailable = event => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onstop = () => {
        const current =
          captureRequest === captureRequestRef.current &&
          generation === transcriptionGenerationRef.current;
        if (current && chunks.length > 0) {
          enqueueTranscription(new Blob(chunks), track.source, segmentStartedAt);
        }
        recordersRef.current = recordersRef.current.filter(candidate => candidate !== recorder);
        recorderStopsRef.current.delete(recorder);
        markStopped();
        if (
          current &&
          activeRef.current &&
          settings.meetingMode &&
          track.stream.active &&
          track.stream.getAudioTracks().some(audioTrack => audioTrack.readyState === 'live')
        ) {
          startRecorder(track);
        }
      };
      recorder.onerror = event => {
        if (
          captureRequest !== captureRequestRef.current ||
          generation !== transcriptionGenerationRef.current
        )
          return;
        logCaptureDiagnostic('Media recorder failed.', describeCaptureError(event.error));
        showToast(i18nService.t('localAsrFailed'));
        abortCapture();
      };
      recordersRef.current.push(recorder);
      recorder.start();
      const seconds = settings.meetingMode
        ? settings.meetingSegmentSeconds
        : settings.maxRecordingSeconds;
      if (settings.meetingMode) {
        const timer = setTimeout(() => {
          timersRef.current = timersRef.current.filter(candidate => candidate !== timer);
          if (recorder.state === 'recording') recorder.stop();
        }, seconds * 1_000);
        timersRef.current.push(timer);
      }
    },
    [
      enqueueTranscription,
      settings.maxRecordingSeconds,
      settings.meetingMode,
      settings.meetingSegmentSeconds,
      abortCapture,
    ],
  );

  const appendOnlineSamples = useCallback(
    (samples: Float32Array) => {
      const session = onlineSessionRef.current;
      if (!activeRef.current) return;
      if (!session) {
        const remaining = MAX_PENDING_ONLINE_STARTUP_SAMPLES - onlineStartupSampleCountRef.current;
        if (remaining <= 0) return;
        const buffered = samples.slice(0, remaining);
        onlineStartupSamplesRef.current.push(buffered);
        onlineStartupSampleCountRef.current += buffered.length;
        return;
      }
      const pending = onlinePendingAppendRef.current;
      if (!pending || pending.sessionId !== session.sessionId) return;
      if (pending.count >= MAX_PENDING_ONLINE_AUDIO_CHUNKS) {
        logCaptureDiagnostic('Online transcription audio queue is full.', {
          pendingChunks: pending.count,
        });
        showToast(i18nService.t('localAsrQueueFull'));
        abortCapture();
        return;
      }
      const audioBase64 = bytesToBase64(floatToG711Ulaw(samples));
      pending.count += 1;
      onlineAppendChainRef.current = onlineAppendChainRef.current
        .then(() => window.electron.onlineAsr.appendAudio(session.sessionId, audioBase64))
        .catch(error => {
          if (!activeRef.current || onlineSessionRef.current !== session) return;
          logCaptureDiagnostic(
            'Online transcription audio upload failed.',
            describeCaptureError(error),
          );
          showToast(i18nService.t('onlineAsrFailed'));
          abortCapture();
        })
        .finally(() => {
          pending.count = Math.max(0, pending.count - 1);
        });
    },
    [abortCapture],
  );

  const stopOnlineRecording = useCallback(() => {
    const session = onlineSessionRef.current;
    if (!session) return false;
    const generation = transcriptionGenerationRef.current;
    activeRef.current = false;
    timersRef.current.forEach(timer => clearTimeout(timer));
    timersRef.current = [];
    onlinePumpRef.current.stop();
    tracksRef.current.forEach(({ stream }) => stream.getTracks().forEach(track => track.stop()));
    tracksRef.current = [];
    setState('transcribing');
    const closeEvent = new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 10_000);
      onlineCloseWaiterRef.current = {
        sessionId: session.sessionId,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      };
    });
    void onlineAppendChainRef.current
      .then(() => window.electron.onlineAsr.close(session.sessionId))
      .then(() => closeEvent)
      .catch(error => {
        if (onlineCloseWaiterRef.current?.sessionId === session.sessionId) {
          onlineCloseWaiterRef.current.resolve();
        }
        if (
          mountedRef.current &&
          generation === transcriptionGenerationRef.current &&
          onlineSessionRef.current === session
        ) {
          logCaptureDiagnostic('Online transcription close failed.', describeCaptureError(error));
          showToast(i18nService.t('onlineAsrFailed'));
        }
      })
      .finally(() => {
        if (onlineCloseWaiterRef.current?.sessionId === session.sessionId) {
          onlineCloseWaiterRef.current = null;
        }
        const completedCurrentSession = onlineSessionRef.current === session;
        if (completedCurrentSession) {
          onlineSessionRef.current = null;
          onlinePendingAppendRef.current = null;
        }
        if (
          mountedRef.current &&
          completedCurrentSession &&
          generation === transcriptionGenerationRef.current
        ) {
          setOnlinePartial('');
          if (completedCurrentSession && onlineFinalCountRef.current === 0) {
            showToast(i18nService.t('localAsrNoSpeech'));
          }
          setState('idle');
        }
      });
    return true;
  }, []);

  const stopRecording = useCallback(() => {
    if (stopOnlineRecording()) return;
    const captureRequest = captureRequestRef.current;
    const generation = transcriptionGenerationRef.current;
    activeRef.current = false;
    timersRef.current.forEach(timer => clearTimeout(timer));
    timersRef.current = [];
    const recorders = [...recordersRef.current];
    const stopped = recorders.map(
      recorder => recorderStopsRef.current.get(recorder) ?? Promise.resolve(),
    );
    recorders.forEach(recorder => {
      if (recorder.state === 'recording') recorder.stop();
    });
    setState('transcribing');
    void Promise.all(stopped).then(() => {
      if (
        captureRequest !== captureRequestRef.current ||
        generation !== transcriptionGenerationRef.current
      )
        return;
      return transcriptQueueRef.current.finally(() => {
        if (
          captureRequest !== captureRequestRef.current ||
          generation !== transcriptionGenerationRef.current
        )
          return;
        releaseCapture();
        if (mountedRef.current) setState('idle');
      });
    });
  }, [releaseCapture, stopOnlineRecording]);

  useEffect(() => {
    const api = window.electron.onlineAsr;
    if (!api) return;
    return api.onEvent((event: OnlineAsrEvent) => {
      const session = onlineSessionRef.current;
      if (!session || event.transcriptionSessionId !== session.transcriptionSessionId) return;
      if (event.type === 'partial') {
        setOnlinePartial(event.text?.trim() ?? '');
        return;
      }
      if (event.type === 'transcript' && event.final === true && event.text?.trim()) {
        const text = event.text.trim();
        onlineFinalCountRef.current += 1;
        setOnlinePartial('');
        const currentSettings = settingsRef.current;
        onTranscriptRef.current(
          currentSettings.meetingMode
            ? `[${formatElapsed(Date.now() - startedAtRef.current)}] ${i18nService.t('onlineAsrSourceShort')}: ${text}`
            : text,
        );
        return;
      }
      if (event.type === 'error') {
        logCaptureDiagnostic('Online transcription failed.', {
          hasProviderMessage: Boolean(event.message),
          provider: session.provider ?? '',
        });
        showToast(i18nService.t('onlineAsrFailed'));
        abortCapture();
        return;
      }
      if (event.type === 'close') {
        const waiter = onlineCloseWaiterRef.current;
        if (waiter?.sessionId === session.sessionId) {
          waiter.resolve();
        } else if (activeRef.current) {
          if (event.reason === 'error') showToast(i18nService.t('onlineAsrDisconnected'));
          abortCapture();
        }
      }
    });
  }, [abortCapture]);

  const startRecording = useCallback(async () => {
    const requestId = captureRequestRef.current + 1;
    captureRequestRef.current = requestId;
    activeCaptureSettingsKeyRef.current = getCaptureSettingsKey(settings);
    setState('requesting');
    try {
      const realtime = settings.recognitionMode === 'online' && onlineInputMode === 'realtime';
      if (realtime) onlinePumpRef.current.prepare();
      const tracks = await openCaptureTracks(
        settings.inputSource,
        settings.inputDeviceId,
        ownerWindow,
      );
      if (!mountedRef.current || captureRequestRef.current !== requestId) {
        tracks.forEach(({ stream }) => stream.getTracks().forEach(track => track.stop()));
        return;
      }
      tracksRef.current = tracks;
      startedAtRef.current = Date.now();
      if (realtime) {
        activeRef.current = true;
        onlineStartupSamplesRef.current = [];
        onlineStartupSampleCountRef.current = 0;
        await onlinePumpRef.current.start(
          tracks.map(track => track.stream),
          appendOnlineSamples,
        );
        if (!mountedRef.current || captureRequestRef.current !== requestId) return;
        const resolvedLanguage = resolveLocalSpeechInputLanguage(
          settings.inputLanguage,
          i18nService.getLanguage(),
        );
        const session = await window.electron.onlineAsr.start({
          language: resolvedLanguage === 'yue' ? 'zh' : resolvedLanguage,
        });
        if (!mountedRef.current || captureRequestRef.current !== requestId) {
          tracks.forEach(({ stream }) => stream.getTracks().forEach(track => track.stop()));
          void window.electron.onlineAsr.close(session.sessionId).catch(() => {});
          return;
        }
        onlineSessionRef.current = session;
        onlinePendingAppendRef.current = { sessionId: session.sessionId, count: 0 };
        onlineFinalCountRef.current = 0;
        onlineAppendChainRef.current = Promise.resolve();
        const startupSamples = onlineStartupSamplesRef.current;
        onlineStartupSamplesRef.current = [];
        onlineStartupSampleCountRef.current = 0;
        startupSamples.forEach(appendOnlineSamples);
      } else {
        activeRef.current = true;
      }
      tracks.forEach(track => {
        track.stream.getAudioTracks().forEach(audioTrack => {
          audioTrack.addEventListener(
            'ended',
            () => {
              if (!activeRef.current || captureRequestRef.current !== requestId) return;
              logCaptureDiagnostic('Audio capture track ended.', { source: track.source });
              showToast(i18nService.t('localAsrSourceUnavailable'));
              stopRecording();
            },
            { once: true },
          );
        });
      });
      setState('recording');
      if (!realtime) tracks.forEach(startRecorder);
      if (!settings.meetingMode) {
        timersRef.current.push(setTimeout(stopRecording, settings.maxRecordingSeconds * 1_000));
      }
    } catch (error) {
      if (!mountedRef.current || captureRequestRef.current !== requestId) return;
      activeRef.current = false;
      logCaptureDiagnostic('Audio capture failed.', {
        source: settings.inputSource,
        ...describeCaptureError(error),
      });
      const errorName = error instanceof ownerWindow.DOMException ? error.name : '';
      const messageKey =
        errorName === 'NotAllowedError'
          ? 'localAsrPermissionDenied'
          : errorName === 'NotFoundError'
            ? 'localAsrSourceUnavailable'
            : errorName === 'NotReadableError'
              ? 'localAsrSourceBusy'
              : errorName === 'OverconstrainedError'
                ? 'localAsrSelectedDeviceUnavailable'
                : settings.recognitionMode === 'online'
                  ? 'onlineAsrFailed'
                  : 'localAsrFailed';
      showToast(i18nService.t(messageKey));
      abortCapture();
    }
  }, [
    abortCapture,
    settings,
    onlineInputMode,
    appendOnlineSamples,
    startRecorder,
    stopRecording,
    ownerWindow,
  ]);

  const transcribeFile = useCallback(
    async (file: File) => {
      const generation = transcriptionGenerationRef.current;
      const isCurrent = () =>
        mountedRef.current && generation === transcriptionGenerationRef.current;
      setState('transcribing');
      activeCaptureSettingsKeyRef.current = getCaptureSettingsKey(settings);
      try {
        if (file.size > MAX_IMPORTED_MEDIA_BYTES) {
          throw new Error('Imported media exceeds the local size limit.');
        }
        const segments = await recordedAudioToWavSegments(file, settings.meetingSegmentSeconds);
        for (let index = 0; index < segments.length; index += 1) {
          if (!isCurrent()) break;
          await transcribeWav(
            segments[index],
            'system',
            index * settings.meetingSegmentSeconds * 1_000,
            generation,
          );
        }
      } catch (error) {
        if (isCurrent()) showTranscriptionFailure(error);
      } finally {
        if (isCurrent()) setState('idle');
      }
    },
    [settings, showTranscriptionFailure, transcribeWav],
  );

  useEffect(() => {
    if (settings.inputEnabled && available && !disabled) return;
    if (state !== 'idle') {
      abortCapture();
    }
  }, [abortCapture, available, disabled, settings.inputEnabled, state]);

  useEffect(() => {
    if (state !== 'requesting' && state !== 'recording') return;
    const settingsKey = getCaptureSettingsKey(settings);
    if (activeCaptureSettingsKeyRef.current !== settingsKey) abortCapture();
  }, [abortCapture, settings, state]);

  useEffect(() => {
    if (!menuPosition) return;
    const dismiss = () => setMenuPosition(null);
    const handlePointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) dismiss();
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        dismiss();
        if (event.key === 'Escape') buttonRef.current?.focus();
      }
    };
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    ownerDocument.addEventListener('pointerdown', handlePointer);
    ownerDocument.addEventListener('keydown', handleKey);
    ownerWindow.addEventListener('resize', dismiss);
    ownerWindow.addEventListener('blur', dismiss);
    ownerDocument.addEventListener('scroll', dismiss, true);
    return () => {
      ownerDocument.removeEventListener('pointerdown', handlePointer);
      ownerDocument.removeEventListener('keydown', handleKey);
      ownerWindow.removeEventListener('resize', dismiss);
      ownerWindow.removeEventListener('blur', dismiss);
      ownerDocument.removeEventListener('scroll', dismiss, true);
    };
  }, [menuPosition, ownerDocument, ownerWindow]);

  useEffect(() => {
    setMenuPosition(null);
  }, [disabled, available, settings.inputEnabled, settings.recognitionMode, state]);

  if (!settings.inputEnabled) return null;
  const recording = state === 'recording';
  const title =
    !available && state === 'idle'
      ? i18nService.t('voiceInputUnavailable')
      : i18nService.t(
          state === 'transcribing' || state === 'requesting'
            ? 'localAsrCancel'
            : recording
              ? 'localAsrStop'
              : settings.meetingMode
                ? 'localAsrStartMeeting'
                : 'localAsrStart',
        );
  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,video/*"
        className="hidden"
        onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (
            file &&
            available &&
            !disabled &&
            state === 'idle' &&
            (settings.recognitionMode === 'local' || onlineInputMode === 'recording')
          ) {
            void transcribeFile(file);
          }
        }}
      />
      <span
        className="relative inline-flex shrink-0"
        onContextMenu={event => {
          event.preventDefault();
          event.stopPropagation();
          if (disabled || state !== 'idle') return;
          const rect = event.currentTarget.getBoundingClientRect();
          setMenuPosition({
            x: Math.max(8, Math.min(rect.left, ownerWindow.innerWidth - 256)),
            y: Math.max(8, rect.top - 48),
          });
        }}
      >
        <button
          ref={buttonRef}
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuPosition !== null}
          onClick={() => {
            setMenuPosition(null);
            if (state === 'transcribing' || state === 'requesting') abortCapture();
            else if (recording) stopRecording();
            else void startRecording();
          }}
          className={`relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors ${
            recording
              ? 'bg-red-500/15 text-red-500 after:absolute after:inset-0 after:animate-ping after:rounded-lg after:border after:border-red-500/40'
              : 'text-secondary hover:bg-surface-raised hover:text-foreground'
          }`}
          title={title}
          aria-label={title}
          aria-pressed={recording}
          aria-busy={state === 'transcribing' || state === 'requesting'}
          disabled={disabled || (!available && state === 'idle')}
        >
          {state === 'transcribing' || state === 'requesting' ? (
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
          ) : recording ? (
            <StopIcon className="h-4 w-4" />
          ) : (
            <MicrophoneIcon className="h-4 w-4" />
          )}
        </button>
        {onlinePartial ? (
          <span
            role="status"
            className="absolute bottom-10 left-0 z-20 w-80 max-w-[70vw] truncate rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-xs text-foreground shadow-lg"
          >
            {onlinePartial}
          </span>
        ) : null}
      </span>
      {menuPosition &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            className="fixed z-50 w-60 rounded-lg border border-border bg-surface py-1 shadow-lg"
            style={{ left: menuPosition.x, top: menuPosition.y }}
          >
            <button
              type="button"
              role="menuitem"
              disabled={
                !available ||
                (settings.recognitionMode === 'online' && onlineInputMode !== 'recording')
              }
              title={
                settings.recognitionMode === 'online' && onlineInputMode !== 'recording'
                  ? i18nService.t('voiceImportRequiresRecording')
                  : undefined
              }
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground hover:bg-surface-raised disabled:opacity-50"
              onClick={() => {
                setMenuPosition(null);
                buttonRef.current?.focus();
                fileInputRef.current?.click();
              }}
            >
              <DocumentArrowUpIcon className="h-4 w-4 shrink-0" />
              {i18nService.t('voiceInputSourceFile')}
            </button>
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center px-3 py-1.5 text-left text-sm text-foreground hover:bg-surface-raised"
              onClick={() => {
                setMenuPosition(null);
                abortCapture();
                requestSpeechSettings();
              }}
            >
              {i18nService.t('openSettings')}
            </button>
          </div>,
          ownerDocument.body,
        )}
    </>
  );
}
