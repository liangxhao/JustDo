// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installWebLaunchContent } from '../conversation-overlay/modules/web-launch-content.js';
import { createChromeAssistant } from '../conversation-overlay/modules/web-launch-sdk.js';
import { inputDigest } from '../conversation-overlay/modules/web-launch-security.js';

describe('webpage button bridge', () => {
  let content: ReturnType<typeof installWebLaunchContent>;
  let runtime: Record<string, ReturnType<typeof vi.fn>>;
  let launchCount: number;
  let poll: () => void;
  beforeEach(() => {
    vi.stubGlobal('TextEncoder', TextEncoder);
    document.body.innerHTML = '<button id="business" type="button"><span>Summarize</span></button>';
    vi.spyOn(window, 'postMessage').mockImplementation((data, origin) => {
      queueMicrotask(() =>
        window.dispatchEvent(
          new MessageEvent('message', { data, origin: String(origin), source: window }),
        ),
      );
    });
    Object.defineProperty(window.navigator, 'userActivation', {
      configurable: true,
      value: { isActive: true },
    });
    const setInterval = window.setInterval.bind(window);
    vi.spyOn(window, 'setInterval').mockImplementation((callback, delay) => {
      if (delay === 3000 && typeof callback === 'function') poll = callback;
      return setInterval(callback, delay);
    });
    launchCount = 0;
    runtime = {
      addListener: vi.fn(),
      removeListener: vi.fn(),
      sendMessage: vi.fn(async message => {
        if (message.type.endsWith('hello')) return { ok: true };
        if (message.type.endsWith('digest'))
          return { ok: true, digest: await inputDigest(message.input, webcrypto) };
        if (message.type.endsWith('launch')) {
          launchCount += 1;
          return {
            ok: true,
            documentLeaseId: 'private-lease',
            receipt: {
              requestId: message.requestId,
              launchId: 'launch-1',
              receiptRevision: 1,
              request: { status: 'drafted' },
              execution: { status: 'not-started', executionSettled: false },
              output: { status: 'awaiting-consent' },
              delivery: { status: 'connected' },
            },
          };
        }
        return { ok: true };
      }),
    };
    content = installWebLaunchContent({
      window,
      document,
      chromeApi: {
        runtime: { id: 'extension', sendMessage: runtime.sendMessage, onMessage: runtime },
      },
      cryptoApi: webcrypto,
    });
  });
  afterEach(() => {
    content?.dispose();
    window.dispatchEvent(new Event('pagehide'));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const click = () =>
    content!.handleClick({
      isTrusted: true,
      composedPath: () => [
        document.querySelector('span'),
        document.getElementById('business'),
        document,
        window,
      ],
    });

  it('binds a real element, freezes updated input before a synchronous click and never accepts programmatic clicks', async () => {
    const requests: unknown[] = [];
    const sdk = createChromeAssistant({ window, document, cryptoApi: webcrypto });
    const button = document.getElementById('business') as HTMLButtonElement;
    const binding = await sdk.bind(
      button,
      { prompt: 'old' },
      { onRequest: value => requests.push(value) },
    );
    button.click();
    expect(launchCount).toBe(0);
    await binding.update({ prompt: 'new', result: 'none' });
    click();
    const outbound = runtime.sendMessage.mock.calls.find(([message]) =>
      message.type.endsWith('launch'),
    )![0];
    const expectedInput = { prompt: 'new', mode: 'draft', result: 'none' };
    expect(outbound.input).toEqual(expectedInput);
    expect(outbound.clickSequence).toBe(1);
    expect(outbound.payloadDigest).toBe(await inputDigest(expectedInput, webcrypto));
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(JSON.stringify(requests[0])).not.toContain('private-lease');
    await binding.unbind();
    click();
    expect(launchCount).toBe(1);
  });

  it('rejects replacement elements and discards old bindings after pagehide', async () => {
    const sdk = createChromeAssistant({ window, document, cryptoApi: webcrypto });
    await sdk.bind(document.getElementById('business'), { prompt: 'original' });
    document.getElementById('business')!.outerHTML =
      '<button id="business" type="button"><span>Replacement</span></button>';
    click();
    expect(launchCount).toBe(0);
    window.dispatchEvent(new Event('pagehide'));
    click();
    expect(launchCount).toBe(0);
    expect(
      runtime.sendMessage.mock.calls.some(([message]) => message.type.endsWith('revoke')),
    ).toBe(true);
  });

  it('creates distinct handles for rapid clicks on the same button and promotes a queued receipt', async () => {
    const sdk = createChromeAssistant({ window, document, cryptoApi: webcrypto });
    const onRequest = vi.fn();
    const onStatus = vi.fn();
    const original = runtime.sendMessage.getMockImplementation()!;
    const onQueue = vi.fn();
    let releaseFirst!: (response: unknown) => void;
    runtime.sendMessage.mockImplementation(async message => {
      if (message.type.endsWith('launch') && message.clickSequence === 1)
        return new Promise(resolve => {
          releaseFirst = resolve;
        });
      if (message.type.endsWith('launch') && message.clickSequence === 2)
        return { ok: true, queueStatus: 'queued', queueReason: 'composer' };
      if (message.type.endsWith('read'))
        return {
          ok: true,
          receipt: {
            ...(await original({ ...message, type: 'launch' })).receipt,
            launchId: 'launch-2',
          },
        };
      return original(message);
    });
    const button = document.getElementById('business') as HTMLButtonElement;
    await sdk.bind(
      button,
      { prompt: 'Create a new report conversation' },
      { onRequest, onStatus, onQueue },
    );

    click();
    const first = runtime.sendMessage.mock.lastCall![0];
    click();
    const second = runtime.sendMessage.mock.lastCall![0];
    expect(second.clickSequence).toBe(2);
    expect(second.requestId).not.toBe(first.requestId);
    releaseFirst(await original(first));
    await vi.waitFor(() => expect(onQueue).toHaveBeenCalledOnce());
    const handles = onRequest.mock.calls.map(([handle]) => handle);
    expect(handles.map(handle => handle.requestId)).toEqual([first.requestId, second.requestId]);
    expect(handles[0].launchId).toBe('launch-1');
    expect(handles[1].launchId).toBeUndefined();
    expect(onQueue).toHaveBeenCalledWith({
      requestId: second.requestId,
      status: 'queued',
      message: expect.stringMatching(/draft.*side panel/u),
    });

    await handles[1].read();
    expect(handles[1].launchId).toBe('launch-2');
  });

  it('delivers an artifact-only exact result through the existing onResult callback', async () => {
    const onRequest = vi.fn();
    const onResult = vi.fn();
    const original = runtime.sendMessage.getMockImplementation()!;
    const artifacts = [{ name: 'report.pdf', kind: 'document', mimeType: 'application/pdf' }];
    runtime.sendMessage.mockImplementation(async message => {
      if (!message.type.endsWith('read')) return original(message);
      return {
        ok: true,
        receipt: {
          requestId: message.requestId,
          launchId: 'launch-1',
          receiptRevision: 2,
          request: { status: 'submitted' },
          execution: { status: 'completed', executionSettled: true },
          output: { status: 'available', artifacts },
          delivery: { status: 'connected' },
        },
      };
    });
    const sdk = createChromeAssistant({ window, document, cryptoApi: webcrypto });
    await sdk.bind(
      document.getElementById('business'),
      { prompt: 'Create a report' },
      { onRequest, onResult },
    );
    click();
    await vi.waitFor(() => expect(onRequest).toHaveBeenCalledOnce());
    poll();
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledOnce());
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: onRequest.mock.calls[0][0].requestId,
        output: { status: 'available', artifacts },
      }),
    );
  });

  it('times out without an installed bridge rather than queueing a later click', async () => {
    content!.dispose();
    content = null;
    vi.useFakeTimers();
    const sdk = createChromeAssistant({ window, document, cryptoApi: webcrypto });
    const pending = sdk.bind(document.getElementById('business'), { prompt: 'hello' });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'BRIDGE_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(5001);
    await rejected;
    expect(launchCount).toBe(0);
    vi.useRealTimers();
  });

  it('supports HTTP intranet crypto without secure-context randomUUID or subtle', async () => {
    content!.dispose();
    const insecureCrypto = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) };
    content = installWebLaunchContent({
      window,
      document,
      chromeApi: {
        runtime: { id: 'extension', sendMessage: runtime.sendMessage, onMessage: runtime },
      },
      cryptoApi: insecureCrypto,
    });
    const sdk = createChromeAssistant({ window, document, cryptoApi: insecureCrypto });
    await sdk.bind(document.getElementById('business'), { prompt: 'HTTP business data' });
    click();
    const outbound = runtime.sendMessage.mock.calls.find(([message]) =>
      message.type.endsWith('launch'),
    )![0];
    expect(outbound.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(outbound.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(
      runtime.sendMessage.mock.calls.some(([message]) => message.type.endsWith('digest')),
    ).toBe(true);
  });

  it('queries by request identity after a prepare ACK is lost, without generating another launch', async () => {
    const handles: any[] = [];
    const errors: string[] = [];
    const original = runtime.sendMessage.getMockImplementation()!;
    let releaseFirstRead!: (response: { ok: boolean; code: string }) => void;
    runtime.sendMessage.mockImplementation(async message => {
      if (message.type.endsWith('launch')) {
        launchCount += 1;
        return { ok: false, code: 'REQUEST_TIMEOUT', prepareUncertain: true };
      }
      if (message.type.endsWith('read')) {
        if (!releaseFirstRead)
          return new Promise(resolve => {
            releaseFirstRead = resolve;
          });
        return {
          ok: true,
          receipt: {
            requestId: message.requestId,
            launchId: 'launch-1',
            receiptRevision: 1,
            request: { status: 'drafted' },
            execution: { status: 'not-started', executionSettled: false },
            output: { status: 'awaiting-consent' },
            delivery: { status: 'connected' },
          },
        };
      }
      return original(message);
    });
    const sdk = createChromeAssistant({ window, document, cryptoApi: webcrypto });
    await sdk.bind(
      document.getElementById('business'),
      { prompt: 'once' },
      { onRequest: handle => handles.push(handle), onError: error => errors.push(error.code) },
    );
    click();
    await vi.waitFor(() => expect(handles).toHaveLength(1));
    const staleRead = handles[0].read();
    await vi.waitFor(() => expect(releaseFirstRead).toBeTypeOf('function'));
    await expect(handles[0].read()).resolves.toMatchObject({
      receipt: { launchId: 'launch-1' },
    });
    releaseFirstRead({ ok: false, code: 'EXPIRED' });
    await expect(staleRead).resolves.toMatchObject({ ok: true });
    poll();
    expect(runtime.sendMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'web-launch:document:read', launchId: 'launch-1' }),
    );
    expect(errors).toEqual(['REQUEST_TIMEOUT']);
    expect(
      runtime.sendMessage.mock.calls.filter(
        ([message]) =>
          message.type.endsWith('read') &&
          message.requestId === handles[0].requestId &&
          !message.launchId,
      ),
    ).toHaveLength(2);
    expect(launchCount).toBe(1);
  });

  it('keeps the confirmed composer-busy failure for the original handle and never polls it', async () => {
    const handles: any[] = [];
    const errors: string[] = [];
    const original = runtime.sendMessage.getMockImplementation()!;
    runtime.sendMessage.mockImplementation(async message => {
      if (message.type.endsWith('launch')) return { ok: false, code: 'COMPOSER_BUSY' };
      if (message.type.endsWith('read')) return { ok: false, code: 'EXPIRED' };
      return original(message);
    });
    const sdk = createChromeAssistant({ window, document, cryptoApi: webcrypto });
    await sdk.bind(
      document.getElementById('business'),
      { prompt: 'request with busy composer' },
      { onRequest: handle => handles.push(handle), onError: error => errors.push(error.code) },
    );
    click();
    await vi.waitFor(() => expect(errors).toEqual(['COMPOSER_BUSY']));
    poll();
    await expect(handles[0].read()).rejects.toMatchObject({ code: 'COMPOSER_BUSY' });
    expect(runtime.sendMessage.mock.calls.some(([message]) => message.type.endsWith('read'))).toBe(
      false,
    );
    expect(errors).toEqual(['COMPOSER_BUSY']);
  });

  it.each([
    { status: 'cancelled', expectedReads: 0 },
    { status: 'drafted', expectedReads: 1 },
  ])(
    'stops polling after a $status receipt is closed or its known launch expires',
    async ({ status, expectedReads }) => {
      const original = runtime.sendMessage.getMockImplementation()!;
      runtime.sendMessage.mockImplementation(async message => {
        if (message.type.endsWith('read')) return { ok: false, code: 'EXPIRED' };
        const result = await original(message);
        if (message.type.endsWith('launch')) result.receipt.request.status = status;
        return result;
      });
      const onStatus = vi.fn();
      const onError = vi.fn();
      const sdk = createChromeAssistant({ window, document, cryptoApi: webcrypto });
      await sdk.bind(
        document.getElementById('business'),
        { prompt: 'one launch' },
        { onStatus, onError },
      );
      click();
      await vi.waitFor(() => expect(onStatus).toHaveBeenCalledOnce());
      poll();
      if (expectedReads) await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
      poll();
      expect(
        runtime.sendMessage.mock.calls.filter(([message]) => message.type.endsWith('read')),
      ).toHaveLength(expectedReads);
      expect(onError).toHaveBeenCalledTimes(expectedReads);
    },
  );

  it('retires old handles on soft navigation while preserving a binding and its document sequence', async () => {
    const handles: any[] = [];
    const sdk = createChromeAssistant({ window, document, cryptoApi: webcrypto });
    await sdk.bind(
      document.getElementById('business'),
      { prompt: 'record snapshot' },
      { onRequest: handle => handles.push(handle) },
    );
    click();
    await vi.waitFor(() => expect(handles).toHaveLength(1));
    const first = runtime.sendMessage.mock.calls.find(([message]) =>
      message.type.endsWith('launch'),
    )![0];
    const probe = runtime.addListener.mock.calls[0][0];
    probe(
      { type: 'web-launch:document:retire', documentNonce: first.documentNonce },
      { id: 'extension' },
      vi.fn(),
    );
    await new Promise(resolve => queueMicrotask(resolve));
    await expect(handles[0].read()).rejects.toMatchObject({ code: 'EXPIRED' });
    click();
    const launches = runtime.sendMessage.mock.calls.filter(([message]) =>
      message.type.endsWith('launch'),
    );
    expect(launches[1][0].clickSequence).toBe(2);
    expect(launches[1][0].documentNonce).not.toBe(first.documentNonce);
    expect(launches[1][0].documentLeaseId).toBeUndefined();
  });
});
