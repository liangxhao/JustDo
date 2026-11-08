import { describe, expect, it } from 'vitest';

import {
  getOnlineSpeechBindingOptions,
  getOnlineSpeechModelOptions,
  getOnlineSpeechVoiceOptions,
  normalizeOnlineSpeechBaseUrl,
  normalizeOnlineSpeechVoiceSelection,
  ONLINE_SPEECH_PROVIDER_BINDING_ID,
  type OnlineSpeechModelCategory,
  type OnlineSpeechProviderProtocol,
  parseOnlineSpeechModelBindings,
  parseOnlineSpeechModelParameters,
  parseOnlineSpeechProviderProtocol,
  resolveOnlineSpeechBinding,
  resolveOnlineSpeechModel,
  resolveOnlineSpeechVoiceSelection,
} from './onlineSpeechModels';

const category = {
  providers: {
    internal: {
      displayName: ' Internal ',
      baseUrl: 'https://speech.internal/v1',
      apiKey: '',
      models: [
        {
          id: ' voice/model ',
          name: ' Speech ',
          voices: [
            { id: ' a ', name: ' Alice ' },
            { id: 'a', name: 'Duplicate' },
            { id: 'b', name: '' },
          ],
        },
        { id: 'voice/model', name: 'Duplicate' },
        { id: 'asr', name: '' },
      ],
    },
    realtime: {
      displayName: 'Realtime',
      baseUrl: 'wss://speech.internal/realtime',
      apiKey: '',
      models: [{ id: 'live', name: 'Live' }],
    },
  },
};

