import './VoiceSettingsTab.css';

import { CheckCircleIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { EnginePhase } from '@shared/openclaw/engineStatus';
import {
  isLocalAsrLanguageSupported,
  LOCAL_ASR_MODEL_IDS,
  type LocalAsrModelId,
} from '@shared/speech/localAsr';
import { LocalSpeechModelKind } from '@shared/speech/localSpeechModels';
import {
  getSpeechSynthesisSettingsKey,
  LOCAL_SPEECH_MAX_MEETING_SEGMENT_SECONDS,
  LOCAL_SPEECH_MAX_RATE,
  LOCAL_SPEECH_MAX_RECORDING_SECONDS,
  LOCAL_SPEECH_MAX_THREADS,
  LOCAL_SPEECH_MIN_MEETING_SEGMENT_SECONDS,
  LOCAL_SPEECH_MIN_RATE,
  LOCAL_SPEECH_MIN_RECORDING_SECONDS,
  LOCAL_SPEECH_MIN_THREADS,
  type LocalSpeechSettings,
} from '@shared/speech/localSpeechSettings';
import {
  getLocalTtsDefaultVoiceId,
  LOCAL_TTS_MODEL_IDS,
  type LocalTtsModelId,
} from '@shared/speech/localTts';
import type { OnlineAsrStatus } from '@shared/speech/onlineAsr';
import {
  getOnlineSpeechModelOptions,
  getOnlineSpeechVoiceSelectionOptions,
  ONLINE_SPEECH_PROVIDER_BINDING_ID,
  resolveOnlineSpeechBinding,
  resolveOnlineSpeechModel,
} from '@shared/speech/onlineSpeechModels';
import type { OnlineTtsStatus } from '@shared/speech/onlineTts';
import React, { useEffect, useRef, useState } from 'react';

import { getLocalSpeechVoiceOptions } from '@/features/speech/localSpeechModelCatalog';
import ModelStatus from '@/features/speech/LocalSpeechModelStatusView';
import {
  getSpeechProtocolLabel,
  getSpeechVoiceOptionValue,
} from '@/features/speech/onlineSpeechPresentation';
import type { SpeechModelCatalogTarget } from '@/features/speech/speechModelCatalogNavigation';
import { useLocalSpeechModels } from '@/features/speech/useLocalSpeechModels';
import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';
import ThemedSelect from '@/shared/components/ui/ThemedSelect';

import RealtimeVoiceSettings from './RealtimeVoiceSettings';
import VoiceInputDiagnostics from './VoiceInputDiagnostics';
import VoiceOutputDiagnostics from './VoiceOutputDiagnostics';

interface VoiceSettingsTabProps {
  value: LocalSpeechSettings;
  onChange: (value: LocalSpeechSettings) => void;
  onManageModels?: (kind: LocalSpeechModelKind, target?: SpeechModelCatalogTarget) => void;
  onManageRealtimeModels?: () => void;
}

const ASR_MODEL_KEYS: Record<LocalAsrModelId, string> = {
  'sherpa-onnx-whisper-base': 'voiceAsrModelWhisperBase',
  'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09': 'voiceAsrModelSenseVoice',
};

const TTS_MODEL_KEYS: Record<LocalTtsModelId, string> = {
  'kokoro-int8-multi-lang-v1_1': 'voiceTtsModelKokoro',
  'vits-icefall-zh-aishell3': 'voiceTtsModelAishell3',
  'vits-piper-en_US-lessac-medium-int8': 'voiceTtsModelPiperEnglish',
};

const SettingSwitch: React.FC<{
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}> = ({ checked, label, disabled, onChange }) => (
  <button
    type="button"
    role="switch"
    aria-label={label}
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
      checked ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'
    } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
  >
    <span
      className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${
        checked ? 'translate-x-6' : 'translate-x-1'
      }`}
    />
  </button>
);

const NumberSetting: React.FC<{
  id: string;
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}> = ({ id, label, description, value, min, max, step = 1, suffix, disabled, onChange }) => (
  <div className={`voice-setting-row ${disabled ? 'opacity-50' : ''}`}>
    <div>
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      <p className="mt-1 text-xs leading-5 text-secondary">{description}</p>
    </div>
    <div className="flex shrink-0 items-center gap-2">
      <input
        id={id}
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={event => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(Math.min(max, Math.max(min, next)));
        }}
        className="h-9 w-24 rounded-lg border border-border bg-surface px-3 text-right text-sm text-foreground outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed"
      />
      <span className="w-12 text-xs text-secondary">{suffix}</span>
    </div>
  </div>
);

const VoiceSettingsTab: React.FC<VoiceSettingsTabProps> = ({
  value,
  onChange,
  onManageModels,
  onManageRealtimeModels,
}) => {
  const { statuses, loading, retry } = useLocalSpeechModels();
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([]);
  const [microphoneRefreshKey, setMicrophoneRefreshKey] = useState(0);
  const [onlineStatus, setOnlineStatus] = useState<OnlineAsrStatus | null>(null);
  const [onlineStatusLoading, setOnlineStatusLoading] = useState(false);
  const [onlineTtsStatus, setOnlineTtsStatus] = useState<OnlineTtsStatus | null>(null);
  const [onlineTtsStatusLoading, setOnlineTtsStatusLoading] = useState(false);
  const valueRef = useRef(value);
  const asrStatusGenerationRef = useRef(0);
  const ttsStatusGenerationRef = useRef(0);
  valueRef.current = value;
  const update = (patch: Partial<LocalSpeechSettings>) =>
    onChange({ ...valueRef.current, ...patch });
  const [savedConfig, setSavedConfig] = useState(() => configService.getConfig());
  useEffect(() => {
    const refresh = () => setSavedConfig(configService.getConfig());
    window.addEventListener('config-updated', refresh);
    return () => window.removeEventListener('config-updated', refresh);
  }, []);
  const onlineModelProviders = savedConfig.onlineModelProviders;
  const synthesisNeedsSave =
    getSpeechSynthesisSettingsKey(value) !== getSpeechSynthesisSettingsKey(savedConfig.voice);
  const recognitionCategory = onlineModelProviders?.['speech-recognition'];
  const synthesisCategory = onlineModelProviders?.['speech-synthesis'];
  const recognitionModelOptions = getOnlineSpeechModelOptions(recognitionCategory, {
    purpose: 'composer-asr',
  });
  const synthesisModelOptions = getOnlineSpeechModelOptions(synthesisCategory, {
    requireHttp: true,
    purpose: 'tts',
  });
  const resolveSelectedModel = (
    options: Array<{ value: string; label: string }>,
    savedReference: string,
  ): string => (options.some(option => option.value === savedReference) ? savedReference : '');
  const selectedRecognitionModel = resolveSelectedModel(
    recognitionModelOptions,
    value.onlineAsrModelRef,
  );
  const recognitionBinding = resolveOnlineSpeechBinding(
    recognitionCategory,
    selectedRecognitionModel,
    value.onlineAsrBindingId,
    'composer-asr',
  );
  const onlineAsrConfigured = Boolean(recognitionBinding);
  const recognitionNeedsSave =
    JSON.stringify([
      value.inputEnabled,
      value.recognitionMode,
      value.onlineAsrModelRef,
      value.onlineAsrBindingId,
    ]) !==
    JSON.stringify([
      savedConfig.voice.inputEnabled,
      savedConfig.voice.recognitionMode,
      savedConfig.voice.onlineAsrModelRef,
      savedConfig.voice.onlineAsrBindingId,
    ]);
  const selectedSynthesisModel = resolveSelectedModel(
    synthesisModelOptions,
    value.onlineTtsModelRef,
  );
  const selectedSynthesisProvider = resolveOnlineSpeechBinding(
    synthesisCategory,
    selectedSynthesisModel,
    value.onlineTtsBindingId,
    'tts',
  );
  const synthesisVoiceOptions = getOnlineSpeechVoiceSelectionOptions(
    selectedSynthesisProvider?.model,
    selectedSynthesisProvider?.binding,
  );
  const selectedSynthesisVoice = getSpeechVoiceOptionValue(
    synthesisVoiceOptions,
    value.onlineTtsVoiceSelection,
  );
  const synthesisVoiceUnavailable = Boolean(
    value.onlineTtsVoiceSelection && !selectedSynthesisVoice,
  );
  const onlineTtsConfigured = Boolean(selectedSynthesisModel && selectedSynthesisVoice);
  const applyOnlineRecognitionModel = (reference: string): void => {
    if (reference === valueRef.current.onlineAsrModelRef) return;
    const provider = resolveOnlineSpeechModel(recognitionCategory, reference)?.provider;
    const bindingId = Object.prototype.hasOwnProperty.call(provider ?? {}, 'protocolId')
      ? ONLINE_SPEECH_PROVIDER_BINDING_ID
      : '';
    update({ onlineAsrModelRef: reference, onlineAsrBindingId: bindingId });
  };
  const applyOnlineSynthesisModel = (reference: string): void => {
    if (reference === valueRef.current.onlineTtsModelRef) return;
    const provider = resolveOnlineSpeechModel(synthesisCategory, reference)?.provider;
    const bindingId = Object.prototype.hasOwnProperty.call(provider ?? {}, 'protocolId')
      ? ONLINE_SPEECH_PROVIDER_BINDING_ID
      : '';
    update({
      onlineTtsModelRef: reference,
      onlineTtsBindingId: bindingId,
      onlineTtsVoice: '',
      onlineTtsVoiceSelection: null,
    });
  };
  const applyOnlineSynthesisVoice = (voice: string): void => {
    const selection =
      synthesisVoiceOptions.find(option => option.value === voice)?.selection ?? null;
    update({
      onlineTtsVoice: selection?.kind === 'preset' ? selection.voiceId : '',
      onlineTtsVoiceSelection: selection,
    });
  };
  const asrStatus = statuses.find(status => status.id === value.asrModelId) ?? null;
  const ttsStatus = statuses.find(status => status.id === value.ttsModelId) ?? null;

  useEffect(() => {
    const generation = ++asrStatusGenerationRef.current;
    if (value.recognitionMode !== 'online') {
      setOnlineStatus(null);
      setOnlineStatusLoading(false);
      return;
    }
    let active = true;
    setOnlineStatusLoading(true);
    void window.electron.onlineAsr
      .getStatus()
      .then(status => {
        if (active && generation === asrStatusGenerationRef.current) setOnlineStatus(status);
      })
      .catch(error => {
        if (active && generation === asrStatusGenerationRef.current) {
          setOnlineStatus({
            available: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })
      .finally(() => {
        if (active && generation === asrStatusGenerationRef.current) {
          setOnlineStatusLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [value.recognitionMode]);

  useEffect(() => {
    if (value.synthesisMode !== 'online') {
      ttsStatusGenerationRef.current += 1;
      setOnlineTtsStatus(null);
      setOnlineTtsStatusLoading(false);
      return;
    }
    let active = true;
    const refresh = () => {
      const generation = ++ttsStatusGenerationRef.current;
      setOnlineTtsStatusLoading(true);
      void window.electron.onlineTts
        .getStatus()
        .then(status => {
          if (active && generation === ttsStatusGenerationRef.current) setOnlineTtsStatus(status);
        })
        .catch(() => {
          if (active && generation === ttsStatusGenerationRef.current)
            setOnlineTtsStatus({ available: false });
        })
        .finally(() => {
          if (active && generation === ttsStatusGenerationRef.current)
            setOnlineTtsStatusLoading(false);
        });
    };
    refresh();
    window.addEventListener('config-updated', refresh);
    const unsubscribeEngine = window.electron.openclaw?.engine?.onProgress?.(status => {
      if (status.phase === EnginePhase.Running) refresh();
      else {
        ttsStatusGenerationRef.current += 1;
        setOnlineTtsStatus(null);
        setOnlineTtsStatusLoading(false);
      }
    });
    return () => {
      active = false;
      ttsStatusGenerationRef.current += 1;
      window.removeEventListener('config-updated', refresh);
      unsubscribeEngine?.();
    };
  }, [value.synthesisMode]);

  useEffect(() => {
    if (!value.inputEnabled || !navigator.mediaDevices?.enumerateDevices) return;
    let active = true;
    const refresh = () => {
      void navigator.mediaDevices
        .enumerateDevices()
        .then(devices => {
          if (!active) return;
          const seen = new Set<string>();
          setMicrophones(
            devices.filter(device => {
              const id = device.deviceId.trim();
              if (device.kind !== 'audioinput' || !id || id === 'default' || seen.has(id)) {
                return false;
              }
              seen.add(id);
              return true;
            }),
          );
        })
        .catch(() => {
          if (active) setMicrophones([]);
        });
    };
    refresh();
    navigator.mediaDevices.addEventListener('devicechange', refresh);
    return () => {
      active = false;
      navigator.mediaDevices.removeEventListener('devicechange', refresh);
    };
  }, [microphoneRefreshKey, value.inputEnabled]);

  return (
    <div className="voice-settings min-w-0 space-y-6">
      <section className="space-y-5 rounded-xl border border-border bg-surface p-5">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h4 className="text-sm font-semibold text-foreground">
              {i18nService.t('voiceInputTitle')}
            </h4>
            <p className="mt-1 text-xs leading-5 text-secondary">
              {i18nService.t('voiceInputDescription')}
            </p>
            {onManageModels && (
              <button
                type="button"
                onClick={() =>
                  value.recognitionMode === 'local'
                    ? onManageModels(LocalSpeechModelKind.Asr)
                    : onManageModels(LocalSpeechModelKind.Asr, {
                        source: 'online',
                        providerId: resolveOnlineSpeechModel(
                          recognitionCategory,
                          value.onlineAsrModelRef,
                        )?.providerId,
                      })
                }
                className="mt-2 text-xs font-medium text-primary hover:underline"
              >
                {i18nService.t('speechManageModels')}
              </button>
            )}
          </div>
          <SettingSwitch
            checked={value.inputEnabled}
            label={i18nService.t('voiceInputEnabled')}
            onChange={inputEnabled => {
              update({ inputEnabled });
            }}
          />
        </div>
        {value.recognitionMode === 'local' ? (
          <ModelStatus
            status={asrStatus}
            loading={loading}
            showInstallAction={false}
            onRetry={retry}
          />
        ) : (
          <div
            className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-secondary"
            role="status"
          >
            {onlineStatusLoading ? (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : onlineAsrConfigured ? (
              <CheckCircleIcon className="h-4 w-4 text-green-500" />
            ) : (
              <ExclamationTriangleIcon className="h-4 w-4 text-amber-500" />
            )}
            <span>
              {onlineStatusLoading
                ? i18nService.t('voiceOnlineChecking')
                : onlineAsrConfigured && recognitionNeedsSave
                  ? i18nService.t('speechSettingsNeedSave')
                  : onlineAsrConfigured && onlineStatus?.available
                    ? i18nService.t('voiceOnlineReady')
                    : onlineAsrConfigured
                      ? i18nService.t('voiceOnlineConfigured')
                      : i18nService.t('voiceOnlineUnavailable')}
            </span>
          </div>
        )}
        <div className="border-t border-border pt-5">
          <div className="mb-5 voice-setting-row">
            <div>
              <label
                htmlFor="voice-recognition-mode"
                className="text-sm font-medium text-foreground"
              >
                {i18nService.t('voiceRecognitionMode')}
              </label>
              <p className="mt-1 text-xs leading-5 text-secondary">
                {i18nService.t('voiceRecognitionModeDescription')}
              </p>
            </div>
            <div className="voice-setting-control">
              <ThemedSelect
                id="voice-recognition-mode"
                value={value.recognitionMode}
                onChange={recognitionMode => {
                  const nextMode = recognitionMode as LocalSpeechSettings['recognitionMode'];
                  update({
                    recognitionMode: nextMode,
                    ...(nextMode === 'online' && value.inputLanguage === 'yue'
                      ? { inputLanguage: 'app' as const }
                      : {}),
                  });
                }}
                options={[
                  { value: 'local', label: i18nService.t('voiceRecognitionModeLocal') },
                  { value: 'online', label: i18nService.t('voiceRecognitionModeOnline') },
                ]}
              />
            </div>
          </div>
          {value.recognitionMode === 'local' ? (
            <div className="mb-5 voice-setting-row">
              <div>
                <label htmlFor="voice-asr-model" className="text-sm font-medium text-foreground">
                  {i18nService.t('voiceRecognitionModel')}
                </label>
                <p className="mt-1 text-xs leading-5 text-secondary">
                  {i18nService.t('speechModelCatalogDescription')}
                </p>
              </div>
              <div className="voice-setting-control">
                <ThemedSelect
                  id="voice-asr-model"
                  value={value.asrModelId}
                  disabled={!value.inputEnabled}
                  onChange={asrModelId => {
                    const nextModelId = asrModelId as LocalAsrModelId;
                    update({
                      asrModelId: nextModelId,
                      ...(!isLocalAsrLanguageSupported(nextModelId, value.inputLanguage)
                        ? { inputLanguage: 'app' as const }
                        : {}),
                    });
                  }}
                  options={LOCAL_ASR_MODEL_IDS.map(modelId => ({
                    value: modelId,
                    label: i18nService.t(ASR_MODEL_KEYS[modelId]),
                  }))}
                />
              </div>
            </div>
          ) : (
            <div className="mb-5 voice-setting-row">
              <div>
                <label
                  htmlFor="voice-online-asr-model"
                  className="text-sm font-medium text-foreground"
                >
                  {i18nService.t('voiceRecognitionModel')}
                </label>
                <p className="mt-1 text-xs leading-5 text-secondary">
                  {i18nService.t('voiceOnlineModelSelectionDescription')}
                </p>
              </div>
              <div className="voice-setting-control">
                <ThemedSelect
                  id="voice-online-asr-model"
                  value={selectedRecognitionModel}
                  disabled={!value.inputEnabled || recognitionModelOptions.length === 0}
                  onChange={applyOnlineRecognitionModel}
                  options={
                    recognitionModelOptions.length > 0
                      ? [
                          { value: '', label: i18nService.t('voiceSelectModel') },
                          ...recognitionModelOptions,
                        ]
                      : [{ value: '', label: i18nService.t('voiceNoOnlineModelsConfigured') }]
                  }
                />
              </div>
            </div>
          )}
          {value.recognitionMode === 'online' && value.onlineAsrModelRef.trim() ? (
            <p className="mb-5 text-xs leading-5 text-secondary">
              {recognitionBinding
                ? i18nService
                    .t('speechCurrentProtocol')
                    .replace(
                      '{protocol}',
                      getSpeechProtocolLabel(recognitionBinding.binding.protocolId),
                    )
                : i18nService.t('speechConfigureInterfaceInModels')}
            </p>
          ) : null}
          <div className="mb-5 voice-setting-row">
            <div>
              <label htmlFor="voice-input-source" className="text-sm font-medium text-foreground">
                {i18nService.t('voiceInputSource')}
              </label>
              <p className="mt-1 text-xs leading-5 text-secondary">
                {i18nService.t('voiceInputSourceDescription')}
              </p>
            </div>
            <div className="voice-setting-control">
              <ThemedSelect
                id="voice-input-source"
                value={value.inputSource}
                disabled={!value.inputEnabled}
                onChange={inputSource =>
                  update({ inputSource: inputSource as LocalSpeechSettings['inputSource'] })
                }
                options={[
                  { value: 'microphone', label: i18nService.t('voiceInputSourceMicrophone') },
                  { value: 'system', label: i18nService.t('voiceInputSourceSystem') },
                  { value: 'microphone-system', label: i18nService.t('voiceInputSourceMixed') },
                ]}
              />
            </div>
          </div>
          {(value.inputSource === 'microphone' || value.inputSource === 'microphone-system') && (
            <div className="mb-5 voice-setting-row">
              <div>
                <label htmlFor="voice-input-device" className="text-sm font-medium text-foreground">
                  {i18nService.t('voiceInputDevice')}
                </label>
                <p className="mt-1 text-xs leading-5 text-secondary">
                  {i18nService.t('voiceInputDeviceDescription')}
                </p>
              </div>
              <div className="voice-setting-control">
                <ThemedSelect
                  id="voice-input-device"
                  value={value.inputDeviceId}
                  disabled={!value.inputEnabled}
                  onChange={inputDeviceId => update({ inputDeviceId })}
                  options={[
                    { value: '', label: i18nService.t('voiceInputDeviceDefault') },
                    ...(value.inputDeviceId &&
                    !microphones.some(device => device.deviceId === value.inputDeviceId)
                      ? [
                          {
                            value: value.inputDeviceId,
                            label: i18nService.t('voiceInputDeviceDisconnected'),
                          },
                        ]
                      : []),
                    ...microphones.map((device, index) => ({
                      value: device.deviceId,
                      label: device.label || `${i18nService.t('voiceInputDevice')} ${index + 1}`,
                    })),
                  ]}
                />
              </div>
            </div>
          )}
          {
            <div className="voice-setting-row">
              <div>
                <label
                  htmlFor="voice-input-language"
                  className="text-sm font-medium text-foreground"
                >
                  {i18nService.t('voiceRecognitionLanguage')}
                </label>
                <p className="mt-1 text-xs leading-5 text-secondary">
                  {i18nService.t('voiceRecognitionLanguageDescription')}
                </p>
              </div>
              <div className="voice-setting-control">
                <ThemedSelect
                  id="voice-input-language"
                  value={value.inputLanguage}
                  disabled={!value.inputEnabled}
                  onChange={inputLanguage =>
                    update({ inputLanguage: inputLanguage as LocalSpeechSettings['inputLanguage'] })
                  }
                  options={[
                    { value: 'auto', label: i18nService.t('voiceLanguageAuto') },
                    { value: 'app', label: i18nService.t('voiceLanguageFollowApp') },
                    { value: 'zh', label: i18nService.t('chinese') },
                    { value: 'en', label: i18nService.t('english') },
                    ...(value.recognitionMode === 'local' &&
                    value.asrModelId.includes('sense-voice')
                      ? [{ value: 'yue', label: i18nService.t('cantonese') }]
                      : []),
                    { value: 'ja', label: i18nService.t('japanese') },
                    { value: 'ko', label: i18nService.t('korean') },
                  ]}
                />
              </div>
            </div>
          }
        </div>
        {value.inputEnabled &&
        value.recognitionMode === 'local' &&
        (value.inputSource === 'microphone' || value.inputSource === 'microphone-system') ? (
          <VoiceInputDiagnostics
            settings={value}
            modelReady={asrStatus?.phase === 'ready'}
            onMicrophoneAccess={() => setMicrophoneRefreshKey(current => current + 1)}
          />
        ) : null}
        <NumberSetting
          id="voice-max-recording"
          label={i18nService.t('voiceMaxRecording')}
          description={i18nService.t('voiceMaxRecordingDescription')}
          value={value.maxRecordingSeconds}
          min={LOCAL_SPEECH_MIN_RECORDING_SECONDS}
          max={LOCAL_SPEECH_MAX_RECORDING_SECONDS}
          suffix={i18nService.t('seconds')}
          disabled={!value.inputEnabled || value.meetingMode}
          onChange={maxRecordingSeconds => update({ maxRecordingSeconds })}
        />
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="text-sm font-medium text-foreground">
              {i18nService.t('voiceMeetingMode')}
            </div>
            <p className="mt-1 text-xs leading-5 text-secondary">
              {i18nService.t('voiceMeetingModeDescription')}
            </p>
          </div>
          <SettingSwitch
            checked={value.meetingMode}
            label={i18nService.t('voiceMeetingMode')}
            disabled={!value.inputEnabled}
            onChange={meetingMode => update({ meetingMode })}
          />
        </div>
        {value.meetingMode && value.recognitionMode === 'local' && (
          <NumberSetting
            id="voice-meeting-segment"
            label={i18nService.t('voiceMeetingSegment')}
            description={i18nService.t('voiceMeetingSegmentDescription')}
            value={value.meetingSegmentSeconds}
            min={LOCAL_SPEECH_MIN_MEETING_SEGMENT_SECONDS}
            max={LOCAL_SPEECH_MAX_MEETING_SEGMENT_SECONDS}
            suffix={i18nService.t('seconds')}
            disabled={!value.inputEnabled}
            onChange={meetingSegmentSeconds => update({ meetingSegmentSeconds })}
          />
        )}
        {value.recognitionMode === 'local' ? (
          <NumberSetting
            id="voice-recognition-threads"
            label={i18nService.t('voiceRecognitionThreads')}
            description={i18nService.t('voiceThreadsDescription')}
            value={value.recognitionThreads}
            min={LOCAL_SPEECH_MIN_THREADS}
            max={LOCAL_SPEECH_MAX_THREADS}
            suffix={i18nService.t('voiceThreadsUnit')}
            disabled={!value.inputEnabled}
            onChange={recognitionThreads => update({ recognitionThreads })}
          />
        ) : null}
      </section>

      <section className="space-y-5 rounded-xl border border-border bg-surface p-5">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h4 className="text-sm font-semibold text-foreground">
              {i18nService.t('voiceOutputTitle')}
            </h4>
            <p className="mt-1 text-xs leading-5 text-secondary">
              {i18nService.t('voiceOutputDescription')}
            </p>
            {onManageModels && (
              <button
                type="button"
                onClick={() =>
                  value.synthesisMode === 'local'
                    ? onManageModels(LocalSpeechModelKind.Tts)
                    : onManageModels(LocalSpeechModelKind.Tts, {
                        source: 'online',
                        providerId: selectedSynthesisProvider?.providerId,
                      })
                }
                className="mt-2 text-xs font-medium text-primary hover:underline"
              >
                {i18nService.t('speechManageModels')}
              </button>
            )}
          </div>
          <SettingSwitch
            checked={value.outputEnabled}
            label={i18nService.t('voiceOutputEnabled')}
            onChange={outputEnabled => {
              update({ outputEnabled });
            }}
          />
        </div>
        {value.synthesisMode === 'local' ? (
          <ModelStatus
            status={ttsStatus}
            loading={loading}
            showInstallAction={false}
            onRetry={retry}
          />
        ) : (
          <div
            className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-secondary"
            role="status"
          >
            {onlineTtsStatusLoading ? (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : onlineTtsConfigured ? (
              <CheckCircleIcon className="h-4 w-4 text-green-500" />
            ) : (
              <ExclamationTriangleIcon className="h-4 w-4 text-amber-500" />
            )}
            <span>
              {onlineTtsStatusLoading
                ? i18nService.t('voiceOnlineTtsChecking')
                : onlineTtsConfigured && !synthesisNeedsSave && onlineTtsStatus?.available
                  ? i18nService.t('voiceOnlineTtsReady')
                  : onlineTtsConfigured
                    ? i18nService.t('voiceOnlineTtsConfigured')
                    : i18nService.t('voiceOnlineTtsUnavailable')}
            </span>
          </div>
        )}
        <div className="border-t border-border pt-5">
          <div className="mb-5 voice-setting-row">
            <div>
              <label htmlFor="voice-synthesis-mode" className="text-sm font-medium text-foreground">
                {i18nService.t('voiceSynthesisMode')}
              </label>
              <p className="mt-1 text-xs leading-5 text-secondary">
                {i18nService.t('voiceSynthesisModeDescription')}
              </p>
            </div>
            <div className="voice-setting-control">
              <ThemedSelect
                id="voice-synthesis-mode"
                value={value.synthesisMode}
                onChange={synthesisMode => {
                  const nextMode = synthesisMode as LocalSpeechSettings['synthesisMode'];
                  update({ synthesisMode: nextMode });
                }}
                options={[
                  { value: 'local', label: i18nService.t('voiceSynthesisModeLocal') },
                  { value: 'online', label: i18nService.t('voiceSynthesisModeOnline') },
                ]}
              />
            </div>
          </div>
          {value.synthesisMode === 'local' ? (
            <>
              <div className="mb-5 voice-setting-row">
                <div>
                  <label htmlFor="voice-tts-model" className="text-sm font-medium text-foreground">
                    {i18nService.t('voiceSynthesisModel')}
                  </label>
                  <p className="mt-1 text-xs leading-5 text-secondary">
                    {i18nService.t('speechModelCatalogDescription')}
                  </p>
                </div>
                <div className="voice-setting-control">
                  <ThemedSelect
                    id="voice-tts-model"
                    value={value.ttsModelId}
                    disabled={!value.outputEnabled}
                    onChange={ttsModelId => {
                      if (ttsModelId === value.ttsModelId) return;
                      update({
                        ttsModelId: ttsModelId as LocalTtsModelId,
                        voiceId: getLocalTtsDefaultVoiceId(ttsModelId as LocalTtsModelId),
                      });
                    }}
                    options={LOCAL_TTS_MODEL_IDS.map(modelId => ({
                      value: modelId,
                      label: i18nService.t(TTS_MODEL_KEYS[modelId]),
                    }))}
                  />
                </div>
              </div>
              <div className="voice-setting-row">
                <div>
                  <label htmlFor="voice-speaker" className="text-sm font-medium text-foreground">
                    {i18nService.t('voiceSpeaker')}
                  </label>
                  <p className="mt-1 text-xs leading-5 text-secondary">
                    {i18nService.t('voiceSpeakerDescription')}
                  </p>
                </div>
                <div className="voice-setting-control">
                  <ThemedSelect
                    id="voice-speaker"
                    value={String(value.voiceId)}
                    disabled={!value.outputEnabled}
                    onChange={voiceId => update({ voiceId: Number(voiceId) })}
                    options={getLocalSpeechVoiceOptions(value.ttsModelId, key =>
                      i18nService.t(key),
                    )}
                  />
                </div>
              </div>
            </>
          ) : (
            <div className="space-y-5">
              <div className="voice-setting-row">
                <div>
                  <label
                    htmlFor="voice-online-tts-model"
                    className="text-sm font-medium text-foreground"
                  >
                    {i18nService.t('voiceSynthesisModel')}
                  </label>
                  <p className="mt-1 text-xs leading-5 text-secondary">
                    {i18nService.t('voiceOnlineModelSelectionDescription')}
                  </p>
                </div>
                <div className="voice-setting-control">
                  <ThemedSelect
                    id="voice-online-tts-model"
                    value={selectedSynthesisModel}
                    disabled={!value.outputEnabled || synthesisModelOptions.length === 0}
                    onChange={applyOnlineSynthesisModel}
                    options={
                      synthesisModelOptions.length > 0
                        ? [
                            { value: '', label: i18nService.t('voiceSelectModel') },
                            ...synthesisModelOptions,
                          ]
                        : [{ value: '', label: i18nService.t('voiceNoOnlineModelsConfigured') }]
                    }
                  />
                </div>
              </div>
              {value.onlineTtsModelRef.trim() ? (
                <p className="text-xs leading-5 text-secondary">
                  {selectedSynthesisProvider
                    ? i18nService
                        .t('speechCurrentProtocol')
                        .replace(
                          '{protocol}',
                          getSpeechProtocolLabel(selectedSynthesisProvider.binding.protocolId),
                        )
                    : i18nService.t('speechConfigureInterfaceInModels')}
                </p>
              ) : null}
              <div className="voice-setting-row">
                <div>
                  <label
                    htmlFor="voice-online-tts-speaker"
                    className="text-sm font-medium text-foreground"
                  >
                    {i18nService.t('voiceSpeaker')}
                  </label>
                  <p className="mt-1 text-xs leading-5 text-secondary">
                    {i18nService.t('voiceOnlineSpeakerDescription')}
                  </p>
                </div>
                <div className="voice-setting-control">
                  <ThemedSelect
                    id="voice-online-tts-speaker"
                    value={selectedSynthesisVoice}
                    disabled={!value.outputEnabled || synthesisVoiceOptions.length === 0}
                    onChange={applyOnlineSynthesisVoice}
                    options={
                      synthesisVoiceOptions.length > 0
                        ? [
                            {
                              value: '',
                              label: i18nService.t(
                                synthesisVoiceUnavailable
                                  ? 'speechOnlineVoiceUnavailable'
                                  : 'voiceSelectSpeaker',
                              ),
                            },
                            ...synthesisVoiceOptions,
                          ]
                        : [
                            {
                              value: '',
                              label: i18nService.t(
                                synthesisVoiceUnavailable
                                  ? 'speechOnlineVoiceUnavailable'
                                  : 'voiceNoSpeakersConfigured',
                              ),
                            },
                          ]
                    }
                  />
                </div>
              </div>
              {selectedSynthesisModel && synthesisVoiceOptions.length === 0 ? (
                <p className="text-xs leading-5 text-amber-600 dark:text-amber-400" role="status">
                  {i18nService.t('voiceSelectedModelNeedsVoices')}
                </p>
              ) : null}
            </div>
          )}
        </div>
        {value.synthesisMode === 'local' ? (
          <>
            <NumberSetting
              id="voice-speech-rate"
              label={i18nService.t('voiceSpeechRate')}
              description={i18nService.t('voiceSpeechRateDescription')}
              value={value.speechRate}
              min={LOCAL_SPEECH_MIN_RATE}
              max={LOCAL_SPEECH_MAX_RATE}
              step={0.1}
              suffix="×"
              disabled={!value.outputEnabled}
              onChange={speechRate => update({ speechRate })}
            />
            <NumberSetting
              id="voice-synthesis-threads"
              label={i18nService.t('voiceSynthesisThreads')}
              description={i18nService.t('voiceThreadsDescription')}
              value={value.synthesisThreads}
              min={LOCAL_SPEECH_MIN_THREADS}
              max={LOCAL_SPEECH_MAX_THREADS}
              suffix={i18nService.t('voiceThreadsUnit')}
              disabled={!value.outputEnabled}
              onChange={synthesisThreads => update({ synthesisThreads })}
            />
          </>
        ) : null}
        {value.outputEnabled ? (
          <VoiceOutputDiagnostics
            requiresSave={synthesisNeedsSave}
            available={
              value.synthesisMode === 'local'
                ? ttsStatus?.phase === 'ready'
                : onlineTtsConfigured && onlineTtsStatus?.available === true
            }
            configurationKey={JSON.stringify([
              getSpeechSynthesisSettingsKey(value),
              ...(value.synthesisMode === 'online'
                ? [
                    selectedSynthesisProvider?.provider.baseUrl,
                    selectedSynthesisProvider?.provider.apiKey,
                    selectedSynthesisProvider?.model.id,
                    selectedSynthesisVoice,
                  ]
                : []),
            ])}
          />
        ) : null}
      </section>
      <RealtimeVoiceSettings
        value={value}
        onChange={onChange}
        category={onlineModelProviders?.['realtime-voice']}
        onManageModels={onManageRealtimeModels}
      />
    </div>
  );
};

export default VoiceSettingsTab;
