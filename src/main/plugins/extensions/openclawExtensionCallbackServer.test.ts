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

const postJson = (
  url: string,
  body: unknown,
  secret: string,
): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request(url, {
      method: 'POST',
      agent: false,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'x-ask-user-secret': secret,
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    request.end(payload);
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

  it('rejects duplicate question ids at the HTTP boundary', async () => {
    server = new OpenClawExtensionCallbackServer('test-secret');
    await server.start();
    const question = {
      id: 'duplicate',
      question: 'Continue?',
      options: [
        { id: 'yes', label: 'Yes' },
        { id: 'no', label: 'No' },
      ],
    };

    const response = await postJson(server.askUserCallbackUrl!, {
      questions: [question, question],
    }, 'test-secret');

    expect(response.status).toBe(400);
    expect(response.body).toContain('Invalid');
  });

  it('waits without a default answer and denies the request when the host stops', async () => {
    server = new OpenClawExtensionCallbackServer('test-secret');
    let notifyRequest: (() => void) | undefined;
    const requestReceived = new Promise<void>(resolve => {
      notifyRequest = resolve;
    });
    server.onAskUser(() => notifyRequest?.());
    await server.start();

    const pendingResponse = postJson(server.askUserCallbackUrl!, {
      questions: [{
        id: 'continue',
        question: 'Continue?',
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
      }],
    }, 'test-secret');
    await requestReceived;

    await server.stop();

    await expect(pendingResponse).resolves.toMatchObject({
      status: 200,
      body: JSON.stringify({ behavior: 'deny' }),
    });
  });

  it('cancels a pending interaction when the HTTP caller disconnects', async () => {
    server = new OpenClawExtensionCallbackServer('test-secret');
    let notifyRequest: (() => void) | undefined;
    let notifyDismiss: (() => void) | undefined;
    const requestReceived = new Promise<void>(resolve => {
      notifyRequest = resolve;
    });
    const requestDismissed = new Promise<void>(resolve => {
      notifyDismiss = resolve;
    });
    server.onAskUser(() => notifyRequest?.());
    server.onAskUserDismiss(() => notifyDismiss?.());
    await server.start();

    const payload = JSON.stringify({
      questions: [{
        id: 'continue',
        question: 'Continue?',
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
      }],
    });
    const request = http.request(server.askUserCallbackUrl!, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'x-ask-user-secret': 'test-secret',
      },
    });
    const requestClosed = new Promise<void>(resolve => {
      request.once('error', () => resolve());
      request.once('close', () => resolve());
    });
    request.end(payload);
    await requestReceived;

    request.destroy();

    await requestDismissed;
    await requestClosed;
    expect(server.listPendingAskUserRequests()).toEqual([]);
  });

  it('serializes overlapping stop and restart operations', async () => {
    server = new OpenClawExtensionCallbackServer('test-secret');
    await server.start();

    const stopping = server.stop();
    const restarting = server.start();
    await Promise.all([stopping, restarting]);

    expect(server.askUserCallbackUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/askuser$/);
    await expect(postWithoutSecret(server.askUserCallbackUrl!)).resolves.toBe(401);
  });
});
