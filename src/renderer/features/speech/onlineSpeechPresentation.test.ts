import { describe, expect, it } from 'vitest';

import { i18nService } from '@/services/i18n';

import {
  getDefaultSpeechProviderProtocol,
  getSpeechProviderProtocolHint,
  getSpeechProviderProtocolOptions,
} from './onlineSpeechPresentation';

describe('speech provider presentation', () => {
  it('offers only category-compatible provider interfaces with a recorded HTTP default', () => {
    expect(
      getSpeechProviderProtocolOptions('speech-recognition').map(option => option.value),
    ).toEqual(['openai-transcription-http', 'openai-transcription-realtime']);
    expect(getDefaultSpeechProviderProtocol('speech-recognition')).toEqual({
      protocolId: 'openai-transcription-http',
    });
    expect(getSpeechProviderProtocolOptions('speech-synthesis')).toHaveLength(1);
    expect(getSpeechProviderProtocolOptions('realtime-voice')).toHaveLength(1);
    expect(getSpeechProviderProtocolHint('openai-speech-http')).toBe(
      i18nService.t('speechProviderProtocolSynthesisHint'),
    );
  });
});
