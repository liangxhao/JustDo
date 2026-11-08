import {
  MicrophoneIcon,
  PhoneIcon,
  SpeakerWaveIcon,
  SpeakerXMarkIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';

import type { RealtimeVoiceComposerSession } from '@/features/speech/realtime/useRealtimeVoiceSession';
import { i18nService } from '@/services/i18n';

import { LocalSpeechInputButton } from './LocalSpeechInputButton';
import type { SpeechTranscriptionActivity } from './useSpeechTranscriptionActivity';

interface Props {
  disabled: boolean;
  onTranscript: (text: string) => void;
  realtime: RealtimeVoiceComposerSession;
  transcription: SpeechTranscriptionActivity;
}

export function SpeechInputControls({ disabled, onTranscript, realtime, transcription }: Props) {
  const buttonClass =
    'relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-secondary hover:bg-surface-raised hover:text-foreground disabled:opacity-40';
  if (realtime.enabled && realtime.engaged) {
    const active = realtime.view.phase === 'active';
    const speakerLabel = i18nService.t(
      realtime.view.speakerMuted ? 'realtimeVoiceUnmuteSpeaker' : 'realtimeVoiceMuteSpeaker',
    );
    const microphoneLabel = i18nService.t(
      realtime.view.microphoneMuted
        ? 'realtimeVoiceUnmuteMicrophone'
        : 'realtimeVoiceMuteMicrophone',
    );
    return (
      <>
        <button
          type="button"
          className={buttonClass}
          disabled={!active}
          aria-pressed={realtime.view.speakerMuted}
          title={speakerLabel}
          aria-label={speakerLabel}
          onClick={realtime.toggleSpeaker}
        >
          {realtime.view.speakerMuted ? (
            <SpeakerXMarkIcon className="h-4 w-4" />
          ) : (
            <SpeakerWaveIcon className="h-4 w-4" />
          )}
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={!active}
          aria-pressed={realtime.view.microphoneMuted}
          title={microphoneLabel}
          aria-label={microphoneLabel}
          onClick={realtime.toggleMicrophone}
        >
          <MicrophoneIcon className="h-4 w-4" />
          {realtime.view.microphoneMuted && (
            <svg className="absolute h-4 w-4" aria-hidden="true" viewBox="0 0 24 24">
              <path d="M4 20 20 4" fill="none" stroke="currentColor" strokeWidth="2" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={realtime.view.phase === 'ending'}
          title={i18nService.t('realtimeVoiceEnd')}
          aria-label={i18nService.t('realtimeVoiceEnd')}
          onClick={() => {
            void realtime.end();
          }}
        >
          <XMarkIcon className="h-4 w-4" />
        </button>
      </>
    );
  }
  return (
    <>
      <LocalSpeechInputButton
        disabled={disabled || realtime.engaged}
        onTranscript={onTranscript}
        onBusyChange={transcription.changed}
        startBlocked={transcription.busy}
        isStartBlocked={transcription.isBusy}
      />
      {realtime.enabled && (
        <button
          type="button"
          className={buttonClass}
          disabled={disabled || transcription.busy || !realtime.canStart}
          title={i18nService.t(
            transcription.busy ? 'realtimeVoiceTranscriptionBusy' : 'realtimeVoiceStart',
          )}
          aria-label={i18nService.t('realtimeVoiceStart')}
          onClick={() => {
            if (!transcription.isBusy() && !disabled && realtime.canStart) realtime.start();
          }}
        >
          <PhoneIcon className="h-4 w-4" />
        </button>
      )}
    </>
  );
}
