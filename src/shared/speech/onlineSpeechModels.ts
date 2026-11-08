export interface OnlineModelVoiceConfig {
  id: string;
  name: string;
}

export interface OnlineModelConfig {
  id: string;
  name: string;
  voices?: OnlineModelVoiceConfig[];
  voicePolicy?: SpeechVoicePolicy;
  inputTranscriptionModel?: string;
  /** Missing means a legacy catalog; an empty list means explicitly unconfigured. */
  bindings?: OnlineSpeechModelBinding[];
}

export interface OnlineSpeechModelProvider {
  displayName: string;
  baseUrl: string;
  apiKey: string;
  protocolId?: SpeechProtocolId;
  models: OnlineModelConfig[];
}

export interface OnlineSpeechModelCategory {
  providers: Record<string, OnlineSpeechModelProvider>;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const boundedText = (value: unknown, limit = 256): value is string =>
  typeof value === 'string' &&
  Boolean(value.trim()) &&
  value.length <= limit &&
  !/[\u0000-\u001f\u007f]/.test(value);

export const isOnlineSpeechModelKind = (kind: string): kind is OnlineSpeechModelKind =>
  ['speech-recognition', 'speech-synthesis', 'realtime-voice'].includes(kind);

export const getSpeechProtocolCapability = (protocolId: SpeechProtocolId): SpeechCapability => {
  switch (protocolId) {
    case SPEECH_PROTOCOL_IDS.TRANSCRIPTION_HTTP:
      return 'transcription';
    case SPEECH_PROTOCOL_IDS.SPEECH_HTTP:
      return 'speech';
    case SPEECH_PROTOCOL_IDS.TRANSCRIPTION_REALTIME:
      return 'realtime-transcription';
    case SPEECH_PROTOCOL_IDS.VOICE_REALTIME:
      return 'realtime-voice';
    default:
      throw new Error('Unknown speech protocol.');
  }
};

const supportsPurpose = (
  binding: OnlineSpeechModelBinding,
  purpose: OnlineSpeechPurpose,
): boolean => {
  const capability = getSpeechProtocolCapability(binding.protocolId);
  if (purpose === 'composer-asr')
    return capability === 'transcription' || capability === 'realtime-transcription';
  if (purpose === 'stt-tool') return capability === 'transcription';
  return capability === (purpose === 'tts' ? 'speech' : 'realtime-voice');
};

export const ONLINE_SPEECH_PROVIDER_BINDING_ID = 'provider';
export type OnlineSpeechProviderProtocol = SpeechProtocolSelection;
export interface OnlineSpeechModelParameters {
  voicePolicy?: SpeechVoicePolicy;
  inputTranscriptionModel?: string;
}

/** Missing fields retain legacy semantics; authored invalid protocol fields never do. */
export const parseOnlineSpeechProviderProtocol = (
  value: unknown,
  kind?: OnlineSpeechModelKind,
): OnlineSpeechProviderProtocol | undefined => {
  if (value === undefined) return undefined;
  const input = record(value);
  if (!input) throw new Error('Invalid speech provider.');
  if (Object.prototype.hasOwnProperty.call(input, 'compatibilityProfile'))
    throw new Error('Unsupported speech configuration field.');
  if (!Object.prototype.hasOwnProperty.call(input, 'protocolId')) {
    return undefined;
  }
  const capability = getSpeechProtocolCapability(input.protocolId as SpeechProtocolId);
  const protocol = resolveSpeechProtocolSelection(input, capability);
  if (kind) {
    const purpose = kind === 'speech-recognition' ? 'composer-asr'
      : kind === 'speech-synthesis' ? 'tts' : 'realtime-voice';
    if (!supportsPurpose({ id: ONLINE_SPEECH_PROVIDER_BINDING_ID, ...protocol }, purpose))
      throw new Error('Speech protocol does not match this provider category.');
  }
  return protocol;
};

/** Flat model parameters are authoritative; only an unambiguous matching legacy value can fill a gap. */
export const parseOnlineSpeechModelParameters = (
  value: unknown,
  protocol?: OnlineSpeechProviderProtocol,
): OnlineSpeechModelParameters => {
  const input = record(value);
  if (!input) throw new Error('Invalid speech model.');
  if (Object.prototype.hasOwnProperty.call(input, 'compatibilityProfile'))
    throw new Error('Unsupported speech configuration field.');
  const capability = protocol ? getSpeechProtocolCapability(protocol.protocolId) : undefined;
  if (protocol) resolveSpeechProtocolSelection(protocol, capability!);
  // Even an alias must refer to a supported declaration; direct parameters cannot erase it.
  const bindings = protocol && input.bindings !== undefined
    ? parseOnlineSpeechModelBindings(input.bindings) : undefined;
  const result: OnlineSpeechModelParameters = {};
  const missingVoicePolicy = input.voicePolicy === undefined;
  const missingInputModel = input.inputTranscriptionModel === undefined;
  let voicePolicy = input.voicePolicy;
  let inputModel = input.inputTranscriptionModel;
  if (protocol && (missingVoicePolicy || missingInputModel) && bindings) {
    const matching = bindings.filter(binding => binding.protocolId === protocol.protocolId);
    if (missingVoicePolicy && (capability === 'speech' || capability === 'realtime-voice')) {
      const values = new Set(matching.map(binding => binding.voicePolicy === undefined ? 'preset' : binding.voicePolicy));
      if (values.size > 1) throw new Error('Conflicting legacy speech voice policies.');
      if (values.size === 1) voicePolicy = values.values().next().value;
    }
    if (missingInputModel && capability === 'realtime-voice') {
      const values = new Set(matching.map(binding => {
        if (!boundedText(binding.inputTranscriptionModel))
          throw new Error('Select an input transcription model for realtime voice.');
        return binding.inputTranscriptionModel.trim();
      }));
      if (values.size > 1) throw new Error('Conflicting legacy input transcription models.');
      if (values.size === 1) inputModel = values.values().next().value;
    }
  }
  if (voicePolicy !== undefined) {
    if (voicePolicy !== 'preset')
      throw new Error('Invalid speech voice policy.');
    if (capability && capability !== 'speech' && capability !== 'realtime-voice')
      throw new Error('This speech protocol has no voice selection.');
    result.voicePolicy = voicePolicy;
  }
  if (inputModel !== undefined) {
    if (!boundedText(inputModel)) throw new Error('Invalid input transcription model.');
    if (capability && capability !== 'realtime-voice')
      throw new Error('Input transcription model is only valid for realtime voice.');
    result.inputTranscriptionModel = inputModel.trim();
  }
  if (capability === 'realtime-voice' && !result.inputTranscriptionModel)
    throw new Error('Select an input transcription model for realtime voice.');
  return result;
};

export const parseOnlineSpeechModelBindings = (
  value: unknown,
  kind?: OnlineSpeechModelKind,
): OnlineSpeechModelBinding[] | undefined => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 8) throw new Error('Invalid speech model bindings.');
  const identities = new Set<string>();
  return value.map(item => {
    const input = record(item);
    if (
      !input ||
      !boundedText(input.id, 64) ||
      !/^[a-zA-Z0-9._-]+$/.test(input.id) ||
      identities.has(input.id) ||
      Object.keys(input).some(
        key =>
          ![
            'id',
            'protocolId',
            'voicePolicy',
            'inputTranscriptionModel',
          ].includes(key),
      )
    )
      throw new Error('Invalid speech model binding.');
    identities.add(input.id);
    const capability = getSpeechProtocolCapability(input.protocolId as SpeechProtocolId);
    const protocol = resolveSpeechProtocolSelection(input, capability);
    const binding: OnlineSpeechModelBinding = { id: input.id, ...protocol };
    if (input.voicePolicy !== undefined) {
      if (input.voicePolicy !== 'preset')
        throw new Error('Invalid speech voice policy.');
      if (capability !== 'speech' && capability !== 'realtime-voice')
        throw new Error('This speech protocol has no voice selection.');
      binding.voicePolicy = input.voicePolicy;
    }
    if (capability === 'realtime-voice') {
      if (!boundedText(input.inputTranscriptionModel))
        throw new Error('Select an input transcription model for realtime voice.');
      binding.inputTranscriptionModel = input.inputTranscriptionModel.trim();
    } else if (input.inputTranscriptionModel !== undefined) {
      throw new Error('Input transcription model is only valid for realtime voice.');
    }
    if (kind) {
      const purpose =
        kind === 'speech-recognition'
          ? 'composer-asr'
          : kind === 'speech-synthesis'
            ? 'tts'
            : 'realtime-voice';
      if (!supportsPurpose(binding, purpose))
        throw new Error('Speech protocol does not match this model category.');
    }
    return binding;
  });
};

