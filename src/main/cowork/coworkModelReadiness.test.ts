import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveCurrentApiConfig: vi.fn(),
}));

vi.mock('../providers/providerApiConfig', () => ({
  resolveCurrentApiConfig: mocks.resolveCurrentApiConfig,
}));

import { probeCoworkModelReadiness } from './coworkModelReadiness';

describe('probeCoworkModelReadiness', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('sends custom provider headers and rejects redirects', async () => {
    mocks.resolveCurrentApiConfig.mockReturnValue({
      config: {
        apiKey: 'generated-key',
        baseURL: 'https://provider.example/v1',
        model: 'model-1',
        headers: {
          authorization: 'Basic custom',
          'X-Tenant': 'tenant-a',
        },
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(probeCoworkModelReadiness()).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://provider.example/v1/chat/completions',
      expect.objectContaining({
        redirect: 'error',
        headers: {
          authorization: 'Basic custom',
          'Content-Type': 'application/json',
          'X-Tenant': 'tenant-a',
        },
      }),
    );
  });
});
