import { LOCAL_TTS_MODEL_IDS, type LocalTtsModelId } from '@shared/speech/localTts';
import { useCallback, useEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';
import { useOwnerWindow } from '@/shared/dom/ownerDocument';

import type { LocalSpeechModelVoice } from './localSpeechModelCatalog';

const MAX_AUDIO_BYTES = 32 * 1024 * 1024;

export function useBuiltinSpeechVoicePreview(modelId: string, available: boolean) {
  const ownerWindow = useOwnerWindow();
  const [active, setActive] = useState<{ voiceId: string; phase: 'loading' | 'playing' } | null>(
    null,
  );
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const requestId = useRef<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const audioUrl = useRef<string | null>(null);

  const stop = useCallback(() => {
    generation.current += 1;
    const pendingId = requestId.current;
    requestId.current = null;
    if (pendingId) {
      void window.electron.speechSynthesis.cancelBuiltinPreview(pendingId).catch(() => {});
    }
    if (audio.current) {
      audio.current.onended = null;
      audio.current.onerror = null;
      audio.current.pause();
      audio.current = null;
    }
    if (audioUrl.current) ownerWindow.URL.revokeObjectURL(audioUrl.current);
    audioUrl.current = null;
    setActive(null);
  }, [ownerWindow]);

  useEffect(() => {
    stop();
    setFailed(false);
    return stop;
  }, [available, modelId, stop]);

  const play = useCallback(
    async (voice: LocalSpeechModelVoice) => {
      if (!available || !LOCAL_TTS_MODEL_IDS.includes(modelId as LocalTtsModelId)) return;
      stop();
      const currentGeneration = generation.current;
      const currentRequestId = ownerWindow.crypto.randomUUID();
      requestId.current = currentRequestId;
      setFailed(false);
      setActive({ voiceId: voice.id, phase: 'loading' });
      try {
        const result = await window.electron.speechSynthesis.previewBuiltin({
          requestId: currentRequestId,
          modelId: modelId as LocalTtsModelId,
          voiceId: Number(voice.id),
          text: i18nService.t(
            voice.language === 'en' ? 'speechVoiceSampleEnglish' : 'speechVoiceSampleChinese',
          ),
        });
        if (generation.current !== currentGeneration) return;
        requestId.current = null;
        if (
          result.requestId !== currentRequestId ||
          !result.audioBase64 ||
          result.audioBase64.length > Math.ceil(MAX_AUDIO_BYTES / 3) * 4 ||
          (result.mimeType !== undefined && result.mimeType !== 'audio/wav')
        ) {
          throw new Error('Invalid preview audio.');
        }
        const bytes = Uint8Array.from(atob(result.audioBase64), char => char.charCodeAt(0));
        if (
          bytes.length < 44 ||
          bytes.length > MAX_AUDIO_BYTES ||
          String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF' ||
          String.fromCharCode(...bytes.subarray(8, 12)) !== 'WAVE'
        ) {
          throw new Error('Invalid preview audio.');
        }
        audioUrl.current = ownerWindow.URL.createObjectURL(
          new Blob([bytes], { type: 'audio/wav' }),
        );
        const player = new ownerWindow.Audio(audioUrl.current);
        audio.current = player;
        player.onended = () => {
          if (generation.current === currentGeneration) stop();
        };
        player.onerror = () => {
          if (generation.current !== currentGeneration) return;
          stop();
          setFailed(true);
        };
        setActive({ voiceId: voice.id, phase: 'playing' });
        await player.play();
      } catch {
        if (generation.current !== currentGeneration) return;
        stop();
        setFailed(true);
      }
    },
    [available, modelId, ownerWindow, stop],
  );

  return { active, failed, play, stop };
}
