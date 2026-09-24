import { SpeakerWaveIcon, StopIcon } from '@heroicons/react/24/outline';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

const MAX_PREVIEW_TEXT_LENGTH = 500;
const MAX_AUDIO_BASE64_LENGTH = 32 * 1024 * 1024;

type PreviewState = 'idle' | 'loading' | 'playing' | 'error';

interface VoiceOutputDiagnosticsProps {
  available: boolean;
  configurationKey: string;
}

const VoiceOutputDiagnostics: React.FC<VoiceOutputDiagnosticsProps> = ({
  available,
  configurationKey,
}) => {
  const [text, setText] = useState(() => i18nService.t('voiceOutputDiagnosticSample'));
  const [state, setState] = useState<PreviewState>('idle');
  const [error, setError] = useState('');
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef('');
  const generationRef = useRef(0);

  const stop = useCallback(() => {
    generationRef.current += 1;
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.pause();
    }
    audioRef.current = null;
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = '';
    setState('idle');
  }, []);

  useEffect(() => stop, [stop]);

  useEffect(() => {
    stop();
    setError('');
  }, [available, configurationKey, stop]);

  const play = useCallback(async () => {
    const previewText = text.trim();
    if (!available || !previewText) return;
    stop();
    const generation = generationRef.current;
    setState('loading');
    setError('');
    try {
      const result = await window.electron.speechSynthesis.speak(previewText);
      if (generationRef.current !== generation) return;
      if (
        !result.audioBase64 ||
        result.audioBase64.length > MAX_AUDIO_BASE64_LENGTH ||
        (result.mimeType !== undefined && !result.mimeType.startsWith('audio/'))
      ) {
        throw new Error('Invalid speech audio response.');
      }
      const bytes = Uint8Array.from(atob(result.audioBase64), char => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType ?? 'audio/wav' }));
      const audio = new Audio(url);
      audioRef.current = audio;
      audioUrlRef.current = url;
      setState('playing');
      audio.onended = stop;
      audio.onerror = () => {
        stop();
        setError(i18nService.t('voiceOutputDiagnosticFailed'));
        setState('error');
      };
      await audio.play();
    } catch {
      if (generationRef.current !== generation) return;
      stop();
      setError(i18nService.t('voiceOutputDiagnosticFailed'));
      setState('error');
    }
  }, [available, stop, text]);

  const busy = state === 'loading' || state === 'playing';
  const canPlay = available && Boolean(text.trim());

  return (
    <div className="rounded-lg border border-border bg-surface-raised/50 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-foreground">
            {i18nService.t('voiceOutputDiagnosticTitle')}
          </div>
          <p className="mt-1 text-xs leading-5 text-secondary">
            {i18nService.t('voiceOutputDiagnosticDescription')}
          </p>
        </div>
        <button
          type="button"
          disabled={!busy && !canPlay}
          onClick={busy ? stop : () => void play()}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {state === 'loading' ? (
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
          ) : state === 'playing' ? (
            <StopIcon className="h-4 w-4" />
          ) : (
            <SpeakerWaveIcon className="h-4 w-4" />
          )}
          {i18nService.t(
            state === 'loading'
              ? 'voiceOutputDiagnosticGenerating'
              : state === 'playing'
                ? 'voiceOutputDiagnosticStop'
                : 'voiceOutputDiagnosticPlay',
          )}
        </button>
      </div>
      <textarea
        value={text}
        maxLength={MAX_PREVIEW_TEXT_LENGTH}
        rows={2}
        aria-label={i18nService.t('voiceOutputDiagnosticText')}
        onChange={event => setText(event.target.value)}
        className="mt-4 w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none transition placeholder:text-secondary focus:border-primary focus:ring-2 focus:ring-primary/20"
      />
      {!available ? (
        <p className="mt-3 text-xs text-secondary">
          {i18nService.t('voiceOutputDiagnosticUnavailable')}
        </p>
      ) : null}
      {error ? (
        <p className="mt-3 text-xs text-red-500" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
};

export default VoiceOutputDiagnostics;
