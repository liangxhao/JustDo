import { describe, expect, it, vi } from 'vitest';

import { createWebpageEmbedMounts, resolveWebpageEmbedTarget } from './webpageEmbedMounts';
import { observeWebpageEmbedSessionEvent } from './webpageEmbedSessions';

const origin = 'http://127.0.0.1:18789';
const mountId = '2e4ec192-521e-4b76-b132-e34598e41bb2';
const allowedConfig = { valid: true, config: { gateway: { controlUi: { allowExternalEmbedUrls: true } } } };
describe('webpage mount target policy', () => {
  it('admits independent hosted staging without Widget evidence', () => {
    expect(resolveWebpageEmbedTarget({ ref: 'cv_new' }, origin)).toEqual({
      kind: 'hosted',
      documentId: 'cv_new',
      entryPath: 'index.html',
    });
    expect(
      resolveWebpageEmbedTarget(
        { url: `${origin}/__openclaw__/canvas/documents/cv_new/sub/page.html` },
        origin,
      ),
    ).toMatchObject({ kind: 'hosted', entryPath: 'sub/page.html' });
  });
  it('classifies external targets and preserves page parameters', () => {
    expect(
      resolveWebpageEmbedTarget({ url: 'https://intranet.example/page?q=1#form' }, origin),
    ).toEqual({ kind: 'web', url: 'https://intranet.example/page?q=1#form' });
  });
  it.each([
    'file:///tmp/page.html',
    '/__openclaw__/cap/secret/__openclaw__/canvas/documents/cv_new/index.html',
    '/__openclaw__/canvas/documents/cv_new/../other/index.html',
    '/__openclaw__/canvas/documents/cv_new/%2e%2e/index.html',
    `${origin}/rpc`,
    'https://user:password@example.test/page',
    '//example.test/page',
    '/__openclaw__/canvas/documents/cv_new/index.html?token=secret',
  ])('rejects forbidden explicit URL instead of borrowing ref: %s', url => {
    expect(() => resolveWebpageEmbedTarget({ url, ref: 'cv_good' }, origin)).toThrow();
  });
  it('binds preparation to the exact live owner and resolved native session', async () => {
    const registerMount = vi.fn().mockReturnValue({ partition: 'webpage-embed:test' });
    const release = vi.fn();
    const request = vi.fn(async (method: string) =>
      method === 'sessions.resolve'
        ? { ok: true, key: 'agent:main:s' }
        : method === 'config.get' ? allowedConfig
          : { session: { key: 'agent:main:s', sessionId: 'native-sid' } },
    );
    const client = { request } as never;
    let current = true;
    const owner = { getURL: () => 'http://127.0.0.1:2222/index.html', isDestroyed: () => false };
    const service = createWebpageEmbedMounts({
      owner: owner as never,
      guests: { registerMount, release } as never,
      getConnection: () => ({
        client,
        gatewayOrigin: origin,
        canvas: null,
        isCurrent: () => current,
      }),
    });
    const value = await service.prepare({
      mountId,
      sessionKey: 'agent:main:s',
      sessionId: 'native-sid',
      url: 'https://internal.example/page',
    });
    expect(request).toHaveBeenCalledWith('sessions.resolve', {
      sessionId: 'native-sid',
      allowMissing: true,
      includeUnknown: true,
    });
    expect(value).toEqual({
      mountId,
      partition: 'webpage-embed:test',
      viewerUrl: `http://127.0.0.1:2222/embed-viewer.html?mount=${mountId}`,
    });
    expect(registerMount.mock.calls[0][0].isCurrent()).toBe(true);
    observeWebpageEmbedSessionEvent(client, 'sessions.changed', {
      reason: 'reset',
      key: 'agent:main:s',
    });
    expect(release).toHaveBeenCalledWith(owner, mountId);
    expect(registerMount.mock.calls[0][0].isCurrent()).toBe(false);
    current = false;
    expect(registerMount.mock.calls[0][0].isCurrent()).toBe(false);
    service.release(mountId);
    expect(release).toHaveBeenCalledWith(owner, mountId);
  });
  it('never attaches late native authorization after a released preparation', async () => {
    let resolve!: (value: unknown) => void;
    const registerMount = vi.fn();
    const service = createWebpageEmbedMounts({
      owner: {
        getURL: () => 'http://127.0.0.1:2222/index.html',
        isDestroyed: () => false,
      } as never,
      guests: { registerMount } as never,
      getConnection: () => ({
        client: {
          request: () =>
            new Promise(done => {
              resolve = done;
            }),
        } as never,
        gatewayOrigin: origin,
        canvas: null,
        isCurrent: () => true,
      }),
    });
    const task = service.prepare({
      mountId,
      sessionKey: 'agent:main:s',
      url: 'https://internal.example/page',
    });
    service.release(mountId);
    resolve({ ok: true, key: 'agent:main:s' });
    await expect(task).rejects.toThrow('unavailable');
    expect(registerMount).not.toHaveBeenCalled();
  });
  it('does not let a released preparation consume a later mount with the same ID', async () => {
    const completions: Array<(value: unknown) => void> = [];
    const registerMount = vi.fn().mockReturnValue({ partition: 'current' });
    const client = { request: vi.fn((method: string) => method === 'sessions.resolve'
      ? new Promise(done => { completions.push(done); })
      : Promise.resolve(method === 'config.get' ? allowedConfig : { session: { key: 'a', sessionId: 'sid' } })) } as never;
    const service = createWebpageEmbedMounts({
      owner: { getURL: () => 'http://127.0.0.1:2222/index.html', isDestroyed: () => false } as never,
      guests: { registerMount, release: vi.fn() } as never,
      getConnection: () => ({ client, gatewayOrigin: origin, canvas: null, isCurrent: () => true }),
    });
    const old = service.prepare({ mountId, sessionKey: 'a', url: 'https://example.test/old' });
    const rejected = expect(old).rejects.toThrow('unavailable');
    service.release(mountId);
    const current = service.prepare({ mountId, sessionKey: 'a', url: 'https://example.test/current' });
    completions[0]({ ok: true, key: 'a' });
    await rejected;
    expect(registerMount).not.toHaveBeenCalled();
    completions[1]({ ok: true, key: 'a' });
    await expect(current).resolves.toMatchObject({ partition: 'current' });
    expect(registerMount.mock.calls[0][0].targetUrl).toBe('https://example.test/current');
    service.dispose();
  });
  it.each([
    { snapshot: allowedConfig, allowed: true },
    // A native snapshot is already resolved even when the root is JSON5/include.
    { snapshot: { ...allowedConfig, raw: '{ gateway: { controlUi: { $include: "./control-ui.json" } } }' }, allowed: true },
    { snapshot: { valid: true, config: {} }, allowed: false },
    { snapshot: { valid: true, config: { gateway: { controlUi: { allowExternalEmbedUrls: false } } } }, allowed: false },
    { snapshot: { valid: false, config: allowedConfig.config }, allowed: false },
    { snapshot: { valid: true, config: { gateway: { controlUi: { allowExternalEmbedUrls: 'true' } } } }, allowed: false },
    { snapshot: null, allowed: false },
  ])('uses the resolved native configuration for external admission: $allowed / $snapshot', async ({ snapshot, allowed }) => {
    const registerMount = vi.fn().mockReturnValue({ partition: 'current' });
    const request = vi.fn(async (method: string) => method === 'sessions.resolve'
      ? { ok: true, key: 'a' }
      : method === 'config.get' ? snapshot : { session: { key: 'a', sessionId: 'sid' } });
    const service = createWebpageEmbedMounts({
      owner: { getURL: () => 'http://127.0.0.1:2222/index.html', isDestroyed: () => false } as never,
      guests: { registerMount, release: vi.fn() } as never,
      getConnection: () => ({ client: { request } as never, gatewayOrigin: origin, canvas: null, isCurrent: () => true }),
    });
    const result = service.prepare({ mountId, sessionKey: 'a', url: 'https://example.test/page' });
    if (allowed) await expect(result).resolves.toMatchObject({ partition: 'current' });
    else await expect(result).rejects.toThrow('unavailable');
    expect(request).toHaveBeenCalledWith('config.get', {});
    expect(registerMount).toHaveBeenCalledTimes(allowed ? 1 : 0);
    service.dispose();
  });
  it.each(['release', 'connection', 'failure'])('rejects stale or failed config admission: %s', async retirement => {
    let complete!: (value: unknown) => void;
    let fail!: (error: Error) => void;
    let started!: () => void;
    const startedConfig = new Promise<void>(resolve => { started = resolve; });
    let current = true;
    const registerMount = vi.fn();
    const request = vi.fn((method: string) => method === 'config.get'
      ? new Promise((resolve, reject) => { complete = resolve; fail = reject; started(); })
      : Promise.resolve(method === 'sessions.resolve'
        ? { ok: true, key: 'a' } : { session: { key: 'a', sessionId: 'sid' } }));
    const service = createWebpageEmbedMounts({
      owner: { getURL: () => 'http://127.0.0.1:2222/index.html', isDestroyed: () => false } as never,
      guests: { registerMount, release: vi.fn() } as never,
      getConnection: () => ({ client: { request } as never, gatewayOrigin: origin, canvas: null, isCurrent: () => current }),
    });
    const result = service.prepare({ mountId, sessionKey: 'a', url: 'https://example.test/page' });
    const rejected = expect(result).rejects.toThrow('unavailable');
    await startedConfig;
    if (retirement === 'release') service.release(mountId);
    else if (retirement === 'connection') current = false;
    if (retirement === 'failure') fail(new Error('Gateway unavailable'));
    else complete(allowedConfig);
    await rejected;
    expect(registerMount).not.toHaveBeenCalled();
    service.dispose();
  });
});