export const normalizeOnlineSpeechVoiceSelection = (
  value: unknown,
  legacyVoice?: string,
): OnlineSpeechVoiceSelection | null => {
  if (value === undefined)
    return boundedText(legacyVoice) ? { kind: 'preset', voiceId: legacyVoice.trim() } : null;
  const input = record(value);
  if (!input) return null;
  if (input.kind === 'preset' && boundedText(input.voiceId) && Object.keys(input).length === 2)
    return { kind: 'preset', voiceId: input.voiceId.trim() };
  return null;
};

const bindingsForPurpose = (
  provider: OnlineSpeechModelProvider,
  model: OnlineModelConfig,
  purpose: OnlineSpeechPurpose,
): OnlineSpeechModelBinding[] => {
  try {
    parseOnlineSpeechModelParameters(model);
    const protocol = parseOnlineSpeechProviderProtocol(provider);
    if (protocol) {
      const binding = { id: ONLINE_SPEECH_PROVIDER_BINDING_ID, ...protocol,
        ...parseOnlineSpeechModelParameters(model, protocol) };
      return supportsPurpose(binding, purpose) ? [binding] : [];
    }
  } catch { return []; }
  if (model.bindings === undefined) {
    if (purpose === 'realtime-voice') return [];
    return [
      {
        id: 'legacy',
        protocolId:
          purpose === 'composer-asr'
            ? SPEECH_PROTOCOL_IDS.TRANSCRIPTION_REALTIME
            : purpose === 'stt-tool'
              ? SPEECH_PROTOCOL_IDS.TRANSCRIPTION_HTTP
              : SPEECH_PROTOCOL_IDS.SPEECH_HTTP,
        ...(purpose === 'tts' ? { voicePolicy: 'preset' as const } : {}),
      },
    ];
  }
  try {
    return (parseOnlineSpeechModelBindings(model.bindings) ?? []).filter(binding =>
      supportsPurpose(binding, purpose),
    );
  } catch {
    return [];
  }
};

