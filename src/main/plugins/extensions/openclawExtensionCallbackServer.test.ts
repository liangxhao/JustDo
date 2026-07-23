import http from 'http';
import { afterEach, describe, expect, it } from 'vitest';

import { OpenClawExtensionCallbackServer } from './openclawExtensionCallbackServer';

const postWithoutSecret = (url: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'POST', agent: false }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode ?? 0));
    });
    request.once('error', reject);
    request.end('{}');
  });

describe('OpenClawExtensionCallbackServer', () => {
  let server: OpenClawExtensionCallbackServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('publishes only a live callback URL and can restart after stopping', async () => {
    server = new OpenClawExtensionCallbackServer('test-secret');

    await server.start();
    const firstUrl = server.askUserCallbackUrl;

    expect(firstUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/askuser$/);
    await expect(postWithoutSecret(firstUrl!)).resolves.toBe(401);

    await server.stop();
    expect(server.port).toBeNull();
    expect(server.askUserCallbackUrl).toBeNull();

    await server.start();
    const restartedUrl = server.askUserCallbackUrl;

    expect(restartedUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/askuser$/);
    await expect(postWithoutSecret(restartedUrl!)).resolves.toBe(401);
  });
});
