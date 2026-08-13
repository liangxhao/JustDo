const trimmedString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

export function normalizeModelRef(model: unknown, provider?: unknown): string | null {
  const normalizedModel = trimmedString(model);
  if (!normalizedModel) return null;
  if (normalizedModel.includes('/')) return normalizedModel;

  const normalizedProvider = trimmedString(provider);
  return normalizedProvider ? `${normalizedProvider}/${normalizedModel}` : normalizedModel;
}

export function isGatewayInjectedModelRef(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'gateway-injected' || normalized.endsWith('/gateway-injected');
}

export function readModelRef(source: unknown): string | null {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const record = source as Record<string, unknown>;
  const metadata =
    record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? (record.metadata as Record<string, unknown>)
      : undefined;
  const provider =
    trimmedString(record.modelProvider) ||
    trimmedString(record.provider) ||
    trimmedString(metadata?.modelProvider) ||
    trimmedString(metadata?.provider);

  const explicit = trimmedString(record.modelName) || trimmedString(metadata?.modelName);
  if (explicit) return normalizeModelRef(explicit, provider);

  const model =
    trimmedString(record.model) ||
    trimmedString(record.modelId) ||
    trimmedString(metadata?.model) ||
    trimmedString(metadata?.modelId);
  return normalizeModelRef(model, provider);
}