describe('provider speech protocol inheritance', () => {
  const speech: OnlineSpeechProviderProtocol = { protocolId: 'openai-speech-http' };
  const realtime: OnlineSpeechProviderProtocol = { protocolId: 'openai-voice-realtime' };
  const configured = (): OnlineSpeechModelCategory => ({
    providers: {
      office: {
        displayName: 'Office', baseUrl: 'https://speech.internal/team/v1', apiKey: '', ...speech,
        models: [
          { id: 'reader', name: 'Reader', voices: [{ id: 'alice', name: 'Alice' }], voicePolicy: 'preset',
            bindings: [{ id: 'old-speech', protocolId: 'openai-speech-http', voicePolicy: 'preset' }] },
          { id: 'other', name: 'Other', voices: [{ id: 'alice', name: 'Alice' }], voicePolicy: 'preset' },
        ],
      },
    },
  });

  it('inherits one provider protocol across models while preserving known old identities and model parameters', () => {
    const input = configured();
    const original = structuredClone(input);
    expect(getOnlineSpeechModelOptions(input, { purpose: 'tts', requireHttp: true })).toEqual([
      { value: 'office/reader', label: 'Office / Reader' },
      { value: 'office/other', label: 'Office / Other' },
    ]);
    const options = getOnlineSpeechBindingOptions(input, 'office/reader', 'tts');
    expect(options).toEqual([{ value: ONLINE_SPEECH_PROVIDER_BINDING_ID, label: speech.protocolId,
      binding: { id: ONLINE_SPEECH_PROVIDER_BINDING_ID, ...speech, voicePolicy: 'preset' }, ordinal: 1 }]);
    for (const id of ['', ONLINE_SPEECH_PROVIDER_BINDING_ID, 'old-speech']) {
      const selected = resolveOnlineSpeechBinding(input, 'office/reader', id, 'tts')!;
      expect(selected.binding).toEqual(options[0].binding);
      expect(resolveOnlineSpeechVoiceSelection(selected.model, selected.binding, { kind: 'preset', voiceId: 'alice' }))
        .toEqual({ kind: 'preset', voiceId: 'alice' });
    }
    expect(resolveOnlineSpeechBinding(input, 'office/other', '', 'tts')?.binding)
      .toEqual({ id: ONLINE_SPEECH_PROVIDER_BINDING_ID, ...speech, voicePolicy: 'preset' });
    expect(resolveOnlineSpeechBinding(input, 'office/reader', 'deleted-binding', 'tts')).toBeNull();
    expect(input).toEqual(original);
  });

  it('recognizes only an actual old implicit legacy identity and does not revive removed identities', () => {
    const input = configured();
    expect(resolveOnlineSpeechBinding(input, 'office/other', 'legacy', 'tts')?.binding.id)
      .toBe(ONLINE_SPEECH_PROVIDER_BINDING_ID);
    input.providers.office.models[1].bindings = [];
    expect(resolveOnlineSpeechBinding(input, 'office/other', 'legacy', 'tts')).toBeNull();
    expect(resolveOnlineSpeechBinding(input, 'office/reader', 'legacy', 'tts')).toBeNull();
    input.providers.office.models[0].bindings = [];
    expect(resolveOnlineSpeechBinding(input, 'office/reader', 'old-speech', 'tts')).toBeNull();
    expect(resolveOnlineSpeechBinding(input, 'office/reader', '', 'tts')?.binding.protocolId).toBe(speech.protocolId);
  });

  it('makes the explicit provider authoritative over every old protocol instead of selecting an old first binding', () => {
    const input: OnlineSpeechModelCategory = { providers: { office: {
      displayName: 'Office', baseUrl: 'https://speech.internal/v1', apiKey: '',
      protocolId: 'openai-transcription-http',
      models: [{ id: 'recognizer', name: 'Recognizer', bindings: [
        { id: 'live', protocolId: 'openai-transcription-realtime' },
        { id: 'recorded', protocolId: 'openai-transcription-http' },
      ] }],
    } } };
    expect(resolveOnlineSpeechBinding(input, 'office/recognizer', 'live', 'stt-tool')?.binding.protocolId)
      .toBe('openai-transcription-http');
    input.providers.office.protocolId = 'openai-transcription-realtime';
    expect(resolveOnlineSpeechBinding(input, 'office/recognizer', 'recorded', 'composer-asr')?.binding.protocolId)
      .toBe('openai-transcription-realtime');
    expect(resolveOnlineSpeechBinding(input, 'office/recognizer', 'recorded', 'stt-tool')).toBeNull();
  });

  it.each([
    { protocolId: undefined }, { protocolId: null }, { protocolId: 'unknown' },
    { protocolId: 'chat-audio-speech' }, { compatibilityProfile: 'removed' },
    { protocolId: 'openai-speech-http', compatibilityProfile: 'removed' },
    { protocolId: 'openai-speech-http', compatibilityProfile: undefined },
  ])('rejects an authored invalid provider protocol without a legacy fallback (%j)', fields => {
    expect(() => parseOnlineSpeechProviderProtocol(fields)).toThrow();
    const input = { providers: { p: { ...category.providers.internal, ...fields } } };
    expect(resolveOnlineSpeechBinding(input, 'p/asr', '', 'composer-asr')).toBeNull();
    expect(getOnlineSpeechBindingOptions(input, 'p/asr', 'stt-tool')).toEqual([]);
    expect(getOnlineSpeechModelOptions(input, { purpose: 'stt-tool' })).toEqual([]);
  });

  it('validates provider categories without choosing a protocol for old catalogs', () => {
    expect(parseOnlineSpeechProviderProtocol(undefined)).toBeUndefined();
    expect(parseOnlineSpeechProviderProtocol({ displayName: 'Old' })).toBeUndefined();
    expect(parseOnlineSpeechProviderProtocol(speech, 'speech-synthesis')).toEqual(speech);
    expect(() => parseOnlineSpeechProviderProtocol(speech, 'speech-recognition')).toThrow();
    expect(parseOnlineSpeechProviderProtocol({ protocolId: 'openai-transcription-realtime' }, 'speech-recognition'))
      .toEqual({ protocolId: 'openai-transcription-realtime' });
  });

  it('promotes only supported matching declarations and rejects removed legacy voice workflows', () => {
    const model = { bindings: [
      { id: 'a', ...speech, voicePolicy: 'preset' },
      { id: 'b', ...realtime, inputTranscriptionModel: 'transcriber', voicePolicy: 'preset' },
    ] };
    expect(parseOnlineSpeechModelParameters(model)).toEqual({});
    expect(parseOnlineSpeechModelParameters(model, speech)).toEqual({ voicePolicy: 'preset' });
    const removed = { bindings: [...model.bindings, { id: 'c', ...speech, voicePolicy: 'service-default' }] };
    expect(() => parseOnlineSpeechModelParameters(removed, speech)).toThrow();
    expect(() => parseOnlineSpeechModelParameters({ ...removed, voicePolicy: 'preset' }, speech)).toThrow();
    expect(() => parseOnlineSpeechModelParameters({ bindings: [{ id: 'a', ...speech, voicePolicy: null }] }, speech))
      .toThrow('Invalid speech voice policy');
    expect(() => parseOnlineSpeechModelParameters({ voicePolicy: ['preset'] }, speech)).toThrow();
  });

  it('does not turn removed binding metadata into an alias even under an explicit standard provider', () => {
    for (const binding of [
      { id: 'old', protocolId: 'chat-audio-speech' },
      { id: 'old', protocolId: 'openai-speech-http', compatibilityProfile: 'removed' },
      { id: 'old', protocolId: 'openai-speech-http', compatibilityProfile: undefined },
    ]) {
      const input = { providers: { p: { ...category.providers.internal, ...speech,
        models: [{ id: 'reader', name: 'Reader', voicePolicy: 'preset',
          voices: [{ id: 'a', name: 'A' }], bindings: [binding] }] } } };
      for (const id of ['', ONLINE_SPEECH_PROVIDER_BINDING_ID, 'old'])
        expect(resolveOnlineSpeechBinding(input, 'p/reader', id, 'tts')).toBeNull();
      expect(getOnlineSpeechBindingOptions(input, 'p/reader', 'tts')).toEqual([]);
    }
    expect(() => parseOnlineSpeechModelParameters({ compatibilityProfile: undefined }, speech)).toThrow();
  });

  it('requires a unique realtime input model or an explicit model-level replacement', () => {
    const model = { bindings: [
      { id: 'a', ...realtime, inputTranscriptionModel: 'one' },
      { id: 'b', ...realtime, inputTranscriptionModel: 'two' },
    ] };
    expect(() => parseOnlineSpeechModelParameters(model, realtime)).toThrow('Conflicting');
    expect(parseOnlineSpeechModelParameters({ ...model, inputTranscriptionModel: ' selected ' }, realtime))
      .toEqual({ voicePolicy: 'preset', inputTranscriptionModel: 'selected' });
    expect(() => parseOnlineSpeechModelParameters({}, realtime)).toThrow('Select an input');
    expect(parseOnlineSpeechModelParameters({ inputTranscriptionModel: 'direct' }))
      .toEqual({ inputTranscriptionModel: 'direct' });
    expect(() => parseOnlineSpeechModelParameters({ inputTranscriptionModel: 'direct' }, speech)).toThrow();
    const input = configured();
    input.providers.office.protocolId = 'openai-voice-realtime';
    input.providers.office.models = [{ id: 'voice', name: 'Voice', ...model }];
    expect(resolveOnlineSpeechBinding(input, 'office/voice', '', 'realtime-voice')).toBeNull();
    input.providers.office.models[0].inputTranscriptionModel = 'selected';
    expect(resolveOnlineSpeechBinding(input, 'office/voice', '', 'realtime-voice')?.binding.inputTranscriptionModel).toBe('selected');
    expect(resolveOnlineSpeechBinding(input, 'office/voice', 'legacy', 'realtime-voice')).toBeNull();
  });

  it('checks complete endpoint suffixes and the exact realtime query against the inherited protocol', () => {
    const input = configured();
    input.providers.office.baseUrl = 'https://speech.internal/v1/audio/speech';
    expect(resolveOnlineSpeechBinding(input, 'office/reader', '', 'tts')).not.toBeNull();
    input.providers.office.baseUrl = 'https://speech.internal/team/v1/chat/completions';
    expect(resolveOnlineSpeechBinding(input, 'office/reader', '', 'tts')).toBeNull();
    const realtimeInput: OnlineSpeechModelCategory = { providers: { p: {
      displayName: 'Office', baseUrl: 'wss://speech.internal/team/v1/realtime?intent=transcription',
      apiKey: '', protocolId: 'openai-transcription-realtime', models: [{ id: 'asr', name: 'ASR' }],
    } } };
    expect(resolveOnlineSpeechBinding(realtimeInput, 'p/asr', '', 'composer-asr')).not.toBeNull();
    realtimeInput.providers.p.baseUrl += '&deployment=private';
    expect(resolveOnlineSpeechBinding(realtimeInput, 'p/asr', '', 'composer-asr')).toBeNull();
  });
});