const providers = (category: unknown): Array<[string, OnlineSpeechModelProvider]> => {
  const entries = record(record(category)?.providers);
  if (!entries) return [];
  return Object.entries(entries).flatMap(([id, value]) => {
    const provider = record(value);
    if (
      !boundedText(id) ||
      id !== id.trim() ||
      !provider ||
      typeof provider.baseUrl !== 'string' ||
      typeof provider.apiKey !== 'string' ||
      !Array.isArray(provider.models)
    )
      return [];
    return [[id, provider as unknown as OnlineSpeechModelProvider]];
  });
};

export const getOnlineSpeechVoiceOptions = (
  model: OnlineModelConfig | null | undefined,
): Array<{ value: string; label: string }> => {
  const voices = Array.isArray(model?.voices) ? model.voices : [];
  const unique = new Map<string, { value: string; label: string }>();
  for (const value of voices) {
    const voice = record(value);
    const id = typeof voice?.id === 'string' ? voice.id.trim() : '';
    if (!boundedText(voice?.id) || unique.has(id)) continue;
    unique.set(id, {
      value: id,
      label: typeof voice?.name === 'string' && voice.name.trim() ? voice.name.trim() : id,
    });
  }
  return [...unique.values()];
};

export const resolveOnlineSpeechModel = (
  category: unknown,
  reference: string,
): {
  providerId: string;
  provider: OnlineSpeechModelProvider;
  model: OnlineModelConfig;
} | null => {
  reference = reference.trim();
  const separator = reference.indexOf('/');
  if (separator <= 0) return null;
  const entry = providers(category).find(([id]) => id === reference.slice(0, separator));
  if (!entry) return null;
  const [providerId, provider] = entry;
  const model = provider.models.find(
    candidate =>
      boundedText(candidate?.id) && candidate.id.trim() === reference.slice(separator + 1),
  );
  return model
    ? {
        providerId,
        provider,
        model: {
          ...model,
          id: model.id.trim(),
          name:
            typeof model.name === 'string' && model.name.trim()
              ? model.name.trim()
              : model.id.trim(),
        },
      }
    : null;
};

