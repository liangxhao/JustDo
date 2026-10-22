import { Cog6ToothIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { LOCAL_ASR_MODEL_IDS, type LocalAsrModelId } from '@shared/speech/localAsr';
import { normalizeLocalSpeechExtensionSettings } from '@shared/speech/localSpeechExtensionSettings';
import { LocalSpeechModelKind } from '@shared/speech/localSpeechModels';
import { LOCAL_TTS_MODEL_IDS, type LocalTtsModelId } from '@shared/speech/localTts';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import LocalSpeechModelStatusView from '@/features/speech/LocalSpeechModelStatusView';
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
}: {
  kind: LocalSpeechModelKind;
  onClose: () => void;
}) {
  const ownerDocument = useOwnerDocument();
  const asr = kind === LocalSpeechModelKind.Asr;
  const name = asr ? 'stt-local-cli' : 'tts-local-cli';
  const key = asr ? 'sttModelId' : 'ttsModelId';
  const [modelId, setModelId] = useState<string>(
    () =>
      normalizeLocalSpeechExtensionSettings(configService.getConfig().localSpeechExtensions)[key],
  );
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
    form.current?.focus();
    return () => {
      mounted.current = false;
      previous?.focus();
    };
  }, [ownerDocument]);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await configService.updateConfig({
        localSpeechExtensions: { [key]: modelId },
      });
      if (mounted.current) onClose();
    } catch {
      if (mounted.current) setError(i18nService.t('speechExtensionSaveFailed'));
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

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
        <div className="min-h-0 space-y-4 overflow-y-auto bg-background px-5 py-4">
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
            onChange={setModelId}
          />
          <LocalSpeechModelStatusView
            showModelId={false}
            status={status}
            loading={models.loading}
            showInstallAction={models.supported && !models.loading && !models.error}
            onRetry={() => models.install(kind, modelId)}
          />
          {!models.loading && !models.supported && (
            <p role="alert" className="text-sm text-secondary">
              {i18nService.t('voiceModelUnavailable')}
            </p>
          )}
          {models.error && (
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
            disabled={saving || status?.phase !== 'ready'}
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
