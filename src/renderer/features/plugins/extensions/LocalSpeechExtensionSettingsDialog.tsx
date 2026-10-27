import { Cog6ToothIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { LOCAL_ASR_MODEL_IDS, type LocalAsrModelId } from '@shared/speech/localAsr';
import { normalizeLocalSpeechExtensionSettings } from '@shared/speech/localSpeechExtensionSettings';
import { LocalSpeechModelKind } from '@shared/speech/localSpeechModels';
import {
  getLocalTtsDefaultVoiceId,
  LOCAL_TTS_MODEL_IDS,
  type LocalTtsModelId,
} from '@shared/speech/localTts';
import {
  getOnlineSpeechModelOptions,
  getOnlineSpeechVoiceOptions,
  resolveOnlineSpeechModel,
} from '@shared/speech/onlineSpeechModels';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { getLocalSpeechVoiceOptions } from '@/features/speech/localSpeechModelCatalog';
import LocalSpeechModelStatusView from '@/features/speech/LocalSpeechModelStatusView';
import type { SpeechModelCatalogTarget } from '@/features/speech/speechModelCatalogNavigation';
import { useLocalSpeechModels } from '@/features/speech/useLocalSpeechModels';
import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';
import Modal from '@/shared/components/ui/Modal';
import ThemedSelect from '@/shared/components/ui/ThemedSelect';
import { useOwnerDocument } from '@/shared/dom/ownerDocument';

const modelKeys: Record<LocalAsrModelId | LocalTtsModelId, string> = {
  'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09': 'voiceAsrModelSenseVoice',
  'sherpa-onnx-whisper-base': 'voiceAsrModelWhisperBase',
  'kokoro-int8-multi-lang-v1_1': 'voiceTtsModelKokoro',
  'vits-icefall-zh-aishell3': 'voiceTtsModelAishell3',
  'vits-piper-en_US-lessac-medium-int8': 'voiceTtsModelPiperEnglish',
};

export default function LocalSpeechExtensionSettingsDialog({
  kind,
  onClose,
  onManageModels,
  hidden = false,
}: {
  kind: LocalSpeechModelKind;
  onClose: () => void;
  onManageModels?: (kind: LocalSpeechModelKind, target?: SpeechModelCatalogTarget) => void;
  hidden?: boolean;
}) {
  const ownerDocument = useOwnerDocument();
  const asr = kind === LocalSpeechModelKind.Asr;
  const name = asr ? 'stt-local-cli' : 'tts-local-cli';
  const key = asr ? 'sttModelId' : 'ttsModelId';
  const [modelId, setModelId] = useState<string>(
    () =>
      normalizeLocalSpeechExtensionSettings(configService.getConfig().localSpeechExtensions)[key],
  );
  const [ttsVoiceId, setTtsVoiceId] = useState(
    () =>
      normalizeLocalSpeechExtensionSettings(configService.getConfig().localSpeechExtensions)
        .ttsVoiceId,
  );
  const [mode, setMode] = useState(() => {
    const settings = normalizeLocalSpeechExtensionSettings(
      configService.getConfig().localSpeechExtensions,
    );
    return asr ? settings.sttMode : settings.ttsMode;
  });
  const [onlineModelRef, setOnlineModelRef] = useState(() => {
    const settings = normalizeLocalSpeechExtensionSettings(
      configService.getConfig().localSpeechExtensions,
    );
    return asr ? settings.onlineSttModelRef : settings.onlineTtsModelRef;
  });
  const [onlineVoice, setOnlineVoice] = useState(
    () =>
      normalizeLocalSpeechExtensionSettings(configService.getConfig().localSpeechExtensions)
        .onlineTtsVoice,
  );
  const [catalog, setCatalog] = useState(() => configService.getConfig().onlineModelProviders);
  useEffect(() => {
    const refresh = () => setCatalog(configService.getConfig().onlineModelProviders);
    refresh();
    window.addEventListener('config-updated', refresh);
    return () => window.removeEventListener('config-updated', refresh);
  }, [hidden]);
  const category = catalog?.[asr ? 'speech-recognition' : 'speech-synthesis'];
  const onlineOptions = getOnlineSpeechModelOptions(category, {
    requireVoice: !asr,
    fileTranscription: asr,
  });
  const selectedOnlineModel = resolveOnlineSpeechModel(category, onlineModelRef);
  const onlineVoiceOptions = getOnlineSpeechVoiceOptions(selectedOnlineModel?.model);
  const modelAvailable = onlineOptions.some(option => option.value === onlineModelRef);
  const voiceAvailable = onlineVoiceOptions.some(option => option.value === onlineVoice);
  const onlineError = !onlineModelRef
    ? i18nService.t(onlineOptions.length ? 'voiceSelectModel' : 'voiceNoOnlineModelsConfigured')
    : !modelAvailable
      ? i18nService.t('speechOnlineSelectionUnavailable')
      : !asr && !voiceAvailable
        ? i18nService.t(
            onlineVoiceOptions.length ? 'voiceSelectSpeaker' : 'voiceNoSpeakersConfigured',
          )
        : '';
  const models = useLocalSpeechModels();
  const status = models.statuses.find(candidate => candidate.id === modelId) ?? null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const form = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const close = () => {
    if (!saving) onClose();
  };
  useEffect(() => {
    mounted.current = true;
    const previous = ownerDocument.activeElement as HTMLElement | null;
    return () => {
      mounted.current = false;
      previous?.focus();
    };
  }, [ownerDocument]);
  useEffect(() => {
    if (!hidden) form.current?.focus();
  }, [hidden]);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await configService.updateConfig({
        localSpeechExtensions: asr
          ? {
              sttMode: mode,
              sttModelId: modelId as LocalAsrModelId,
              onlineSttModelRef: onlineModelRef,
            }
          : {
              ttsMode: mode,
              ttsModelId: modelId as LocalTtsModelId,
              ttsVoiceId,
              onlineTtsModelRef: onlineModelRef,
              onlineTtsVoice: onlineVoice,
            },
      });
      if (mounted.current) onClose();
    } catch {
      if (mounted.current) setError(i18nService.t('speechExtensionSaveFailed'));
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  if (hidden) return null;

  return createPortal(
    <Modal
      onClose={close}
      closeOnBackdrop={!saving}
      className="mx-4 w-full max-w-[540px] overflow-hidden rounded-2xl border border-border bg-surface text-foreground shadow-2xl"
    >
      <div
        ref={form}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="speech-extension-settings-title"
        className="flex max-h-[calc(100dvh-2rem)] flex-col outline-none"
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            close();
          }
          if (event.key === 'Tab') {
            const fields = Array.from(
              form.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled), [tabindex="0"]',
              ) ?? [],
            );
            const first = fields[0];
            const last = fields[fields.length - 1];
            if (
              event.shiftKey &&
              (ownerDocument.activeElement === first ||
                ownerDocument.activeElement === form.current)
            ) {
              event.preventDefault();
              last?.focus();
            } else if (
              !event.shiftKey &&
              (ownerDocument.activeElement === last || ownerDocument.activeElement === form.current)
            ) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header className="flex shrink-0 items-start gap-3 px-5 pb-4 pt-5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-muted text-primary">
            <Cog6ToothIcon className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="speech-extension-settings-title" className="text-base font-semibold">
              {name} · {i18nService.t('speechExtensionModelSettings')}
            </h2>
            <p className="mt-1 text-xs leading-5 text-secondary">
              {i18nService.t('speechExtensionModelHelp')}
            </p>
          </div>
          <button
            type="button"
            aria-label={i18nService.t('close')}
            onClick={close}
            disabled={saving}
            className="rounded-lg p-1.5 text-secondary hover:bg-surface-raised disabled:opacity-50"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 space-y-4 overflow-y-auto bg-background px-5 py-4 [&_label]:w-24 [&_label]:shrink-0 [&_label]:whitespace-normal">
          <ThemedSelect
            id="speech-extension-mode"
            value={mode}
            label={i18nService.t(asr ? 'voiceRecognitionMode' : 'voiceSynthesisMode')}
            ariaLabel={i18nService.t(asr ? 'voiceRecognitionMode' : 'voiceSynthesisMode')}
            disabled={saving}
            onChange={next => setMode(next as 'local' | 'online')}
            options={[
              {
                value: 'local',
                label: i18nService.t(asr ? 'voiceRecognitionModeLocal' : 'voiceSynthesisModeLocal'),
              },
              {
                value: 'online',
                label: i18nService.t(
                  asr ? 'voiceRecognitionModeOnline' : 'voiceSynthesisModeOnline',
                ),
              },
            ]}
          />
          {mode === 'local' ? (
            <>
              <ThemedSelect
                id="speech-extension-model"
                value={modelId}
                label={i18nService.t(asr ? 'voiceRecognitionModel' : 'voiceSynthesisModel')}
                ariaLabel={i18nService.t(asr ? 'voiceRecognitionModel' : 'voiceSynthesisModel')}
                options={(asr ? LOCAL_ASR_MODEL_IDS : LOCAL_TTS_MODEL_IDS).map(id => ({
                  value: id,
                  label: i18nService.t(modelKeys[id]),
                }))}
                disabled={saving}
                onChange={id => {
                  if (id === modelId) return;
                  setModelId(id);
                  if (!asr) setTtsVoiceId(getLocalTtsDefaultVoiceId(id as LocalTtsModelId));
                }}
              />
              {!asr && (
                <ThemedSelect
                  id="speech-extension-voice"
                  value={String(ttsVoiceId)}
                  label={i18nService.t('voiceSpeaker')}
                  ariaLabel={i18nService.t('voiceSpeaker')}
                  options={getLocalSpeechVoiceOptions(modelId, key => i18nService.t(key))}
                  disabled={saving}
                  onChange={id => setTtsVoiceId(Number(id))}
                />
              )}
              <LocalSpeechModelStatusView
                showModelId={false}
                status={status}
                loading={models.loading}
                showInstallAction={false}
                onRetry={models.retry}
              />
            </>
          ) : (
            <>
              <ThemedSelect
                id="speech-extension-online-model"
                value={onlineModelRef}
                label={i18nService.t(asr ? 'voiceRecognitionModel' : 'voiceSynthesisModel')}
                ariaLabel={i18nService.t(asr ? 'voiceRecognitionModel' : 'voiceSynthesisModel')}
                disabled={saving || onlineOptions.length === 0}
                options={[
                  {
                    value: '',
                    label: i18nService.t(
                      onlineOptions.length ? 'voiceSelectModel' : 'voiceNoOnlineModelsConfigured',
                    ),
                  },
                  ...(!modelAvailable && onlineModelRef
                    ? [
                        {
                          value: onlineModelRef,
                          label: i18nService.t('speechOnlineSelectionUnavailable'),
                          disabled: true,
                        },
                      ]
                    : []),
                  ...onlineOptions,
                ]}
                onChange={reference => {
                  if (reference === onlineModelRef) return;
                  setOnlineModelRef(reference);
                  if (!asr) setOnlineVoice('');
                }}
              />
              {!asr && (
                <ThemedSelect
                  id="speech-extension-online-voice"
                  value={onlineVoice}
                  label={i18nService.t('voiceSpeaker')}
                  ariaLabel={i18nService.t('voiceSpeaker')}
                  disabled={saving || !modelAvailable || onlineVoiceOptions.length === 0}
                  options={[
                    {
                      value: '',
                      label: i18nService.t(
                        onlineVoiceOptions.length
                          ? 'voiceSelectSpeaker'
                          : 'voiceNoSpeakersConfigured',
                      ),
                    },
                    ...(!voiceAvailable && onlineVoice
                      ? [
                          {
                            value: onlineVoice,
                            label: i18nService.t('speechOnlineVoiceUnavailable'),
                            disabled: true,
                          },
                        ]
                      : []),
                    ...onlineVoiceOptions,
                  ]}
                  onChange={setOnlineVoice}
                />
              )}
              {asr && (
                <p className="text-xs leading-5 text-secondary">
                  {i18nService.t('speechFileTranscriptionDescription')}
                </p>
              )}
              {onlineError && (
                <p role="alert" className="text-xs text-secondary">
                  {onlineError}
                </p>
              )}
            </>
          )}
          {onManageModels && (
            <div className="space-y-2">
              <p className="text-xs leading-5 text-secondary">
                {i18nService.t(
                  mode === 'local'
                    ? 'speechModelCatalogDescription'
                    : 'speechOnlineCatalogDescription',
                )}
              </p>
              <button
                type="button"
                disabled={saving}
                onClick={() =>
                  mode === 'local'
                    ? onManageModels(kind)
                    : onManageModels(kind, {
                        source: 'online',
                        providerId: selectedOnlineModel?.providerId,
                      })
                }
                className="text-sm font-medium text-primary hover:underline disabled:opacity-50"
              >
                {i18nService.t('speechManageModels')}
              </button>
            </div>
          )}
          {mode === 'local' && !models.loading && !models.supported && (
            <p role="alert" className="text-sm text-secondary">
              {i18nService.t('voiceModelUnavailable')}
            </p>
          )}
          {mode === 'local' && models.error && (
            <div role="alert" className="text-sm text-red-500">
              {models.error}{' '}
              <button type="button" onClick={models.retry} className="text-primary hover:underline">
                {i18nService.t('retry')}
              </button>
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-red-500">
              {error}
            </p>
          )}
        </div>
        <footer className="flex shrink-0 justify-end gap-2 border-t border-border px-5 py-4">
          <button
            type="button"
            disabled={saving}
            onClick={close}
            className="rounded-lg px-4 py-2 text-sm text-secondary hover:bg-surface-raised"
          >
            {i18nService.t('cancel')}
          </button>
          <button
            type="button"
            disabled={
              saving ||
              (mode === 'local'
                ? !models.supported ||
                  models.loading ||
                  Boolean(models.error) ||
                  status?.phase !== 'ready'
                : Boolean(onlineError))
            }
            onClick={() => void save()}
            className="rounded-lg bg-primary px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {i18nService.t(saving ? 'saving' : 'save')}
          </button>
        </footer>
      </div>
    </Modal>,
    ownerDocument.body,
  );
}