export const isOnlineSpeechBindingEndpointValid = (
  provider: OnlineSpeechModelProvider,
  binding: OnlineSpeechModelBinding,
): boolean => {
  try {
    const protocol = parseOnlineSpeechProviderProtocol(provider);
    const url = new URL(provider.baseUrl.trim());
    const http = ['transcription', 'speech'].includes(
      getSpeechProtocolCapability(binding.protocolId),
    );
    const allowedQuery =
      !url.search ||
      (binding.protocolId === SPEECH_PROTOCOL_IDS.TRANSCRIPTION_REALTIME &&
        [...url.searchParams.keys()].length === 1 &&
        url.searchParams.get('intent') === 'transcription');
    if (protocol && protocol.protocolId !== binding.protocolId) return false;
    const configured = new URL(url);
    if (allowedQuery) configured.search = '';
    normalizeSpeechServiceBaseUrl(configured.toString(), binding);
    return (
      ['http:', 'https:', ...(http ? [] : ['ws:', 'wss:'])].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !/\/chat\/completions\/?$/i.test(url.pathname) &&
      allowedQuery &&
      provider.baseUrl.length <= 2048 &&
      provider.apiKey.length <= 16384 &&
      !/[\r\n\0]/.test(provider.apiKey)
    );
  } catch {
    return false;
  }
};

export const getOnlineSpeechBindingOptions = (
  category: unknown,
  modelRef: string,
  purpose: OnlineSpeechPurpose,
): Array<{ value: string; label: string; binding: OnlineSpeechModelBinding; ordinal: number }> => {
  const selection = resolveOnlineSpeechModel(category, modelRef);
  return selection
    ? bindingsForPurpose(selection.provider, selection.model, purpose)
        .filter(binding => isOnlineSpeechBindingEndpointValid(selection.provider, binding))
        .map(binding => ({
          value: binding.id,
          label: binding.protocolId,
          binding,
          ordinal:
            binding.id === ONLINE_SPEECH_PROVIDER_BINDING_ID || selection.model.bindings === undefined
              ? 1
              : selection.model.bindings.findIndex(candidate => candidate.id === binding.id) + 1,
        }))
    : [];
};

export const resolveOnlineSpeechBinding = (
  category: unknown,
  modelRef: string,
  bindingId: string,
  purpose: OnlineSpeechPurpose,
):
  | (NonNullable<ReturnType<typeof resolveOnlineSpeechModel>> & {
      binding: OnlineSpeechModelBinding;
    })
  | null => {
  const selection = resolveOnlineSpeechModel(category, modelRef);
  if (!selection) return null;
  try {
    if (parseOnlineSpeechProviderProtocol(selection.provider)) {
      if (bindingId && bindingId !== ONLINE_SPEECH_PROVIDER_BINDING_ID &&
        !(bindingId === 'legacy' && selection.model.bindings === undefined && purpose !== 'realtime-voice') &&
        !(Array.isArray(selection.model.bindings) && selection.model.bindings.some(
          candidate => {
            const id = record(candidate)?.id;
            return boundedText(id, 64) && /^[a-zA-Z0-9._-]+$/.test(id) && id === bindingId;
          }))) return null;
      const binding = bindingsForPurpose(selection.provider, selection.model, purpose)[0];
      return binding && isOnlineSpeechBindingEndpointValid(selection.provider, binding)
        ? { ...selection, binding } : null;
    }
  } catch { return null; }
  const id = selection.model.bindings === undefined && !bindingId ? 'legacy' : bindingId;
  const binding = bindingsForPurpose(selection.provider, selection.model, purpose).find(
    candidate => candidate.id === id,
  );
  if (!binding || !isOnlineSpeechBindingEndpointValid(selection.provider, binding)) return null;
  return { ...selection, binding };
};

export const resolveOnlineSpeechVoiceSelection = (
  model: OnlineModelConfig,
  binding: OnlineSpeechModelBinding,
  value: unknown,
): OnlineSpeechVoiceSelection | null => {
  const selection = normalizeOnlineSpeechVoiceSelection(value);
  if (!selection) return null;
  try { parseOnlineSpeechModelBindings([binding]); } catch { return null; }
  return getOnlineSpeechVoiceOptions(model).some(voice => voice.value === selection.voiceId)
    ? selection
    : null;
};

