import { describe, expect, it } from 'vitest';

import { LOCAL_TTS_MODEL_IDS } from './localTts';
import { parseBuiltinSpeechPreviewRequest } from './speechSynthesis';

const request = {
  requestId: 'preview-1',
  modelId: LOCAL_TTS_MODEL_IDS[0],
  voiceId: 102,
  text: '  你好。 Hello.  ',
};
describe('builtin speech preview request', () => {
  it('keeps explicit model/voice identity and trims bounded text without changing input', () => {
    expect(parseBuiltinSpeechPreviewRequest(request)).toEqual({
      ...request,
      text: '你好。 Hello.',
    });
    expect(request.text).toBe('  你好。 Hello.  ');
    expect(
      parseBuiltinSpeechPreviewRequest({
        ...request,
        modelId: LOCAL_TTS_MODEL_IDS[1],
        voiceId: 173,
      }).voiceId,
    ).toBe(173);
    expect(
      parseBuiltinSpeechPreviewRequest({ ...request, modelId: LOCAL_TTS_MODEL_IDS[2], voiceId: 0 })
        .voiceId,
    ).toBe(0);
  });
  it.each([
    null,
    [],
    {},
    { ...request, modelId: 'online-model' },
    { ...request, voiceId: '3' },
    { ...request, voiceId: -1 },
    { ...request, voiceId: 103 },
    { ...request, voiceId: 0.5 },
    { ...request, voiceId: NaN },
    { ...request, modelId: LOCAL_TTS_MODEL_IDS[1], voiceId: 174 },
    { ...request, modelId: LOCAL_TTS_MODEL_IDS[2], voiceId: 1 },
    { ...request, text: '' },
    { ...request, text: 'a'.repeat(301) },
    { ...request, text: 'test\0text' },
    { ...request, requestId: '' },
    { ...request, requestId: 'has space' },
    { ...request, requestId: 'a'.repeat(129) },
    { ...request, command: 'arbitrary.exe' },
  ])('rejects invalid preview input (%j)', input => {
    expect(() => parseBuiltinSpeechPreviewRequest(input)).toThrow(
      'Invalid builtin speech preview request.',
    );
  });
});
