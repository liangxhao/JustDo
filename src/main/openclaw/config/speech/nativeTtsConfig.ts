import { isRecord } from '../configShape';

const normalizeSpeakerSelection = (value: unknown): unknown => {
  if (!isRecord(value)) return value;
  const result = { ...value };
  for (const key of ['voice', 'voiceName', 'voiceId']) delete result[key];
  return result;
};

const normalizeProviders = (scope: Record<string, unknown>): Record<string, unknown> => ({
  ...scope,
  ...(isRecord(scope.providers) ? {
    providers: Object.fromEntries(
      Object.entries(scope.providers).map(([id, config]) => [id, normalizeSpeakerSelection(config)]),
    ),
  } : {}),
});

/** Emit the current native fields; unreleased development aliases are discarded. */
export function normalizeNativeTtsConfig(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const result = normalizeProviders(value);
  delete result.enabled;
  if (isRecord(result.personas)) {
    result.personas = Object.fromEntries(Object.entries(result.personas).map(([id, persona]) => [
      id, isRecord(persona) ? normalizeProviders(persona) : persona,
    ]));
  }
  return result;
}
