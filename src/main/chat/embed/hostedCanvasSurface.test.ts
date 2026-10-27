import { describe, expect, it, vi } from 'vitest';

import type { GatewayClientLike } from '../../engine/gateway/types';
import {
  captureHostedCanvasBinding,
  rememberHostedCanvasSurface,
  retireHostedCanvasSurface,
} from './hostedCanvasSurface';

const GATEWAY_ORIGIN = 'http://127.0.0.1:31415';
const HELLO_SURFACE = `${GATEWAY_ORIGIN}/__openclaw__/cap/hello_surface_0000000000`;
const FRESH_SURFACE = `${GATEWAY_ORIGIN}/__openclaw__/cap/fresh_surface_0000000000`;
const RESOURCE = '/__openclaw__/canvas/documents/cv_report/index.html';

function harness() {
  let current = true;
  const request = vi.fn().mockResolvedValue({
    surface: 'canvas',
    pluginSurfaceUrls: { canvas: FRESH_SURFACE },
    expiresAtMs: Date.now() + 600_000,
  });
  const client = { start() {}, stop() {}, request } as GatewayClientLike;
  const registration = {
    client,
    generation: 7,
    profileId: 'profile-state-directory',
    gatewayUrl: 'ws://127.0.0.1:31415',
    hello: { pluginSurfaceUrls: { canvas: HELLO_SURFACE } },
    isCurrent: () => current,
  };
  return {
    client,
    request,
    registration,
    changeConnection: () => {
      current = false;
    },
  };
}

describe('Main hosted Canvas surface leases', () => {
  it('only captures the exact accepted client, generation and profile without connecting', () => {
    const h = harness();
    expect(captureHostedCanvasBinding(h.client, 7, 'profile-state-directory')).toBeNull();
    rememberHostedCanvasSurface(h.registration);
    expect(captureHostedCanvasBinding(h.client, 7, 'profile-state-directory')?.gatewayOrigin).toBe(
      GATEWAY_ORIGIN,
    );
    expect(captureHostedCanvasBinding(h.client, 8, 'profile-state-directory')).toBeNull();
    expect(captureHostedCanvasBinding(h.client, 7, 'other-profile')).toBeNull();
    expect(captureHostedCanvasBinding(harness().client, 7, 'profile-state-directory')).toBeNull();
    expect(h.request).not.toHaveBeenCalled();
    h.changeConnection();
    expect(captureHostedCanvasBinding(h.client, 7, 'profile-state-directory')).toBeNull();
  });

  it.each([
    `${GATEWAY_ORIGIN}/__openclaw__/canvas/documents/cv_report/index.html`,
    'http://127.0.0.1:31416/__openclaw__/cap/hello_surface_0000000000',
    `${HELLO_SURFACE}?oc_cap=model-supplied`,
    `http://user:password@127.0.0.1:31415/__openclaw__/cap/hello_surface_0000000000`,
  ])('rejects a hello surface outside the fixed native capability contract: %s', canvas => {
    const h = harness();
    rememberHostedCanvasSurface({ ...h.registration, hello: { pluginSurfaceUrls: { canvas } } });
    expect(captureHostedCanvasBinding(h.client, 7, 'profile-state-directory')).toBeNull();
  });

  it('coalesces lease renewal and keeps its capability off the public mount identity', async () => {
    const h = harness();
    rememberHostedCanvasSurface(h.registration);
    const binding = captureHostedCanvasBinding(h.client, 7, 'profile-state-directory')!;
    const urls = await Promise.all([
      binding.getResourceUrl(RESOURCE),
      binding.getResourceUrl(RESOURCE),
    ]);
    expect(urls.map(url => url.href)).toEqual([
      `${FRESH_SURFACE}${RESOURCE}`,
      `${FRESH_SURFACE}${RESOURCE}`,
    ]);
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.request).toHaveBeenCalledWith(
      'plugin.surface.refresh',
      {
        surface: 'canvas',
        observedUrl: HELLO_SURFACE,
      },
      { timeoutMs: 10_000 },
    );
    await binding.getResourceUrl(RESOURCE);
    expect(h.request).toHaveBeenCalledOnce();
    expect(Object.keys(binding)).not.toContain('token');
    retireHostedCanvasSurface(h.client);
  });

  it('does not fall back to a hello capability when renewal fails', async () => {
    const h = harness();
    h.request.mockRejectedValue(new Error(`private upstream error ${HELLO_SURFACE}`));
    rememberHostedCanvasSurface(h.registration);
    const binding = captureHostedCanvasBinding(h.client, 7, 'profile-state-directory')!;
    await expect(binding.getResourceUrl(RESOURCE)).rejects.toThrow(
      'Hosted document authorization is unavailable.',
    );
    retireHostedCanvasSurface(h.client);
  });

  it('retires existing consumers and rejects a late renewal after connection replacement', async () => {
    const h = harness();
    let finish: ((value: unknown) => void) | undefined;
    h.request.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    rememberHostedCanvasSurface(h.registration);
    const binding = captureHostedCanvasBinding(h.client, 7, 'profile-state-directory')!;
    const retired = vi.fn();
    binding.onRetired(retired);
    const pending = binding.getResourceUrl(RESOURCE);
    await Promise.resolve();
    h.changeConnection();
    retireHostedCanvasSurface(h.client);
    finish?.({
      surface: 'canvas',
      pluginSurfaceUrls: { canvas: FRESH_SURFACE },
      expiresAtMs: Date.now() + 600_000,
    });
    await expect(pending).rejects.toThrow('Hosted document authorization is unavailable.');
    expect(retired).toHaveBeenCalledOnce();
    expect(binding.isCurrent()).toBe(false);
    expect(captureHostedCanvasBinding(h.client, 7, 'profile-state-directory')).toBeNull();
  });

  it.each([
    {
      surface: 'canvas',
      pluginSurfaceUrls: { canvas: 'http://127.0.0.1:1/__openclaw__/cap/foreign_0000000000' },
    },
    { surface: 'files', pluginSurfaceUrls: { canvas: FRESH_SURFACE } },
    { surface: 'canvas', pluginSurfaceUrls: { canvas: FRESH_SURFACE }, expiresAtMs: 1 },
    { surface: 'canvas', pluginSurfaceUrls: { canvas: FRESH_SURFACE }, expiresAtMs: '600000' },
  ])('rejects invalid or expired refresh responses', async response => {
    const h = harness();
    h.request.mockResolvedValue(response);
    rememberHostedCanvasSurface(h.registration);
    const binding = captureHostedCanvasBinding(h.client, 7, 'profile-state-directory')!;
    await expect(binding.getResourceUrl(RESOURCE)).rejects.toThrow(
      'Hosted document authorization is unavailable.',
    );
    retireHostedCanvasSurface(h.client);
  });
});