describe('speech execution identity and endpoint admission', () => {
  const configured = (id = 'department/custom-model.v7:fast') => ({ providers: { connection: {
    displayName: 'Company speech', baseUrl: 'http://speech.internal/team/v1', apiKey: '',
    protocolId: 'openai-speech-http', models: [{ id, name: 'Selected model', voices: [{ id: 'department/custom-voice', name: 'Selected voice' }] }],
  } } });

  it.each(['', ' ', 'x'.repeat(257), 'bad\u0001model'])(
    'rejects an invalid model identity even when referenced directly (%j)', id => {
      const input = configured(id);
      const reference = 'connection/' + id.trim();
      expect(resolveOnlineSpeechModel(input, reference)).toBeNull();
      expect(resolveOnlineSpeechBinding(input, reference, '', 'tts')).toBeNull();
      expect(getOnlineSpeechModelOptions(input, { purpose: 'tts' })).toEqual([]);
    },
  );

  it('accepts an arbitrary configured model and voice without name-based inference', () => {
    const input = configured();
    const selected = resolveOnlineSpeechBinding(input, 'connection/department/custom-model.v7:fast', '', 'tts')!;
    expect(selected.model.id).toBe('department/custom-model.v7:fast');
    expect(resolveOnlineSpeechVoiceSelection(selected.model, selected.binding, { kind: 'preset', voiceId: 'department/custom-voice' }))
      .toEqual({ kind: 'preset', voiceId: 'department/custom-voice' });
    expect(resolveOnlineSpeechVoiceSelection(selected.model, selected.binding, null)).toBeNull();
  });

  it.each(['bad\u0001provider', 'x'.repeat(257)])('rejects an invalid provider identity (%j)', id => {
    const input = { providers: { [id]: configured().providers.connection } };
    expect(resolveOnlineSpeechModel(input, id + '/department/custom-model.v7:fast')).toBeNull();
    expect(getOnlineSpeechModelOptions(input, { purpose: 'tts' })).toEqual([]);
  });

  it.each(['bad\u0001voice', 'x'.repeat(257)])('does not offer or choose an invalid voice identity (%j)', id => {
    const input = configured(); input.providers.connection.models[0].voices = [{ id, name: 'Invalid voice' }];
    const selected = resolveOnlineSpeechBinding(input, 'connection/department/custom-model.v7:fast', '', 'tts')!;
    expect(getOnlineSpeechVoiceOptions(selected.model)).toEqual([]);
    expect(resolveOnlineSpeechVoiceSelection(selected.model, selected.binding, { kind: 'preset', voiceId: id })).toBeNull();
  });

  it.each([
    ['openai-transcription-http', 'stt-tool', '/audio/speech'],
    ['openai-speech-http', 'tts', '/audio/transcriptions'],
    ['openai-transcription-realtime', 'composer-asr', '/audio/transcriptions'],
    ['openai-voice-realtime', 'realtime-voice', '/audio/speech'],
  ] as const)('rejects a mismatched legacy %s endpoint before it becomes selectable', (protocolId, purpose, suffix) => {
    const input = { providers: { connection: { displayName: 'Company speech', apiKey: '', baseUrl: 'http://speech.internal/team/v1' + suffix,
      models: [{ id: 'custom/model', name: 'Model', bindings: [{ id: 'selected', protocolId,
        ...(purpose === 'realtime-voice' ? { inputTranscriptionModel: 'custom/transcriber' } : {}) }] }],
    } } };
    expect(resolveOnlineSpeechBinding(input, 'connection/custom/model', 'selected', purpose)).toBeNull();
    expect(getOnlineSpeechBindingOptions(input, 'connection/custom/model', purpose)).toEqual([]);
    expect(getOnlineSpeechModelOptions(input, { purpose })).toEqual([]);
  });
});