export const getOnlineSpeechVoiceSelectionOptions = (
  model: OnlineModelConfig | null | undefined,
  binding: OnlineSpeechModelBinding | null | undefined,
): Array<{ value: string; label: string; selection: OnlineSpeechVoiceSelection }> => {
  if (!model || !binding) return [];
  try { parseOnlineSpeechModelBindings([binding]); } catch { return []; }
  return getOnlineSpeechVoiceOptions(model).map(voice => ({
    value: JSON.stringify(['preset', voice.value]),
    label: voice.label,
    selection: { kind: 'preset' as const, voiceId: voice.value },
  }));
};

export const getOnlineSpeechModelOptions = (
  category: unknown,
  options: {
    requireVoice?: boolean;
    fileTranscription?: boolean;
    requireHttp?: boolean;
    purpose?: OnlineSpeechPurpose;
  } = {},
): Array<{ value: string; label: string }> => {
  const unique = new Map<string, { value: string; label: string }>();
  for (const [providerId, provider] of providers(category)) {
    try {
      parseOnlineSpeechProviderProtocol(provider);
      const url = new URL(provider.baseUrl.trim());
      if (
        !['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash ||
        ((options.requireHttp || options.fileTranscription || options.requireVoice) &&
          (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash)) ||
        provider.baseUrl.length > 2048 ||
        provider.apiKey.length > 16384 ||
        /[\r\n\0]/.test(provider.apiKey)
      )
        continue;
    } catch {
      continue;
    }
    for (const candidate of provider.models) {
      const model = record(candidate);
      const id = typeof model?.id === 'string' ? model.id.trim() : '';
      const value = `${providerId}/${id}`;
      if (
        !boundedText(model?.id) ||
        unique.has(value) ||
        (options.requireVoice && !getOnlineSpeechVoiceOptions(candidate).length)
      )
        continue;
      const purpose = options.purpose ?? (options.fileTranscription ? 'stt-tool' : undefined);
      if (
        purpose &&
        !bindingsForPurpose(provider, candidate, purpose).some(binding =>
          isOnlineSpeechBindingEndpointValid(provider, binding),
        )
      )
        continue;
      const name = typeof model?.name === 'string' && model.name.trim() ? model.name.trim() : id;
      const providerName =
        typeof provider.displayName === 'string' && provider.displayName.trim()
          ? provider.displayName.trim()
          : providerId;
      unique.set(value, { value, label: `${providerName} / ${name}` });
    }
  }
  return [...unique.values()];
};

/** Normalize a configured capability endpoint without inventing another protocol or origin. */
export const normalizeOnlineSpeechBaseUrl = (value: string, kind: 'stt' | 'tts'): string => {
  const url = new URL(value.trim());
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /\/chat\/completions\/?$/i.test(url.pathname)
  )
    throw new Error('Invalid online speech service URL.');
  url.pathname =
    url.pathname
      .replace(/\/+$/, '')
      .replace(
        kind === 'stt'
          ? /\/(?:audio\/transcriptions|realtime)$/i
          : /\/audio\/speech$/i,
        '',
      ) || '/';
  return url.toString().replace(/\/+$/, '');
};
import {
  normalizeSpeechServiceBaseUrl,
  resolveSpeechProtocolSelection,
  SPEECH_PROTOCOL_IDS,
  type SpeechCapability,
  type SpeechProtocolId,
  type SpeechProtocolSelection,
  type SpeechVoicePolicy,
  type SpeechVoiceSelection,
} from '../../../plugins/sdk/speech-protocols';

export type OnlineSpeechVoiceSelection = SpeechVoiceSelection;
export type OnlineSpeechPurpose = 'composer-asr' | 'stt-tool' | 'tts' | 'realtime-voice';
export type OnlineSpeechModelKind = 'speech-recognition' | 'speech-synthesis' | 'realtime-voice';

export interface OnlineSpeechModelBinding {
  id: string;
  protocolId: SpeechProtocolId;
  voicePolicy?: SpeechVoicePolicy;
  inputTranscriptionModel?: string;
}
