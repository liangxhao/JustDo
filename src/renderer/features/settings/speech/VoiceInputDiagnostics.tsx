import { MicrophoneIcon, StopIcon } from '@heroicons/react/24/outline';
import type { LocalSpeechSettings } from '@shared/speech/localSpeechSettings';
import { resolveLocalSpeechInputLanguage } from '@shared/speech/localSpeechSettings';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';
import { recordedAudioToWav } from '@/shared/audio/localAudioCapture';

const DIAGNOSTIC_RECORDING_SECONDS = 10;
const QUIET_PEAK_THRESHOLD = 0.02;

type DiagnosticState = 'idle' | 'requesting' | 'recording' | 'transcribing' | 'ready' | 'error';

interface VoiceInputDiagnosticsProps {
  settings: LocalSpeechSettings;
  modelReady: boolean;
  onMicrophoneAccess?: () => void;
}

const stopStream = (stream: MediaStream | null): void => {
  stream?.getTracks().forEach(track => track.stop());
};

const VoiceInputDiagnostics: React.FC<VoiceInputDiagnosticsProps> = ({
  settings,
  modelReady,
  onMicrophoneAccess,
}) => {
  const [state, setState] = useState<DiagnosticState>('idle');
  const [level, setLevel] = useState(0);
  const [peak, setPeak] = useState(0);
  const [audioUrl, setAudioUrl] = useState('');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState('');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const meterTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioUrlRef = useRef('');
  const generationRef = useRef(0);
  const peakRef = useRef(0);

  const releaseCapture = useCallback(() => {
    if (meterTimerRef.current) clearInterval(meterTimerRef.current);
    if (autoStopTimerRef.current) clearTimeout(autoStopTimerRef.current);
    meterTimerRef.current = null;
    autoStopTimerRef.current = null;
    stopStream(streamRef.current);
    streamRef.current = null;
    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context && context.state !== 'closed') void context.close().catch(() => undefined);
    setLevel(0);
  }, []);

  const revokeAudioUrl = useCallback(() => {
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = '';
  }, []);

  const cancel = useCallback(() => {
    generationRef.current += 1;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder && recorder.state !== 'inactive') {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      recorder.stop();
    }
    releaseCapture();
    setState('idle');
  }, [releaseCapture]);

  useEffect(
    () => () => {
      cancel();
      revokeAudioUrl();
    },
    [cancel, revokeAudioUrl],
  );

  useEffect(() => {
    cancel();
    revokeAudioUrl();
    setAudioUrl('');
    setTranscript('');
    setError('');
  }, [cancel, revokeAudioUrl, settings.asrModelId, settings.inputDeviceId, settings.inputLanguage]);

  useEffect(() => {
    if (!modelReady) cancel();
  }, [cancel, modelReady]);

  const stopRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (recorder?.state === 'recording') recorder.stop();
  }, []);

  const startRecording = useCallback(async () => {
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setState('requesting');
    setError('');
    setTranscript('');
    setPeak(0);
    peakRef.current = 0;
    revokeAudioUrl();
    setAudioUrl('');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          autoGainControl: true,
          echoCancellation: true,
          noiseSuppression: true,
          ...(settings.inputDeviceId ? { deviceId: { exact: settings.inputDeviceId } } : {}),
        },
      });
      if (generationRef.current !== generation) {
        stopStream(stream);
        return;
      }
      onMicrophoneAccess?.();
      streamRef.current = stream;
      const context = new AudioContext();
      audioContextRef.current = context;
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      meterTimerRef.current = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        let squareSum = 0;
        for (const sample of samples) squareSum += sample * sample;
        const rms = Math.sqrt(squareSum / samples.length);
        const normalized = Math.min(1, rms * 5);
        peakRef.current = Math.max(peakRef.current, rms);
        setLevel(normalized);
        setPeak(peakRef.current);
      }, 80);

      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = event => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onerror = () => {
        if (generationRef.current !== generation) return;
        generationRef.current += 1;
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.onerror = null;
        recorderRef.current = null;
        releaseCapture();
        setError(i18nService.t('voiceDiagnosticRecordingFailed'));
        setState('error');
      };
      recorder.onstop = () => {
        recorderRef.current = null;
        releaseCapture();
        if (generationRef.current !== generation) return;
        if (chunks.length === 0) {
          setError(i18nService.t('voiceDiagnosticNoAudio'));
          setState('error');
          return;
        }
        const blob = new Blob(chunks, { type: recorder.mimeType || chunks[0]?.type });
        const nextAudioUrl = URL.createObjectURL(blob);
        audioUrlRef.current = nextAudioUrl;
        setAudioUrl(nextAudioUrl);
        setPeak(peakRef.current);
        setState('transcribing');
        void recordedAudioToWav(blob)
          .then(wav =>
            window.electron.localAsr.transcribe(wav, {
              modelId: settings.asrModelId,
              language: resolveLocalSpeechInputLanguage(
                settings.inputLanguage,
                i18nService.getLanguage(),
              ),
              numThreads: settings.recognitionThreads,
            }),
          )
          .then(result => {
            if (generationRef.current !== generation) return;
            if (!result.success) throw new Error(result.error);
            setTranscript(result.text?.trim() ?? '');
            setState('ready');
          })
          .catch(transcriptionError => {
            if (generationRef.current !== generation) return;
            const details =
              transcriptionError instanceof Error ? transcriptionError.message.trim() : '';
            setError(
              details
                ? `${i18nService.t('voiceDiagnosticRecognitionFailed')}: ${details}`
                : i18nService.t('voiceDiagnosticRecognitionFailed'),
            );
            setState('error');
          });
      };
      recorder.start();
      setState('recording');
      autoStopTimerRef.current = setTimeout(stopRecording, DIAGNOSTIC_RECORDING_SECONDS * 1_000);
    } catch (captureError) {
      if (generationRef.current !== generation) return;
      releaseCapture();
      const denied =
        captureError instanceof DOMException && captureError.name === 'NotAllowedError';
      setError(
        i18nService.t(
          denied ? 'voiceDiagnosticPermissionDenied' : 'voiceDiagnosticRecordingFailed',
        ),
      );
      setState('error');
    }
  }, [onMicrophoneAccess, releaseCapture, revokeAudioUrl, settings, stopRecording]);

  const quiet = Boolean(audioUrl) && state !== 'recording' && peak < QUIET_PEAK_THRESHOLD;
  const canInteract = modelReady && state !== 'requesting' && state !== 'transcribing';

  return (
    <div className="rounded-lg border border-border bg-surface-raised/50 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-foreground">
            {i18nService.t('voiceDiagnosticTitle')}
          </div>
          <p className="mt-1 text-xs leading-5 text-secondary">
            {i18nService.t('voiceDiagnosticDescription')}
          </p>
        </div>
        <button
          type="button"
          disabled={!canInteract}
          onClick={state === 'recording' ? stopRecording : () => void startRecording()}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {state === 'recording' ? (
            <StopIcon className="h-4 w-4" />
          ) : state === 'requesting' || state === 'transcribing' ? (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
          ) : (
            <MicrophoneIcon className="h-4 w-4" />
          )}
          {i18nService.t(
            state === 'recording'
              ? 'voiceDiagnosticStop'
              : state === 'requesting'
                ? 'voiceDiagnosticRequesting'
                : state === 'transcribing'
                  ? 'voiceDiagnosticRecognizing'
                  : 'voiceDiagnosticStart',
          )}
        </button>
      </div>

      <div className="mt-4" aria-label={i18nService.t('voiceDiagnosticLevel')}>
        <div className="h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
          <div
            className={`h-full rounded-full transition-[width] duration-75 ${quiet ? 'bg-amber-500' : 'bg-green-500'}`}
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
      {state === 'ready' ? (
        <div className="mt-3 rounded-lg bg-surface p-3 text-sm text-foreground" role="status">
          <div className="mb-1 text-xs font-medium text-secondary">
            {i18nService.t('voiceDiagnosticResult')}
          </div>
          {transcript || i18nService.t('voiceDiagnosticNoSpeech')}
        </div>
      ) : null}
      {error ? (
        <p className="mt-3 text-xs text-red-500" role="alert">
          {error}
        </p>
      ) : null}
      {!modelReady ? (
        <p className="mt-3 text-xs text-secondary">{i18nService.t('voiceDiagnosticNeedsModel')}</p>
      ) : null}
    </div>
  );
};

export default VoiceInputDiagnostics;
