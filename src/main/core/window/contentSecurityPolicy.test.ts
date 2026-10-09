import { describe, expect, it, vi } from 'vitest';

const { onHeadersReceived } = vi.hoisted(() => ({ onHeadersReceived: vi.fn() }));
vi.mock('electron', () => ({
  session: { defaultSession: { webRequest: { onHeadersReceived } } },
}));

import { registerContentSecurityPolicy, shouldApplyApplicationCsp } from './contentSecurityPolicy';

describe('shouldApplyApplicationCsp', () => {
  it('limits development CSP injection to the application origin', () => {
    const appUrl = 'http://localhost:43127';
    expect(shouldApplyApplicationCsp(`${appUrl}/src/main.tsx`, appUrl, true)).toBe(true);
    expect(shouldApplyApplicationCsp('https://example.com/app.js', appUrl, true)).toBe(false);
  });

  it('limits packaged CSP injection to local application files', () => {
    expect(
      shouldApplyApplicationCsp('file:///C:/Program%20Files/JustDo/index.html', '', false),
    ).toBe(true);
    expect(shouldApplyApplicationCsp('https://example.com/', '', false)).toBe(false);
  });

  it('allows bundled PDF WebAssembly without allowing JavaScript eval', () => {
    registerContentSecurityPolicy({ isDev: false, devServerPort: 43127 });
    const handler = onHeadersReceived.mock.lastCall?.[0];
    const callback = vi.fn();
    handler({ url: 'file:///app/index.html', responseHeaders: {} }, callback);

    const policy = callback.mock.lastCall?.[0].responseHeaders['Content-Security-Policy'];
    const scripts = policy
      .split('; ')
      .find((directive: string) => directive.startsWith('script-src'));
    expect(scripts).toBe("script-src 'self' 'wasm-unsafe-eval'");
    expect(scripts).not.toContain("'unsafe-eval'");
    expect(policy).toContain("connect-src 'self' *");
  });

  it('protects the initialization session without opening the persistent default session', () => {
    onHeadersReceived.mockClear();
    const memoryHeaders = vi.fn();
    registerContentSecurityPolicy({ isDev: false, devServerPort: 43127 }, {
      webRequest: { onHeadersReceived: memoryHeaders },
    } as unknown as Electron.Session);
    expect(memoryHeaders).toHaveBeenCalledOnce();
    expect(onHeadersReceived).not.toHaveBeenCalled();
  });
});
