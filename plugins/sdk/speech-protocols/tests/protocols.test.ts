import { describe, expect, it } from 'vitest';

import {
  buildSpeechRequest, buildTranscriptionRequest, MAX_TRANSCRIPTION_AUDIO_BYTES,
  normalizeSpeechServiceBaseUrl, parseSpeechResponse, parseTranscriptionResponse,
  resolveSpeechProtocolSelection, resolveSpeechVoiceSelection, SPEECH_PROTOCOL_IDS,
} from '../index';

const transcription = { protocolId: SPEECH_PROTOCOL_IDS.TRANSCRIPTION_HTTP };
const speech = { protocolId: SPEECH_PROTOCOL_IDS.SPEECH_HTTP };

describe('generic speech protocol contracts', () => {
  it('exposes four protocols and keeps each consumer legacy default separate', () => {
    expect(Object.values(SPEECH_PROTOCOL_IDS)).toEqual([
      'openai-transcription-http', 'openai-speech-http',
      'openai-transcription-realtime', 'openai-voice-realtime',
    ]);
    expect(resolveSpeechProtocolSelection({}, 'transcription', transcription.protocolId)).toEqual(transcription);
    expect(resolveSpeechProtocolSelection({}, 'speech', speech.protocolId)).toEqual(speech);
    for (const value of [{ protocolId: 'unknown' }, { protocolId: null }, speech,
      { protocolId: 'chat-audio-transcription' }, { protocolId: 'chat-audio-speech' }])
      expect(() => resolveSpeechProtocolSelection(value, 'transcription', transcription.protocolId)).toThrow();
  });

  it('rejects removed configuration fields before any legacy default, including an undefined own field', () => {
    for (const compatibilityProfile of ['removed', null, undefined]) {
      expect(() => resolveSpeechProtocolSelection({ compatibilityProfile }, 'speech', speech.protocolId)).toThrow();
      expect(() => resolveSpeechProtocolSelection({ ...speech, compatibilityProfile }, 'speech')).toThrow();
    }
  });

  it('preserves deployment prefixes and rejects a different complete endpoint', () => {
    expect(normalizeSpeechServiceBaseUrl('https://service/prefix/v3/audio/transcriptions/', transcription)).toBe('https://service/prefix/v3');
    expect(normalizeSpeechServiceBaseUrl('http://127.0.0.1:8000/team/audio/speech', speech)).toBe('http://127.0.0.1:8000/team');
    for (const url of ['https://user:password@service/v1', 'http://service/v1?key=x',
      'http://service/#fragment', 'ws://service/v1', 'http://service/audio/speech', 'http://service/chat/completions'])
      expect(() => normalizeSpeechServiceBaseUrl(url, transcription)).toThrow();
  });

  it('uploads bounded audio through multipart without restricting standard language codes', () => {
    const audio = new Uint8Array([1, 2, 3]);
    expect(buildTranscriptionRequest({ selection: transcription, model: 'company/model', audio, language: 'auto' })).toEqual({
      kind: 'multipart', path: '/audio/transcriptions', fields: { model: 'company/model' },
      file: { bytes: audio, fileName: 'audio.wav', mimeType: 'audio/wav' },
    });
    expect(buildTranscriptionRequest({ selection: transcription, model: 'company/model', audio, language: 'ja' }).fields)
      .toEqual({ model: 'company/model', language: 'ja' });
    expect(() => buildTranscriptionRequest({ selection: transcription, model: 'model', audio: new Uint8Array(MAX_TRANSCRIPTION_AUDIO_BYTES + 1) })).toThrow();
    expect(parseTranscriptionResponse(transcription, { text: ' result ' })).toBe('result');
    expect(() => parseTranscriptionResponse(transcription, { choices: [{ message: { content: 'Wrong contract' } }] })).toThrow();
  });

  it('sends explicit preset speech as standard JSON and rejects removed voice workflows', () => {
    expect(buildSpeechRequest({ selection: speech, model: 'any/model', text: 'read this',
      voiceSelection: { kind: 'preset', voiceId: 'voice42' }, format: 'opus', speed: 1.1, instructions: 'Calm' })).toEqual({
      kind: 'json', path: '/audio/speech', outputFormat: 'opus', responseKind: 'binary',
      body: { model: 'any/model', input: 'read this', voice: 'voice42', response_format: 'opus', speed: 1.1, instructions: 'Calm' },
    });
    expect(resolveSpeechVoiceSelection(undefined, speech, 'preset', 'existing')).toEqual({ kind: 'preset', voiceId: 'existing' });
    for (const value of [null, { kind: 'service-default' }, { kind: 'preset', voiceId: '' }])
      expect(() => resolveSpeechVoiceSelection(value, speech, 'preset', 'existing')).toThrow();
    expect(() => resolveSpeechVoiceSelection({ kind: 'preset', voiceId: 'existing' }, speech, 'service-default')).toThrow();
  });

  it('accepts only bounded binary speech responses', () => {
    expect(parseSpeechResponse(speech, new Uint8Array([1, 2, 3]), 3)).toEqual(new Uint8Array([1, 2, 3]));
    for (const value of [new Uint8Array(), new Uint8Array([1, 2, 3, 4]), { choices: [{ message: { audio: { data: 'AQID' } } }] }])
      expect(() => parseSpeechResponse(speech, value, 3)).toThrow();
  });

  it('rejects invalid raw model and voice identifiers before trimming their control characters', () => {
    for (const value of ['', '\nconfigured', 'configured\n', 'x'.repeat(257)]) {
      expect(() => buildTranscriptionRequest({ selection: transcription, model: value, audio: new Uint8Array([1]) })).toThrow();
      expect(() => resolveSpeechVoiceSelection({ kind: 'preset', voiceId: value }, speech)).toThrow();
    }
  });
});
