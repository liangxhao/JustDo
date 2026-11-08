import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./systemProxy', () => ({
  getFixedProxyUrl: () => null,
  isSystemProxyEnabled: () => true,
  resolveSystemProxyUrl: vi.fn(),
}));
vi.mock('./outboundHeaderPolicyConfig', () => ({
  getOutboundHeaderPolicyConfig: vi.fn(),
  getOutboundHeaderUserInfo: vi.fn(),
}));
vi.mock('./outboundHeaderProxy', () => ({
  applyOutboundHeaders: vi.fn(),
  resolveOutboundHeaderNamesForRequest: vi.fn(),
  resolveOutboundHeaderProxyConfig: vi.fn(),
  shouldApplyOutboundHeadersForRequest: vi.fn(),
}));

import { mainProcessFetch } from './mainProcessFetch';
import { resolveSystemProxyUrl } from './systemProxy';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
describe('Main speech dispatch admission', () => {
  it('cancels a pending proxy preparation without waiting for it or dispatching later', async () => {
    let finishProxy!: (value: null) => void;
    vi.mocked(resolveSystemProxyUrl).mockReturnValue(
      new Promise(resolve => {
        finishProxy = resolve;
      }),
    );
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    const pending = mainProcessFetch('http://speech.internal/audio/transcriptions', {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    finishProxy(null);
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rechecks authorization after an asynchronous proxy resolution and before sending', async () => {
    let finishProxy!: (value: null) => void;
    vi.mocked(resolveSystemProxyUrl).mockReturnValue(
      new Promise(resolve => {
        finishProxy = resolve;
      }),
    );
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    let allowed = true;
    const pending = mainProcessFetch(
      'http://speech.internal/audio/transcriptions',
      { method: 'POST', body: 'audio' },
      {
        beforeDispatch: () => {
          if (!allowed) throw new Error('Permission withdrawn.');
        },
      },
    );
    allowed = false;
    finishProxy(null);
    await expect(pending).rejects.toThrow('Permission withdrawn');
    expect(fetch).not.toHaveBeenCalled();
  });
});
