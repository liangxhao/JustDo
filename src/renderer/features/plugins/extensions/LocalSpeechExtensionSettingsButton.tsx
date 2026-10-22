import { Cog6ToothIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { normalizeLocalSpeechExtensionSettings } from '@shared/speech/localSpeechExtensionSettings';
import { LocalSpeechModelKind } from '@shared/speech/localSpeechModels';
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
  useEffect(() => {
    const update = () =>
      setSettings(
        normalizeLocalSpeechExtensionSettings(configService.getConfig().localSpeechExtensions),
      );
    window.addEventListener('config-updated', update);
    return () => window.removeEventListener('config-updated', update);
  }, []);

  const modelId = kind === LocalSpeechModelKind.Asr ? settings.sttModelId : settings.ttsModelId;
  const status = models.statuses.find(model => model.kind === kind && model.id === modelId);
  const needsModel =
    models.supported && !models.loading && !models.error && status?.phase !== 'ready';
  const warning = i18nService.t('speechExtensionModelNotReady');
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
