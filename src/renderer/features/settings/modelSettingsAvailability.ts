export type ModelActionAvailabilityInput = {
  requiresCredentials: boolean;
  baseUrl: string;
  apiKey: string;
  modelCount: number;
  busy: boolean;
};

export const getModelActionAvailability = ({
  requiresCredentials,
  baseUrl,
  apiKey,
  modelCount,
  busy,
}: ModelActionAvailabilityInput) => {
  const credentialsReady =
    !requiresCredentials || (Boolean(baseUrl.trim()) && Boolean(apiKey.trim()));

  return {
    credentialsReady,
    canManageModels: credentialsReady && !busy,
    canTestConnection: credentialsReady && modelCount > 0 && !busy,
  };
};
