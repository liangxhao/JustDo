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
    await binding.update({ prompt: 'new', result: 'final' });
    click();
    const outbound = runtime.sendMessage.mock.calls.find(([message]) =>
      message.type.endsWith('launch'),
    )![0];
    expect(outbound.input).toEqual({ prompt: 'new', mode: 'draft', result: 'final' });
    expect(outbound.clickSequence).toBe(1);
    expect(outbound.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
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
    const original = runtime.sendMessage.getMockImplementation()!;
    runtime.sendMessage.mockImplementation(async message => {
      if (message.type.endsWith('launch')) {
        launchCount += 1;
        return { ok: false, code: 'REQUEST_TIMEOUT' };
      }
      return original(message);
    });
    const sdk = createChromeAssistant({ window, document, cryptoApi: webcrypto });
    await sdk.bind(
      document.getElementById('business'),
      { prompt: 'once' },
      { onRequest: handle => handles.push(handle) },
    );
    click();
    await vi.waitFor(() => expect(handles).toHaveLength(1));
    await handles[0].read();
    expect(
      runtime.sendMessage.mock.calls.some(
        ([message]) =>
          message.type.endsWith('read') &&
          message.requestId === handles[0].requestId &&
          !message.launchId,
      ),
    ).toBe(true);
    expect(launchCount).toBe(1);
  });

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
