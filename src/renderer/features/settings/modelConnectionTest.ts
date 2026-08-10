export const MODEL_CONNECTION_TEST_REQUEST_PURPOSE = 'connection_test' as const;

export const buildModelConnectionTestRequestBody = (modelId: string, maxTokens: number): string =>
  JSON.stringify({
    model: modelId,
    metadata: {
      request_purpose: MODEL_CONNECTION_TEST_REQUEST_PURPOSE,
    },
    messages: [{ role: 'user', content: 'Hi' }],
    max_tokens: maxTokens,
  });
