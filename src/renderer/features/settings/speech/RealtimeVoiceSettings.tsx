import type { LocalSpeechSettings } from '@shared/speech/localSpeechSettings';
import {
  getOnlineSpeechModelOptions,
  getOnlineSpeechVoiceSelectionOptions,
  ONLINE_SPEECH_PROVIDER_BINDING_ID,
  resolveOnlineSpeechBinding,
  resolveOnlineSpeechModel,
} from '@shared/speech/onlineSpeechModels';

import {
  getSpeechProtocolLabel,
  getSpeechVoiceOptionValue,
} from '@/features/speech/onlineSpeechPresentation';
import { i18nService } from '@/services/i18n';
import ThemedSelect from '@/shared/components/ui/ThemedSelect';

export default function RealtimeVoiceSettings({
  value,
  onChange,
  category,
  onManageModels,
}: {
  value: LocalSpeechSettings;
  onChange: (value: LocalSpeechSettings) => void;
  category: unknown;
  onManageModels?: () => void;
}) {
  const update = (patch: Partial<LocalSpeechSettings>) => onChange({ ...value, ...patch });
  const models = getOnlineSpeechModelOptions(category, { purpose: 'realtime-voice' });
  const selected = resolveOnlineSpeechBinding(
    category,
    value.realtimeModelRef,
    value.realtimeBindingId,
    'realtime-voice',
  );
  const voices = getOnlineSpeechVoiceSelectionOptions(selected?.model, selected?.binding);
  const selectedVoice = getSpeechVoiceOptionValue(voices, value.realtimeVoiceSelection);
  const voiceUnavailable = Boolean(value.realtimeVoiceSelection && !selectedVoice);
  return (
    <section className="space-y-5 rounded-xl border border-border bg-surface p-5">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h3 className="text-sm font-medium text-foreground">
            {i18nService.t('modelTypeRealtimeVoice')}
          </h3>
          <p className="mt-1 text-xs leading-5 text-secondary">
            {i18nService.t('realtimeVoiceSettingsDescription')}
          </p>
          {onManageModels ? (
            <button type="button" className="mt-2 text-xs text-primary" onClick={onManageModels}>
              {i18nService.t('speechManageModels')}
            </button>
          ) : null}
        </div>
        <button
          type="button"
          role="switch"
          aria-label={i18nService.t('realtimeVoiceEnable')}
          aria-checked={value.realtimeEnabled}
          onClick={() => update({ realtimeEnabled: !value.realtimeEnabled })}
          className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${value.realtimeEnabled ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'}`}
        >
          <span
            className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${value.realtimeEnabled ? 'translate-x-6' : 'translate-x-1'}`}
          />
        </button>
      </div>
      <div className="voice-setting-row">
        <div>
          <label htmlFor="voice-realtime-model" className="text-sm font-medium text-foreground">
            {i18nService.t('realtimeVoiceModel')}
          </label>
        </div>
        <div className="voice-setting-control">
          <ThemedSelect
            id="voice-realtime-model"
            value={
              models.some(model => model.value === value.realtimeModelRef)
                ? value.realtimeModelRef
                : ''
            }
            disabled={!value.realtimeEnabled || models.length === 0}
            options={[
              {
                value: '',
                label: i18nService.t(
                  models.length ? 'voiceSelectModel' : 'voiceNoOnlineModelsConfigured',
                ),
              },
              ...models,
            ]}
            onChange={realtimeModelRef => {
              if (realtimeModelRef === value.realtimeModelRef) return;
              const provider = resolveOnlineSpeechModel(category, realtimeModelRef)?.provider;
              update({
                realtimeModelRef,
                realtimeBindingId: Object.prototype.hasOwnProperty.call(
                  provider ?? {},
                  'protocolId',
                )
                  ? ONLINE_SPEECH_PROVIDER_BINDING_ID
                  : '',
                realtimeVoiceSelection: null,
              });
            }}
          />
        </div>
      </div>
      {value.realtimeModelRef.trim() ? (
        <p className="text-xs leading-5 text-secondary">
          {selected
            ? i18nService
                .t('speechCurrentProtocol')
                .replace('{protocol}', getSpeechProtocolLabel(selected.binding.protocolId))
            : i18nService.t('speechConfigureInterfaceInModels')}
        </p>
      ) : null}
      <div className="voice-setting-row">
        <div>
          <label htmlFor="voice-realtime-voice" className="text-sm font-medium text-foreground">
            {i18nService.t('realtimeVoiceSpeaker')}
          </label>
        </div>
        <div className="voice-setting-control">
          <ThemedSelect
            id="voice-realtime-voice"
            value={selectedVoice}
            disabled={!value.realtimeEnabled || voices.length === 0}
            options={[
              {
                value: '',
                label: i18nService.t(
                  voiceUnavailable
                    ? 'speechOnlineVoiceUnavailable'
                    : voices.length
                      ? 'voiceSelectSpeaker'
                      : 'voiceNoSpeakersConfigured',
                ),
              },
              ...voices,
            ]}
            onChange={voiceValue =>
              update({
                realtimeVoiceSelection:
                  voices.find(voice => voice.value === voiceValue)?.selection ?? null,
              })
            }
          />
        </div>
      </div>
      <p className="text-xs leading-5 text-secondary">
        {i18nService.t('realtimeVoiceSettingsSaveHint')}
      </p>
    </section>
  );
}
