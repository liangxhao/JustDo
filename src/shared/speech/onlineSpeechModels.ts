export interface OnlineModelVoiceConfig {
  id: string;
  name: string;
}

export interface OnlineModelConfig {
  id: string;
  name: string;
  voices?: OnlineModelVoiceConfig[];
}

export interface OnlineSpeechModelProvider {
  displayName: string;
  baseUrl: string;
  apiKey: string;
  models: OnlineModelConfig[];
}

export interface OnlineSpeechModelCategory {
  providers: Record<string, OnlineSpeechModelProvider>;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const providers = (category: unknown): Array<[string, OnlineSpeechModelProvider]> => {
  const entries = record(record(category)?.providers);
  if (!entries) return [];
  return Object.entries(entries).flatMap(([id, value]) => {
    const provider = record(value);
    if (
      !id.trim() ||
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
    if (!id || id.length > 256 || /[\r\n\0]/.test(id) || unique.has(id)) continue;
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
      typeof candidate?.id === 'string' && candidate.id.trim() === reference.slice(separator + 1),
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

export const getOnlineSpeechModelOptions = (
  category: unknown,
  options: { requireVoice?: boolean; fileTranscription?: boolean } = {},
): Array<{ value: string; label: string }> => {
  const unique = new Map<string, { value: string; label: string }>();
  for (const [providerId, provider] of providers(category)) {
    try {
      const url = new URL(provider.baseUrl.trim());
      if (
        !['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        ((options.fileTranscription || options.requireVoice) &&
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
        !id ||
        id.length > 256 ||
        /[\r\n\0]/.test(id) ||
        unique.has(value) ||
        (options.requireVoice && !getOnlineSpeechVoiceOptions(candidate).length)
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
    url.hash
  )
    throw new Error('Invalid online speech service URL.');
  url.pathname =
    url.pathname
      .replace(/\/+$/, '')
      .replace(
        kind === 'stt' ? /\/(?:audio\/transcriptions|realtime)$/i : /\/audio\/speech$/i,
        '',
      ) || '/';
  return url.toString().replace(/\/+$/, '');
};
