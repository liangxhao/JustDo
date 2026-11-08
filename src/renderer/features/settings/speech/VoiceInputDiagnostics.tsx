import type { LocalSpeechSettings } from '@shared/speech/localSpeechSettings';
import { resolveLocalSpeechInputLanguage } from '@shared/speech/localSpeechSettings';
import { useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';
import { recordedAudioToWav } from '@/shared/audio/localAudioCapture';

/** Recognition reuses the shared device check; it never opens another stream. */
export default function VoiceInputDiagnostics({
  settings,
  modelReady,
  recording,
}: {
  settings: LocalSpeechSettings;
  modelReady: boolean;
  recording: Blob | null;
}) {
  const [state, setState] = useState<'idle' | 'transcribing' | 'ready' | 'error'>('idle');
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    setState('idle');
    setTranscript('');
    setError('');
    return () => {
      generation.current += 1;
    };
  }, [
    recording,
    modelReady,
    settings.asrModelId,
    settings.inputDeviceId,
    settings.inputLanguage,
    settings.recognitionThreads,
  ]);
  useEffect(() => {
    const hidden = () => {
      if (!document.hidden) return;
      generation.current += 1;
      setState(current => (current === 'transcribing' ? 'idle' : current));
    };
    document.addEventListener('visibilitychange', hidden);
    return () => document.removeEventListener('visibilitychange', hidden);
  }, []);
  const recognize = async () => {
    if (!recording || !modelReady || state === 'transcribing' || document.hidden) return;
    const ticket = ++generation.current;
    setState('transcribing');
    setError('');
    try {
      const wav = await recordedAudioToWav(recording);
      if (generation.current !== ticket) return;
      const result = await window.electron.localAsr.transcribe(wav, {
        modelId: settings.asrModelId,
        language: resolveLocalSpeechInputLanguage(
          settings.inputLanguage,
          i18nService.getLanguage(),
        ),
        numThreads: settings.recognitionThreads,
      });
      if (generation.current !== ticket) return;
      if (!result.success) throw new Error(result.error);
      setTranscript(result.text?.trim() ?? '');
      setState('ready');
    } catch {
      if (generation.current !== ticket) return;
      setError(i18nService.t('voiceDiagnosticRecognitionFailed'));
      setState('error');
    }
  };
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
          disabled={!modelReady || !recording || state === 'transcribing'}
          onClick={() => void recognize()}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {i18nService.t(
            state === 'transcribing' ? 'voiceDiagnosticRecognizing' : 'voiceDiagnosticStart',
          )}
        </button>
      </div>
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
      ) : !recording ? (
        <p className="mt-3 text-xs text-secondary">
          {i18nService.t('voiceDiagnosticNeedsRecording')}
        </p>
      ) : null}
    </div>
  );
}
