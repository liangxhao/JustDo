import { MicrophoneIcon, StopIcon } from '@heroicons/react/24/outline';
import { useCallback, useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

const RECORDING_SECONDS = 10;
const QUIET_PEAK_THRESHOLD = 0.02;
type State = 'idle' | 'requesting' | 'finishing' | 'recording' | 'ready' | 'error';

export interface MicrophoneDiagnosticRecording {
  deviceId: string;
  blob: Blob;
}

/** One explicit, bounded device check. Recognition reuses its recording. */
export default function MicrophoneDiagnostics({
  deviceId,
  contextKey,
  onMicrophoneAccess,
  onRecordingChange,
}: {
  deviceId: string;
  contextKey: string;
  onMicrophoneAccess?: () => void;
  onRecordingChange: (recording: MicrophoneDiagnosticRecording | null) => void;
}) {
  const [state, setState] = useState<State>('idle');
  const [level, setLevel] = useState(0);
  const [peak, setPeak] = useState(0);
  const [audioUrl, setAudioUrl] = useState('');
  const [error, setError] = useState('');
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const meterTimer = useRef<ReturnType<typeof setInterval>>();
  const stopTimer = useRef<ReturnType<typeof setTimeout>>();
  const audioRef = useRef<HTMLAudioElement>(null);
  const urlRef = useRef('');
  const peakRef = useRef(0);
  const generation = useRef(0);
  const permissionPending = useRef(false);
  const mounted = useRef(true);
  const callbacks = useRef({ onMicrophoneAccess, onRecordingChange });
  callbacks.current = { onMicrophoneAccess, onRecordingChange };

  const pausePlayback = useCallback(() => audioRef.current?.pause(), []);
  const releaseCapture = useCallback(() => {
    clearInterval(meterTimer.current);
    clearTimeout(stopTimer.current);
    meterTimer.current = undefined;
    stopTimer.current = undefined;
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    const context = contextRef.current;
    contextRef.current = null;
    if (context && context.state !== 'closed') void context.close().catch(() => {});
    if (mounted.current) setLevel(0);
  }, []);
  const cancelCapture = useCallback(() => {
    generation.current += 1;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== 'inactive') recorder.stop();
    }
    releaseCapture();
    if (mounted.current)
      setState(permissionPending.current ? 'finishing' : urlRef.current ? 'ready' : 'idle');
  }, [releaseCapture]);
  const clearRecording = useCallback(() => {
    pausePlayback();
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = '';
    if (mounted.current) {
      setAudioUrl('');
      setPeak(0);
      callbacks.current.onRecordingChange(null);
    }
  }, [pausePlayback]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      cancelCapture();
      clearRecording();
    };
  }, [cancelCapture, clearRecording]);
  useEffect(() => {
    cancelCapture();
    clearRecording();
    setError('');
  }, [cancelCapture, clearRecording, deviceId]);
  useEffect(() => {
    // Tab changes end live checks, but retain a completed device-bound sample.
    cancelCapture();
    pausePlayback();
  }, [cancelCapture, contextKey, pausePlayback]);
  useEffect(() => {
    const hidden = () => {
      if (!document.hidden) return;
      cancelCapture();
      pausePlayback();
    };
    document.addEventListener('visibilitychange', hidden);
    return () => document.removeEventListener('visibilitychange', hidden);
  }, [cancelCapture, pausePlayback]);

  const stopRecording = () => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  };
  const startRecording = async () => {
    if (permissionPending.current || recorderRef.current?.state === 'recording' || document.hidden)
      return;
    cancelCapture();
    clearRecording();
    const ticket = generation.current;
    permissionPending.current = true;
    setState('requesting');
    setError('');
    peakRef.current = 0;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
      });
      if (!mounted.current || generation.current !== ticket) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      streamRef.current = stream;
      callbacks.current.onMicrophoneAccess?.();
      const context = new AudioContext();
      contextRef.current = context;
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      meterTimer.current = setInterval(() => {
        if (generation.current !== ticket) return;
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(
          samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length,
        );
        peakRef.current = Math.max(peakRef.current, rms);
        setLevel(Math.min(1, rms * 5));
        setPeak(peakRef.current);
      }, 80);
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = event => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onerror = () => {
        if (generation.current !== ticket) return;
        cancelCapture();
        setError(i18nService.t('voiceDiagnosticRecordingFailed'));
        setState('error');
      };
      recorder.onstop = () => {
        if (generation.current !== ticket) return;
        recorderRef.current = null;
        releaseCapture();
        if (!chunks.length) {
          setError(i18nService.t('voiceDiagnosticNoAudio'));
          setState('error');
          return;
        }
        const blob = new Blob(chunks, { type: recorder.mimeType || chunks[0].type });
        urlRef.current = URL.createObjectURL(blob);
        setAudioUrl(urlRef.current);
        callbacks.current.onRecordingChange({ deviceId, blob });
        setState('ready');
      };
      recorder.start();
      setState('recording');
      stopTimer.current = setTimeout(
        () => recorder.state === 'recording' && recorder.stop(),
        RECORDING_SECONDS * 1000,
      );
    } catch (captureError) {
      if (!mounted.current || generation.current !== ticket) return;
      cancelCapture();
      setError(
        i18nService.t(
          captureError instanceof DOMException && captureError.name === 'NotAllowedError'
            ? 'voiceDiagnosticPermissionDenied'
            : 'voiceDiagnosticRecordingFailed',
        ),
      );
      setState('error');
    } finally {
      permissionPending.current = false;
      if (mounted.current)
        setState(current =>
          current === 'finishing' ? (urlRef.current ? 'ready' : 'idle') : current,
        );
    }
  };
  const quiet = Boolean(audioUrl) && peak < QUIET_PEAK_THRESHOLD;
  return (
    <div className="rounded-lg border border-border bg-surface-raised/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-foreground">
            {i18nService.t('voiceMicrophoneCheckTitle')}
          </div>
          <p className="mt-1 text-xs leading-5 text-secondary">
            {i18nService.t('voiceMicrophoneCheckDescription')}
          </p>
        </div>
        <button
          type="button"
          disabled={state === 'requesting' || state === 'finishing'}
          onClick={state === 'recording' ? stopRecording : () => void startRecording()}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {state === 'recording' ? (
            <StopIcon className="h-4 w-4" />
          ) : (
            <MicrophoneIcon className="h-4 w-4" />
          )}
          {i18nService.t(
            state === 'recording'
              ? 'voiceMicrophoneCheckStop'
              : state === 'finishing'
                ? 'voiceInputFinishing'
                : state === 'requesting'
                  ? 'voiceDiagnosticRequesting'
                  : 'voiceMicrophoneCheckStart',
          )}
        </button>
      </div>
      <div className="mt-4" aria-label={i18nService.t('voiceDiagnosticLevel')}>
        <div className="h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
          <div
            className={`h-full rounded-full voice-microphone-level ${quiet ? 'bg-amber-500' : 'bg-green-500'}`}
            style={{ width: `${Math.round(level * 100)}%` }}
          />
        </div>
        <div className="mt-1 flex justify-between text-[11px] text-secondary">
          <span>{i18nService.t('voiceDiagnosticLevel')}</span>
          <span>{Math.round(Math.min(1, peak * 5) * 100)}%</span>
        </div>
      </div>
      {audioUrl ? (
        <audio
          ref={audioRef}
          className="mt-4 h-9 w-full"
          controls
          src={audioUrl}
          aria-label={i18nService.t('voiceDiagnosticPlayback')}
        />
      ) : null}
      {quiet ? (
        <p className="mt-3 text-xs text-amber-600 dark:text-amber-400" role="status">
          {i18nService.t('voiceDiagnosticTooQuiet')}
        </p>
      ) : null}
      {error ? (
        <p className="mt-3 text-xs text-red-500" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
