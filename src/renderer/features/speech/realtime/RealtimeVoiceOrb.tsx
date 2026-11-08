import './RealtimeVoiceOrb.css';

import { i18nService } from '@/services/i18n';

import type { RealtimeVoiceComposerSession } from './useRealtimeVoiceSession';

interface Props {
  session: RealtimeVoiceComposerSession;
  onOpenSettings: () => void;
}

export function RealtimeVoiceOrb({ session, onOpenSettings }: Props) {
  const { engaged, view, status, checking } = session;
  if (!engaged) return null;
  const needsAttention =
    view.phase === 'error' ||
    view.phase === 'unknown' ||
    (view.phase === 'idle' && !status.available);
  const unavailableKey =
    status.reason === 'unconfigured'
      ? 'realtimeVoiceUnconfigured'
      : status.reason === 'disabled'
        ? 'realtimeVoiceDisabled'
        : status.reason === 'unknown'
          ? 'realtimeVoiceUnknown'
          : status.reason === 'busy'
            ? 'realtimeVoiceBusy'
            : 'realtimeVoiceUnavailable';
  const phaseKey =
    view.phase === 'active'
      ? view.activity === 'responding'
        ? 'realtimeVoiceResponding'
        : view.microphoneMuted
          ? 'realtimeVoiceMicrophonePaused'
          : 'realtimeVoiceListening'
      : view.phase === 'idle' && !status.available
        ? unavailableKey
        : `realtimeVoice${view.phase.charAt(0).toUpperCase()}${view.phase.slice(1)}`;
  return (
    <section
      className="flex flex-col items-center gap-2 pb-3 pt-1"
      aria-label={i18nService.t('realtimeVoiceTitle')}
    >
      <div
        aria-hidden="true"
        className={`realtime-voice-orb ${needsAttention ? 'realtime-voice-orb--attention' : ''}`}
        data-phase={view.phase}
        data-activity={view.activity}
        data-muted={view.microphoneMuted}
      >
        <span className="realtime-voice-orb__cloud" />
      </div>
      <p role="status" className="max-w-md text-center text-xs text-secondary">
        {i18nService.t(phaseKey)}
      </p>
      {needsAttention && (
        <div className="flex items-center gap-3 text-xs text-secondary">
          <button
            type="button"
            disabled={checking}
            className="underline disabled:opacity-40"
            onClick={() => {
              void session.refresh();
            }}
          >
            {i18nService.t('realtimeVoiceRefresh')}
          </button>
          <button type="button" className="underline" onClick={onOpenSettings}>
            {i18nService.t('realtimeVoiceSettings')}
          </button>
          <button
            type="button"
            className="underline"
            onClick={() => {
              void session.end();
            }}
          >
            {i18nService.t('realtimeVoiceEnd')}
          </button>
        </div>
      )}
    </section>
  );
}