describe('explicit speech interface bindings', () => {
  const multi = {
    providers: {
      internal: {
        displayName: 'Internal',
        baseUrl: 'https://speech.internal/team/v1',
        apiKey: '',
        models: [
          {
            id: 'models/recognizer',
            name: 'Recognizer',
            bindings: [
              { id: 'recorded', protocolId: 'openai-transcription-http' },
              { id: 'live', protocolId: 'openai-transcription-realtime' },
            ],
          },
        ],
      },
    },
  };

  it('keeps legacy microphone and attachment protocols distinct without changing their shared model', () => {
    expect(
      resolveOnlineSpeechBinding(category, 'internal/asr', '', 'composer-asr')?.binding.protocolId,
    ).toBe('openai-transcription-realtime');
    expect(
      resolveOnlineSpeechBinding(category, 'internal/asr', '', 'stt-tool')?.binding.protocolId,
    ).toBe('openai-transcription-http');
    expect(category.providers.internal.models[2]).not.toHaveProperty('bindings');
  });

  it('requires an explicit matching binding and does not expose realtime interfaces to attachment tools', () => {
    expect(
      resolveOnlineSpeechBinding(multi, 'internal/models/recognizer', '', 'composer-asr'),
    ).toBeNull();
    expect(
      resolveOnlineSpeechBinding(multi, 'internal/models/recognizer', 'live', 'stt-tool'),
    ).toBeNull();
    expect(
      resolveOnlineSpeechBinding(multi, 'internal/models/recognizer', 'recorded', 'composer-asr')
        ?.binding.protocolId,
    ).toBe('openai-transcription-http');
    expect(
      resolveOnlineSpeechBinding(multi, 'internal/models/recognizer', 'live', 'composer-asr')
        ?.binding.protocolId,
    ).toBe('openai-transcription-realtime');
  });

  it('rejects unknown profiles and realtime conversations without an explicit transcription model', () => {
    expect(() =>
      parseOnlineSpeechModelBindings([
        {
          id: 'chat',
          protocolId: 'chat-audio-speech',
          compatibilityProfile: 'removed',
          voicePolicy: ['preset'],
        },
      ]),
    ).toThrow();
    expect(() => parseOnlineSpeechModelBindings([{ id: 'a', protocolId: 'unknown' }])).toThrow();
    expect(() =>
      parseOnlineSpeechModelBindings([{ id: 'a', protocolId: 'chat-audio-speech' }]),
    ).toThrow();
    expect(() =>
      parseOnlineSpeechModelBindings([{ id: 'a', protocolId: 'openai-voice-realtime' }]),
    ).toThrow();
    expect(() =>
      parseOnlineSpeechModelBindings(
        [{ id: 'a', protocolId: 'openai-transcription-http' }],
        'speech-synthesis',
      ),
    ).toThrow();
    expect(
      parseOnlineSpeechModelBindings(
        [
          {
            id: 'voice',
            protocolId: 'openai-voice-realtime',
            inputTranscriptionModel: 'internal/transcriber',
          },
        ],
        'realtime-voice',
      ),
    ).toMatchObject([{ inputTranscriptionModel: 'internal/transcriber' }]);
  });

  it('requires a preset voice and never revives an explicitly removed selection', () => {
    const model = { id: 'reader', name: 'Reader', voices: [] };
    expect(
      resolveOnlineSpeechVoiceSelection(
        model,
        { id: 'a', protocolId: 'openai-speech-http' },
        { kind: 'service-default' },
      ),
    ).toBeNull();
    expect(normalizeOnlineSpeechVoiceSelection(undefined, 'existing')).toEqual({
      kind: 'preset',
      voiceId: 'existing',
    });
    expect(normalizeOnlineSpeechVoiceSelection(null, 'existing')).toBeNull();
    expect(normalizeOnlineSpeechVoiceSelection({ kind: 'unknown' }, 'existing')).toBeNull();
  });
});

