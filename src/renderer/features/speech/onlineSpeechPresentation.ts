import type {
  OnlineSpeechModelBinding,
  OnlineSpeechModelKind,
  OnlineSpeechVoiceSelection,
} from '@shared/speech/onlineSpeechModels';

import { i18nService } from '@/services/i18n';

const protocolLabels: Record<OnlineSpeechModelBinding['protocolId'], string> = {
  'openai-transcription-http': 'speechProtocolRecorded',
  'openai-speech-http': 'speechProtocolSynthesis',
  'openai-transcription-realtime': 'speechProtocolRealtimeTranscription',
  'openai-voice-realtime': 'speechProtocolRealtimeVoice',
};

export const getSpeechProtocolLabel = (
  protocolId: OnlineSpeechModelBinding['protocolId'],
): string => i18nService.t(protocolLabels[protocolId]);

const providerProtocols: Record<OnlineSpeechModelKind, OnlineSpeechModelBinding['protocolId'][]> = {
  'speech-recognition': ['openai-transcription-http', 'openai-transcription-realtime'],
  'speech-synthesis': ['openai-speech-http'],
  'realtime-voice': ['openai-voice-realtime'],
};

export const getSpeechProviderProtocolOptions = (kind: OnlineSpeechModelKind) =>
  providerProtocols[kind].map(protocolId => ({
    value: protocolId,
    label: getSpeechProtocolLabel(protocolId),
  }));

export const getDefaultSpeechProviderProtocol = (kind: OnlineSpeechModelKind) => ({
  protocolId: providerProtocols[kind][0],
});

export const getSpeechProviderProtocolHint = (
  protocolId: OnlineSpeechModelBinding['protocolId'],
): string =>
  i18nService.t(
    {
      'openai-transcription-http': 'speechProviderProtocolRecordedHint',
      'openai-transcription-realtime': 'speechProviderProtocolTranscriptionHint',
      'openai-speech-http': 'speechProviderProtocolSynthesisHint',
      'openai-voice-realtime': 'speechProviderProtocolVoiceHint',
    }[protocolId],
  );

export const getSpeechVoiceOptionValue = (
  options: Array<{ value: string; selection: OnlineSpeechVoiceSelection }>,
  selection: OnlineSpeechVoiceSelection | null,
): string =>
  options.find(option => JSON.stringify(option.selection) === JSON.stringify(selection))?.value ??
  '';
