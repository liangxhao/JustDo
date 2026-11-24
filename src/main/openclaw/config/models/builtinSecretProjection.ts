import { OpenClawExtensionId } from '../../../../shared/plugins/nativeIds';
import { OpenClawProviderId } from '../../../../shared/providers';
import { BUILTIN_MODEL_JWT_FIELD } from '../../../providers/builtinModelCredential';
import { isRecord } from '../configShape';

export const containsBuiltinModelRef = (value: unknown): boolean => {
  if (typeof value === 'string') {
    return (
      value === OpenClawProviderId.BuiltinModels ||
      value.startsWith(`${OpenClawProviderId.BuiltinModels}/`)
    );
  }
  if (Array.isArray(value)) {
    return value.some(containsBuiltinModelRef);
  }
  return isRecord(value) && Object.values(value).some(containsBuiltinModelRef);
};

export const BUILTIN_MODELS_API_KEY_PLACEHOLDER = '${JUSTDO_APIKEY_BUILTIN_MODELS}';

export const BUILTIN_MODEL_SECRET_PROVIDER_ID = 'justdo_login';
export const LEGACY_BUILTIN_MODEL_SECRET_PROVIDER_ID = 'justdo-builtin';

export type OpenClawBuiltinSecretRef = Readonly<{
  source: 'exec';
  provider: typeof BUILTIN_MODEL_SECRET_PROVIDER_ID;
  id: string;
}>;

export const buildBuiltinModelSecretRef = (fieldName: string): OpenClawBuiltinSecretRef => ({
  source: 'exec',
  provider: BUILTIN_MODEL_SECRET_PROVIDER_ID,
  id: fieldName,
});

export const buildBuiltinModelOpenClawHeaders = (): Record<string, OpenClawBuiltinSecretRef> => ({
  [BUILTIN_MODEL_JWT_FIELD]: buildBuiltinModelSecretRef(BUILTIN_MODEL_JWT_FIELD),
});

export const buildManagedOpenClawSecrets = (
  existingConfig: Record<string, unknown> | null,
): Record<string, unknown> => {
  const existingSecrets = isRecord(existingConfig?.secrets) ? existingConfig.secrets : {};
  const existingProviders = isRecord(existingSecrets.providers) ? existingSecrets.providers : {};
  const providers = { ...existingProviders };
  delete providers[BUILTIN_MODEL_SECRET_PROVIDER_ID];
  delete providers[LEGACY_BUILTIN_MODEL_SECRET_PROVIDER_ID];
  const secrets = { ...existingSecrets, providers };
  if (Object.keys(providers).length === 0) {
    delete secrets.providers;
  }
  return secrets;
};

export const containsBuiltinCredentialRef = (value: unknown): boolean => {
  if (typeof value === 'string') return value.includes(BUILTIN_MODELS_API_KEY_PLACEHOLDER);
  if (Array.isArray(value)) return value.some(containsBuiltinCredentialRef);
  if (!isRecord(value)) return false;
  const { source, provider, id } = value;
  return (
    typeof id === 'string' &&
    (source === 'exec' || source === 'file' || source === 'env') &&
    (provider === BUILTIN_MODEL_SECRET_PROVIDER_ID || provider === LEGACY_BUILTIN_MODEL_SECRET_PROVIDER_ID)
  ) || Object.values(value).some(containsBuiltinCredentialRef);
};

export const containsBuiltinMemorySearchRef = (value: unknown): boolean =>
  (isRecord(value) && value.provider === OpenClawExtensionId.RUNTIME_SERVICES) ||
  containsBuiltinModelRef(value) ||
  containsBuiltinCredentialRef(value);
