import { Cog6ToothIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { normalizeLocalSpeechExtensionSettings } from '@shared/speech/localSpeechExtensionSettings';
import { LocalSpeechModelKind } from '@shared/speech/localSpeechModels';
import {
  getOnlineSpeechModelOptions,
  getOnlineSpeechVoiceOptions,
  resolveOnlineSpeechModel,
} from '@shared/speech/onlineSpeechModels';
import { type MouseEvent, useEffect, useState } from 'react';

import { useLocalSpeechModels } from '@/features/speech/useLocalSpeechModels';
import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';
import Tooltip from '@/shared/components/ui/Tooltip';

export default function LocalSpeechExtensionSettingsButton({
  kind,
  name,
  disabled,
  onOpen,
}: {
  kind: LocalSpeechModelKind;
  name: string;
  disabled: boolean;
  onOpen: () => void;
}) {
  const models = useLocalSpeechModels();
  const [settings, setSettings] = useState(() =>
    normalizeLocalSpeechExtensionSettings(configService.getConfig().localSpeechExtensions),
  );
  const [catalog, setCatalog] = useState(() => configService.getConfig().onlineModelProviders);
  useEffect(() => {
    const update = () => {
      setSettings(
        normalizeLocalSpeechExtensionSettings(configService.getConfig().localSpeechExtensions),
      );
      setCatalog(configService.getConfig().onlineModelProviders);
    };
    window.addEventListener('config-updated', update);
    return () => window.removeEventListener('config-updated', update);
  }, []);

  const asr = kind === LocalSpeechModelKind.Asr;
  const modelId = asr ? settings.sttModelId : settings.ttsModelId;
  const online = (asr ? settings.sttMode : settings.ttsMode) === 'online';
  const reference = asr ? settings.onlineSttModelRef : settings.onlineTtsModelRef;
  const category = catalog?.[asr ? 'speech-recognition' : 'speech-synthesis'];
  const selection = resolveOnlineSpeechModel(category, reference);
  const onlineValid =
    getOnlineSpeechModelOptions(category, { requireVoice: !asr, fileTranscription: asr }).some(
      option => option.value === reference,
    ) &&
    (asr ||
      getOnlineSpeechVoiceOptions(selection?.model).some(
        option => option.value === settings.onlineTtsVoice,
      ));
  const status = models.statuses.find(model => model.kind === kind && model.id === modelId);
  const needsModel = online
    ? !onlineValid
    : models.supported && !models.loading && !models.error && status?.phase !== 'ready';
  const warning = i18nService.t(
    online ? 'speechOnlineSelectionUnavailable' : 'speechExtensionModelNotReady',
  );
  const openSettings = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onOpen();
  };

  return (
    <>
      {needsModel && (
        <Tooltip
          content={warning}
          position="top"
          className="pointer-events-auto"
          renderInPortal
          dismissOnClick
        >
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded-md text-amber-600 dark:text-amber-400 hover:bg-surface-raised focus:outline-none focus:ring-2 focus:ring-primary"
            aria-label={`${name} · ${warning}`}
            disabled={disabled}
            onClick={openSettings}
          >
            <ExclamationTriangleIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        </Tooltip>
      )}
      <button
        type="button"
        className="pointer-events-auto rounded-lg p-1.5 text-secondary hover:bg-surface-raised"
        aria-label={`${name} · ${i18nService.t('speechExtensionModelSettings')}`}
        title={i18nService.t('speechExtensionModelSettings')}
        disabled={disabled}
        onClick={openSettings}
      >
        <Cog6ToothIcon className="h-4 w-4" aria-hidden="true" />
      </button>
    </>
  );
}
