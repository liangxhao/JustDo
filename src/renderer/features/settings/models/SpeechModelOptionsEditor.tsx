import type {
  OnlineSpeechModelParameters,
  OnlineSpeechProviderProtocol,
} from '@shared/speech/onlineSpeechModels';

import { i18nService } from '@/services/i18n';

export default function SpeechModelOptionsEditor({
  protocol,
  value,
  onChange,
}: {
  protocol: OnlineSpeechProviderProtocol | undefined;
  value: OnlineSpeechModelParameters;
  onChange: (value: OnlineSpeechModelParameters) => void;
}) {
  if (!protocol)
    return (
      <p className="text-xs text-muted">{i18nService.t('speechModelOptionsChooseProtocol')}</p>
    );
  if (protocol.protocolId === 'openai-voice-realtime')
    return (
      <label className="block text-xs text-secondary">
        {i18nService.t('speechInputTranscriptionModel')}
        <input
          value={value.inputTranscriptionModel ?? ''}
          maxLength={256}
          onChange={event =>
            onChange({
              ...value,
              voicePolicy: 'preset',
              inputTranscriptionModel: event.target.value,
            })
          }
          className="mt-1 w-full rounded-lg border border-border-input bg-surface px-3 py-2 text-foreground"
        />
        <span className="mt-1 block text-muted">
          {i18nService.t('speechInputTranscriptionModelHint')}
        </span>
      </label>
    );
  return null;
}
