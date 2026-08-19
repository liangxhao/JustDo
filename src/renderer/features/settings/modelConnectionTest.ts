export const MODEL_CONNECTION_TEST_REQUEST_PURPOSE = 'connection_test' as const;
export const MODEL_CONNECTION_TEST_TIMEOUT_MS = 60_000;

export const selectModelsForConnectionTest = <T extends { id: string }>(
  models: T[],
  modelId?: string,
): T[] => (modelId ? models.filter(model => model.id === modelId) : models);

export const withModelConnectionTestTimeout = <T>(
  promise: Promise<T>,
  onTimeout: () => void | Promise<void>,
  timeoutMessage: string,
  timeoutMs = MODEL_CONNECTION_TEST_TIMEOUT_MS,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      void Promise.resolve()
        .then(onTimeout)
        .catch(() => undefined);
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    promise.then(
      value => {
        if (settled) {
          return;
        }
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      error => {
        if (settled) {
          return;
        }
        settled = true;
        globalThis.clearTimeout(timer);
        reject(error);
      },
    );
  });

export const buildModelConnectionTestRequestBody = (
  modelId: string,
  maxTokens: number,
  includeMetadata = false,
): string =>
  JSON.stringify({
    model: modelId,
    ...(includeMetadata
      ? {
          metadata: {
            request_purpose: MODEL_CONNECTION_TEST_REQUEST_PURPOSE,
          },
        }
      : {}),
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: maxTokens,
  });