describe('online speech model catalog', () => {
  it('resolves stable provider/model references and trims presentation fields without mutating the catalog', () => {
    expect(resolveOnlineSpeechModel(category, ' internal/voice/model ')).toMatchObject({
      providerId: 'internal',
      model: { id: 'voice/model', name: 'Speech' },
    });
    expect(category.providers.internal.models[0].id).toBe(' voice/model ');
    expect(resolveOnlineSpeechModel(category, 'internal/missing')).toBeNull();
  });

  it('deduplicates configured model and voice IDs while preserving their native order', () => {
    expect(getOnlineSpeechVoiceOptions(category.providers.internal.models[0])).toEqual([
      { value: 'a', label: 'Alice' },
      { value: 'b', label: 'b' },
    ]);
    expect(getOnlineSpeechModelOptions(category)).toEqual([
      { value: 'internal/voice/model', label: 'Internal / Speech' },
      { value: 'internal/asr', label: 'Internal / asr' },
      { value: 'realtime/live', label: 'Realtime / Live' },
    ]);
    expect(getOnlineSpeechModelOptions(category, { requireVoice: true })).toEqual([
      { value: 'internal/voice/model', label: 'Internal / Speech' },
    ]);
  });

  it('keeps realtime models available to microphone callers but excludes them from file transcription', () => {
    expect(
      getOnlineSpeechModelOptions(category, { fileTranscription: true }).map(
        option => option.value,
      ),
    ).toEqual(['internal/voice/model', 'internal/asr']);
    expect(() => normalizeOnlineSpeechBaseUrl('wss://speech.internal/realtime', 'stt')).toThrow();
    const withFragment = {
      providers: {
        p: { ...category.providers.internal, baseUrl: 'wss://speech.internal/realtime#fragment' },
      },
    };
    expect(getOnlineSpeechModelOptions(withFragment)).toEqual([]);
  });

  it('requires HTTP speech synthesis even when a websocket catalog model declares voices', () => {
    for (const baseUrl of [
      'wss://speech.internal/realtime',
      'https://speech.internal/v1?token=unsafe',
      'https://speech.internal/v1#fragment',
    ]) {
      const input = { providers: { p: { ...category.providers.internal, baseUrl } } };
      expect(getOnlineSpeechModelOptions(input, { requireVoice: true })).toEqual([]);
      expect(getOnlineSpeechModelOptions(input, { requireHttp: true })).toEqual([]);
    }
  });

  it('lists HTTP models without requiring a voice while execution choices still require one', () => {
    const input = {
      providers: {
        office: {
          baseUrl: 'https://speech.internal/v1',
          apiKey: '',
          displayName: 'Office',
          models: [{ id: 'reader', name: 'Reader', voices: [] }],
        },
      },
    };
    expect(getOnlineSpeechModelOptions(input, { requireHttp: true })).toEqual([
      { value: 'office/reader', label: 'Office / Reader' },
    ]);
    expect(getOnlineSpeechModelOptions(input, { requireVoice: true })).toEqual([]);
  });

  it.each([undefined, null, [], { providers: [] }, { providers: { bad: { models: [null] } } }])(
    'does not advertise malformed catalog data (%j)',
    value => {
      expect(getOnlineSpeechModelOptions(value)).toEqual([]);
      expect(resolveOnlineSpeechModel(value, 'bad/model')).toBeNull();
    },
  );

  it('tolerates malformed names and rejects transport credentials and invalid voice IDs', () => {
    const malformed = {
      providers: {
        p: {
          baseUrl: 'http://speech.internal/v1',
          apiKey: '',
          models: [null, { id: 'a', name: 42 }],
        },
      },
    };
    expect(resolveOnlineSpeechModel(malformed, 'p/a')?.model.name).toBe('a');
    expect(
      getOnlineSpeechVoiceOptions({ id: 'a', name: '', voices: [{ id: 'bad\nvoice', name: '' }] }),
    ).toEqual([]);
    for (const baseUrl of [
      'file:///model',
      'https://user:password@speech.internal/v1',
      'https://speech.internal/v1?key=unsafe',
      'https://speech.internal/v1#fragment',
    ]) {
      const input = { providers: { p: { baseUrl, apiKey: '', models: [{ id: 'a', name: '' }] } } };
      expect(getOnlineSpeechModelOptions(input, { fileTranscription: true })).toEqual([]);
      expect(() => normalizeOnlineSpeechBaseUrl(baseUrl, 'tts')).toThrow();
    }
  });

  it('normalizes only configured HTTP capability paths and preserves the origin', () => {
    expect(
      normalizeOnlineSpeechBaseUrl(' https://speech.internal/v1/audio/transcriptions/ ', 'stt'),
    ).toBe('https://speech.internal/v1');
    expect(normalizeOnlineSpeechBaseUrl('http://speech.internal/api/realtime', 'stt')).toBe(
      'http://speech.internal/api',
    );
    expect(normalizeOnlineSpeechBaseUrl('https://speech.internal/v1/audio/speech', 'tts')).toBe(
      'https://speech.internal/v1',
    );
  });
});
