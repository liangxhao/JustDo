// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://business.test:8443/record"}
import { createHash, webcrypto } from 'node:crypto';
import { TextEncoder } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalWebLaunchInput, WebLaunchMethod } from '../contracts/webLaunch';
import { createWebLaunchBackground } from '../conversation-overlay/modules/web-launch-background.js';
import { createChromeAssistant } from '../conversation-overlay/modules/web-launch-sdk.js';
import { installWebLaunchContent } from '../conversation-overlay/modules/web-launch-content.js';
import { inputDigest } from '../conversation-overlay/modules/web-launch-security.js';

const extensionId = 'fixture-extension';
const source = {
  origin: 'https://business.test:8443',
  url: 'https://business.test:8443/record',
  documentId: 'document-1',
  documentLifecycle: 'active',
  frameId: 0,
  tab: { id: 7, windowId: 3 },
};
const panel = {
  id: extensionId,
  frameId: 0,
  url: `chrome-extension://${extensionId}/sidepanel.html?tabId=7`,
};
const panelScope = { panelInstanceId: 'panel-1', tabId: 7, windowId: 3 };
const input = { prompt: 'Frozen first click', mode: 'send', result: 'final' };

describe('first website connection', () => {
  let api: any;
  let storage: Record<string, any>;
  let controller: ReturnType<typeof createWebLaunchBackground>;
  let client: { request: ReturnType<typeof vi.fn> };
  let content: ReturnType<typeof installWebLaunchContent>;
  let click: (event: any) => void;
  let siteRevision: number;
  let policies: any[];
  let permitted: boolean;
  let currentDocument: string;
  let contentListeners: any[];
  let updated: (id: number, change: any) => void;
  let readyMessage: any;
  let contentSend: (message: any) => Promise<any>;
  let externalSend: (message: any) => Promise<any>;
  let sdk: ReturnType<typeof createChromeAssistant>;
  const invoke = (message: any, sender = panel) =>
    new Promise<any>(resolve => controller.handleMessage(message, sender, resolve));
  const external = (message: any, sender: any = source) =>
    new Promise<any>(resolve =>
      controller.handleExternalMessage(
        { type: 'web-launch:connection', ...message },
        sender,
        resolve,
      ),
    );
  const registerPanel = () =>
    invoke({
      type: 'web-launch:panel:register',
      ...panelScope,
      composerBusy: false,
    });
  const decision = (value: any, decision = 'allow', extra = {}) =>
    invoke({
      type: 'web-launch:connection:decide',
      ...panelScope,
      pendingId: value.pendingId,
      expectedRevision: value.revision,
      decision,
      ...extra,
    });
  const request = async (bindingId = 'binding-1') =>
    external({
      op: 'request',
      bindingId,
      bindingRevision: 1,
      input,
      payloadDigest: await inputDigest(input, webcrypto),
    });
  const trustedClick = () => {
    const event = {
      isTrusted: true,
      composedPath: () => [document.getElementById('launch'), document, window],
    };
    click(event);
    content?.handleClick(event);
  };
  const newSdk = () => {
    click = undefined as any;
    return createChromeAssistant({
      window,
      document,
      cryptoApi: webcrypto,
      extensionId,
      runtimeApi: { sendMessage: (_id: string, message: any) => externalSend(message) },
    });
  };

  beforeEach(async () => {
    vi.stubGlobal('TextEncoder', TextEncoder);
    document.body.innerHTML = '<button type="button" id="launch">Ask</button>';
    storage = {};
    permitted = false;
    siteRevision = 1;
    policies = [];
    currentDocument = source.documentId;
    contentListeners = [];
    readyMessage = undefined;
    content = null;
    contentSend = message => invoke(message, { ...source, id: extensionId });
    externalSend = message => external(message);
    Object.defineProperty(window.navigator, 'userActivation', {
      configurable: true,
      value: { isActive: true },
    });
    vi.spyOn(window, 'postMessage').mockImplementation((data, origin) => {
      queueMicrotask(() =>
        window.dispatchEvent(
          new MessageEvent('message', { data, origin: String(origin), source: window }),
        ),
      );
    });
    const add = document.addEventListener.bind(document);
    vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
      if (type === 'click' && !click) click = listener as any;
      add(type, listener, options);
    });
    const area = {
      get: vi.fn(async (key: string) => ({ [key]: structuredClone(storage[key]) })),
      set: vi.fn(async value => Object.assign(storage, structuredClone(value))),
    };
    api = {
      runtime: {
        id: extensionId,
        getURL: (path: string) => `chrome-extension://${extensionId}/${path}`,
        getManifest: () => ({ version: '1' }),
        sendMessage: vi.fn(async () => ({})),
        onMessage: {
          addListener: (listener: any) => contentListeners.push(listener),
          removeListener: vi.fn(),
        },
      },
      storage: { session: area, local: area },
      sidePanel: { open: vi.fn(() => Promise.resolve()), setOptions: vi.fn(async () => {}) },
      permissions: {
        contains: vi.fn(async () => permitted),
        request: vi.fn(() => {
          permitted = true;
          return Promise.resolve(true);
        }),
        onRemoved: { addListener: vi.fn() },
      },
      tabs: {
        get: vi.fn(async () => ({ url: source.url, windowId: source.tab.windowId })),
        sendMessage: vi.fn(async (_tab, message, target) => {
          if (target.documentId !== currentDocument) throw new Error('Document gone');
          if (message.type.endsWith('connection-ready')) readyMessage = message;
          let response;
          for (const listener of contentListeners)
            listener(message, { id: extensionId }, value => {
              response = value;
            });
          return response;
        }),
        onUpdated: {
          addListener: (listener: any) => {
            updated = listener;
          },
        },
        onRemoved: { addListener: vi.fn() },
      },
      windows: { onRemoved: { addListener: vi.fn() } },
      scripting: {
        getRegisteredContentScripts: vi.fn(async () => []),
        unregisterContentScripts: vi.fn(async () => {}),
        registerContentScripts: vi.fn(async () => {}),
        executeScript: vi.fn(async details => {
          if (details.target.documentIds[0] !== currentDocument) throw new Error('Document gone');
          if (details.files && !content)
            content = installWebLaunchContent({
              window,
              document,
              cryptoApi: webcrypto,
              chromeApi: {
                runtime: {
                  ...api.runtime,
                  sendMessage: message => contentSend(message),
                },
              },
            });
          return [{ documentId: currentDocument, result: { origin: source.origin, active: true } }];
        }),
      },
    };
    client = {
      request: vi.fn(async (method, params) => {
        if (method === WebLaunchMethod.SitesRead)
          return { revision: siteRevision, sites: structuredClone(policies) };
        if (method === WebLaunchMethod.SitesWrite) {
          if (params.expectedRevision !== siteRevision) throw { code: 'POLICY_CONFLICT' };
          siteRevision += 1;
          policies = [
            {
              origin: params.origin,
              enabled: true,
              allowSend: params.allowSend,
              allowResult: params.allowResult,
              revision: siteRevision,
            },
          ];
          return { revision: siteRevision, sites: structuredClone(policies) };
        }
        if (method === WebLaunchMethod.Prepare)
          return {
            receipt: {
              requestId: params.requestId,
              launchId: 'launch-1',
              receiptRevision: 1,
              request: { status: 'drafted' },
              execution: { status: 'not-started', executionSettled: false },
              output: { status: 'awaiting-consent' },
              delivery: { status: 'connected' },
            },
            internal: {
              threadId: 'private-thread',
              documentLeaseId: 'private-lease',
              composeRevision: 1,
              deadlineAt: Date.now() + 60_000,
              requiresSendConfirmation: true,
              requiresResultConsent: true,
            },
          };
        return { observations: [] };
      }),
    };
    controller = createWebLaunchBackground({ chromeApi: api, cryptoApi: webcrypto, client });
    sdk = newSdk();
    await registerPanel();
  });
  afterEach(() => {
    content?.dispose();
    window.dispatchEvent(new Event('pagehide'));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('wires unconnected bind, a captured click, trusted permission/decision, exact-document injection and one manual prepare', async () => {
    const events: string[] = [];
    const button = document.getElementById('launch') as HTMLButtonElement;
    await sdk.bind(button, input, {
      onConnection: value => {
        events.push(`connection:${value.status}`);
        if (value.status === 'pending') button.disabled = true;
        expect(JSON.stringify(value)).not.toMatch(/pendingId|private/);
      },
      onRequest: () => events.push('request'),
      onStatus: () => events.push('status'),
    });
    expect(client.request).not.toHaveBeenCalled();
    trustedClick();
    await vi.waitFor(async () =>
      expect((await registerPanel()).connectionPending?.requiresAction).toBe(true),
    );
    const pending = (await registerPanel()).connectionPending;
    expect(api.sidePanel.open).toHaveBeenCalledOnce();
    const granted = api.permissions.request({ origins: ['https://business.test/*'] });
    await granted;
    expect((await decision(pending)).ok).toBe(true);
    await vi.waitFor(() => expect(events).toContain('status'));
    expect(events.indexOf('request')).toBeLessThan(events.indexOf('status'));
    const prepares = client.request.mock.calls.filter(
      ([method]) => method === WebLaunchMethod.Prepare,
    );
    expect(prepares).toHaveLength(1);
    expect(policies).toEqual([
      { origin: source.origin, enabled: true, allowSend: true, allowResult: true, revision: 2 },
    ]);
    expect(prepares[0][1]).toMatchObject({
      input,
      connectionOnly: true,
      expectedPolicyRevision: 2,
      clickSequence: 1,
    });
    expect(client.request.mock.calls.some(([method]) => method === WebLaunchMethod.Submit)).toBe(
      false,
    );
    expect(api.sidePanel.open).toHaveBeenCalledOnce();
    expect(
      api.scripting.executeScript.mock.calls.every(
        ([details]) => details.target.documentIds[0] === source.documentId,
      ),
    ).toBe(true);
    expect(
      (
        await invoke(
          {
            type: 'web-launch:document:connection-launch',
            documentNonce: 'other',
            requestId: 'replay',
            pendingId: pending.pendingId,
            bindingId: readyMessage.bindingId,
            bindingRevision: 1,
            clickSequence: 2,
            payloadDigest: readyMessage.payloadDigest,
            input,
          },
          { ...source, id: extensionId },
        )
      ).ok,
    ).toBe(false);
    expect(
      client.request.mock.calls.filter(([method]) => method === WebLaunchMethod.Prepare),
    ).toHaveLength(1);
  });

  it('does not persist pending, occupy a window, inject or use native RPC until the Chrome gesture gate succeeds', async () => {
    api.sidePanel.open.mockRejectedValue(new Error('User gesture required'));
    expect(await request()).toEqual({ ok: false, code: 'PANEL_OPEN_FAILED' });
    expect((await registerPanel()).connectionPending).toBeNull();
    expect(client.request).not.toHaveBeenCalled();
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
    api.sidePanel.open.mockResolvedValue(undefined);
    expect((await request()).ok).toBe(true);
  });

  it('rejects external private RPC, foreign extensions, iframes and mismatched origins before opening', async () => {
    for (const from of [
      { ...source, id: 'other-extension' },
      { ...source, frameId: 1 },
      { ...source, origin: 'https://other.test' },
    ])
      expect((await external({ op: 'probe' }, from)).ok).toBe(false);
    expect((await external({ op: 'probe', method: WebLaunchMethod.SitesRead })).ok).toBe(false);
    expect(api.sidePanel.open).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
  });

  it('fences an old grant after policy changes even if the site is enabled, and never resets existing grants', async () => {
    const pending = (await request()).connectionPending;
    permitted = true;
    siteRevision = 2;
    policies = [
      { origin: source.origin, enabled: true, allowSend: true, allowResult: true, revision: 2 },
    ];
    expect(await decision(pending)).toEqual({ ok: false, code: 'POLICY_CONFLICT' });
    expect(
      client.request.mock.calls.some(([method]) => method === WebLaunchMethod.SitesWrite),
    ).toBe(false);
    expect(policies[0]).toMatchObject({ allowSend: true, allowResult: true });
  });

  it('repairs the bridge of an already granted document before the next real click', async () => {
    permitted = true;
    policies = [
      { origin: source.origin, enabled: true, allowSend: true, allowResult: true, revision: 1 },
    ];
    storage.chromeWebLaunchSites = [source.origin];
    const events: string[] = [];
    await sdk.bind(document.getElementById('launch'), input, {
      onRequest: () => events.push('request'),
    });
    expect(api.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: source.tab.id, documentIds: [source.documentId] },
      files: ['web-launch-content.js'],
    });
    expect(client.request).not.toHaveBeenCalledWith(WebLaunchMethod.Prepare, expect.anything());
    trustedClick();
    await vi.waitFor(() => expect(events).toContain('request'));
    await vi.waitFor(() =>
      expect(client.request).toHaveBeenCalledWith(WebLaunchMethod.Prepare, expect.anything()),
    );
    expect((await registerPanel()).connectionPending).toBeNull();
    expect(
      client.request.mock.calls.some(([method]) => method === WebLaunchMethod.SitesWrite),
    ).toBe(false);
    expect(policies[0]).toMatchObject({ allowSend: true, allowResult: true });
    expect(
      client.request.mock.calls.find(([method]) => method === WebLaunchMethod.Prepare)?.[1],
    ).not.toHaveProperty('connectionOnly');
  });

  it('waits to offer consent while a task is active and guides a competing connection back to its existing prompt', async () => {
    permitted = true;
    policies = [
      { origin: source.origin, enabled: true, allowSend: true, allowResult: true, revision: 1 },
    ];
    storage.chromeWebLaunchGrantedOrigins = [source.origin];
    const handles: any[] = [];
    await sdk.bind(document.getElementById('launch'), input, {
      onRequest: handle => handles.push(handle),
    });
    trustedClick();
    await vi.waitFor(() => expect(handles[0]?.launchId).toBe('launch-1'));

    controller = createWebLaunchBackground({ chromeApi: api, cryptoApi: webcrypto, client });
    const first = await request('waiting-connection');
    expect(first.connectionPending).toMatchObject({
      status: 'waiting-for-window',
      requiresAction: false,
    });
    expect((await registerPanel()).connectionPending).toBeNull();
    expect(await request('other-connection')).toEqual({
      ok: false,
      code: 'WINDOW_BUSY',
      busyReason: 'connection',
    });
    const stored = storage.chromeWebLaunchSession.requests[handles[0].requestId].response;
    const original = client.request.getMockImplementation()!;
    client.request.mockImplementation(async (method, params) =>
      method === WebLaunchMethod.Observations
        ? {
            observations: [
              {
                ...stored,
                receipt: {
                  ...stored.receipt,
                  receiptRevision: stored.receipt.receiptRevision + 1,
                  execution: { status: 'completed', executionSettled: true },
                },
              },
            ],
          }
        : original(method, params),
    );
    const later = Date.now() + 6_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    await vi.waitFor(async () => {
      const ready = await external({ op: 'query', pendingId: first.connectionPending.pendingId });
      expect(ready.connectionPending).toMatchObject({
        status: 'awaiting-consent',
        requiresAction: true,
      });
    });
    expect((await registerPanel()).connectionPending.pendingId).toBe(
      first.connectionPending.pendingId,
    );
    expect(
      client.request.mock.calls.filter(([method]) => method === WebLaunchMethod.Prepare),
    ).toHaveLength(1);
    expect(client.request).not.toHaveBeenCalledWith(WebLaunchMethod.SitesWrite, expect.anything());
  });

  it.each([
    { code: 'WINDOW_BUSY', busyReason: 'connection', message: /先前发起连接的标签页/u },
    { code: 'CAPACITY_EXCEEDED', message: /等待|等一笔完成/u },
    { code: 'PANEL_OPEN_FAILED', message: /工具栏.*扩展图标/u },
  ])(
    'gives actionable guidance and accepts the next click after $code',
    async ({ code, busyReason, message }) => {
      vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('zh-CN');
      sdk = newSdk();
      const attempts = vi.fn();
      externalSend = async value => {
        if (value.op !== 'request') return external(value);
        attempts();
        return { ok: false, code, busyReason };
      };
      const onError = vi.fn();
      const onConnection = vi.fn();
      await sdk.bind(document.getElementById('launch'), input, { onError, onConnection });

      trustedClick();
      await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
      expect(onError.mock.calls[0][0].code).toBe(code);
      expect(onError.mock.calls[0][0].message).toMatch(message);
      expect(onConnection).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: 'rejected',
          message: expect.stringMatching(message),
        }),
      );
      trustedClick();
      await vi.waitFor(() => expect(attempts).toHaveBeenCalledTimes(2));
    },
  );

  it('falls back to inline connection while the desktop app is slow to check a legacy grant', async () => {
    storage.chromeWebLaunchSites = [source.origin];
    let finishRead!: (value: unknown) => void;
    client.request.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishRead = resolve;
        }),
    );
    vi.useFakeTimers();
    try {
      const probe = external({ op: 'probe' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(await probe).toEqual({ ok: true, connected: false });
    } finally {
      vi.useRealTimers();
      finishRead?.({ sites: [], revision: 1 });
    }
  });

  it('uses the webpage configuration after an existing site approves the expanded connection', async () => {
    permitted = true;
    policies = [
      { origin: source.origin, enabled: true, allowSend: true, allowResult: false, revision: 1 },
    ];
    storage.chromeWebLaunchSites = [source.origin];
    const handles: any[] = [];
    await sdk.bind(document.getElementById('launch'), input, {
      onRequest: handle => handles.push(handle),
    });
    trustedClick();
    await vi.waitFor(async () =>
      expect((await registerPanel()).connectionPending?.requiresAction).toBe(true),
    );
    expect(policies[0].allowResult).toBe(false);
    expect(client.request.mock.calls.some(([method]) => method === WebLaunchMethod.Prepare)).toBe(
      false,
    );

    expect((await decision((await registerPanel()).connectionPending)).ok).toBe(true);
    await vi.waitFor(() => expect(handles[0]?.launchId).toBe('launch-1'));
    expect(await external({ op: 'probe' })).toMatchObject({ connected: true });
    const first = client.request.mock.calls.find(
      ([method]) => method === WebLaunchMethod.Prepare,
    )![1];
    expect(first).toMatchObject({ connectionOnly: true, expectedPolicyRevision: 2, input });

    const closed = structuredClone(
      storage.chromeWebLaunchSession.requests[first.requestId].response,
    );
    closed.receipt.request.status = 'submitted';
    closed.receipt.execution = { status: 'completed', executionSettled: true };
    closed.receipt.output = { status: 'available', text: 'First reply', format: 'text' };
    const requestNative = client.request.getMockImplementation()!;
    client.request.mockImplementation(async (method, params) => {
      if (method === WebLaunchMethod.Read) return closed;
      const response = await requestNative(method, params);
      if (method === WebLaunchMethod.Prepare) response.receipt.launchId = 'launch-2';
      return response;
    });
    expect((await handles[0].read()).receipt.output.text).toBe('First reply');
    trustedClick();
    await vi.waitFor(() => expect(handles[1]?.launchId).toBe('launch-2'));
    const prepares = client.request.mock.calls.filter(
      ([method]) => method === WebLaunchMethod.Prepare,
    );
    expect(prepares).toHaveLength(2);
    expect(prepares[1][1]).toMatchObject({ clickSequence: 2, input });
    expect(prepares[1][1]).not.toHaveProperty('connectionOnly');
    expect(
      client.request.mock.calls.filter(([method]) => method === WebLaunchMethod.SitesWrite),
    ).toHaveLength(1);
  });

  it('lets rejection overtake an in-flight grant with the old displayed revision before any policy write', async () => {
    const pending = (await request()).connectionPending;
    const original = client.request.getMockImplementation()!;
    let release!: (value: unknown) => void;
    client.request.mockImplementation(async (method, params) =>
      method === WebLaunchMethod.SitesRead
        ? new Promise(resolve => {
            release = resolve;
          })
        : original(method, params),
    );
    permitted = true;
    const allowing = decision(pending);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect((await decision(pending, 'deny')).connectionPending.status).toBe('rejected');
    release({ revision: 1, sites: [] });
    expect((await allowing).ok).toBe(false);
    expect(
      client.request.mock.calls.some(
        ([method]) => method === WebLaunchMethod.SitesWrite || method === WebLaunchMethod.Prepare,
      ),
    ).toBe(false);
    expect(api.scripting.executeScript.mock.calls.some(([details]) => details.files)).toBe(false);
  });

  it('exposes consent and accepts decisions only from its registered tab within the same window', async () => {
    const pending = (await request()).connectionPending;
    expect(api.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        ...panelScope,
        connectionPending: expect.objectContaining({ pendingId: pending.pendingId }),
      }),
    );
    const message = {
      type: 'web-launch:connection:decide',
      pendingId: pending.pendingId,
      expectedRevision: pending.revision,
      decision: 'allow',
      ...panelScope,
    };
    for (const sender of [
      { ...panel, url: `chrome-extension://${extensionId}/options.html` },
      { ...panel, url: `chrome-extension://${extensionId}/popup.html` },
    ])
      expect(await invoke(message, sender)).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(await invoke({ ...message, panelInstanceId: 'stale-panel' })).toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
    const otherPanel = {
      ...panel,
      url: `chrome-extension://${extensionId}/sidepanel.html?tabId=8`,
    };
    const otherScope = { ...panelScope, panelInstanceId: 'another-panel', tabId: 8 };
    expect(
      await invoke({ type: 'web-launch:panel:register', ...otherScope }, otherPanel),
    ).toMatchObject({ ok: true, connectionPending: null });
    expect(await invoke({ ...message, ...otherScope }, otherPanel)).toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
    expect(api.permissions.request).not.toHaveBeenCalled();
  });

  it('allows cached pagehide cancellation, rejects another document and never revives it after BFCache', async () => {
    const pending = (await request()).connectionPending;
    expect(
      (
        await external(
          { op: 'cancel', pendingId: pending.pendingId },
          { ...source, documentId: 'document-2', documentLifecycle: 'cached' },
        )
      ).ok,
    ).toBe(false);
    expect(
      (
        await external(
          { op: 'cancel', pendingId: pending.pendingId },
          { ...source, documentLifecycle: 'cached' },
        )
      ).connectionPending.status,
    ).toBe('cancelled');
    expect(
      (await external({ op: 'query', pendingId: pending.pendingId })).connectionPending.status,
    ).toBe('cancelled');
    expect((await decision(pending)).ok).toBe(false);
  });

  it('notifies an open panel of navigation expiry without replaying it when the panel reopens', async () => {
    const pending = (await request()).connectionPending;
    updated(source.tab.id, { status: 'loading' });
    await vi.waitFor(() =>
      expect(api.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          ...panelScope,
          connectionPending: expect.objectContaining({
            pendingId: pending.pendingId,
            status: 'expired',
          }),
        }),
      ),
    );
    expect(
      await invoke({
        type: 'web-launch:panel:register',
        ...panelScope,
        panelInstanceId: 'reopened-panel',
      }),
    ).toMatchObject({ ok: true, connectionPending: null });
    expect(await external({ op: 'query', pendingId: pending.pendingId })).toMatchObject({
      ok: true,
      connectionPending: { pendingId: pending.pendingId, status: 'expired' },
    });
  });

  it('never creates pending after a navigation during deferred digest validation', async () => {
    let release: () => void;
    const cryptoApi = {
      randomUUID: webcrypto.randomUUID.bind(webcrypto),
      subtle: {
        digest: async (...args: any[]) => {
          await new Promise<void>(resolve => {
            release = resolve;
          });
          return (webcrypto.subtle.digest as any)(...args);
        },
      },
    };
    controller = createWebLaunchBackground({ chromeApi: api, cryptoApi, client });
    const pending = request();
    await vi.waitFor(() => expect(release!).toBeTypeOf('function'));
    updated(7, { status: 'loading' });
    release!();
    expect((await pending).ok).toBe(false);
    expect((await registerPanel()).connectionPending).toBeNull();
  });

  it('selects the new pending after rejection and preserves a single frozen input while consent is outstanding', async () => {
    const binding = await sdk.bind(document.getElementById('launch'), input);
    trustedClick();
    await vi.waitFor(async () =>
      expect((await registerPanel()).connectionPending?.requiresAction).toBe(true),
    );
    const first = (await registerPanel()).connectionPending;
    await expect(binding.update({ prompt: 'Mutated after click' })).rejects.toMatchObject({
      code: 'REQUEST_CONFLICT',
    });
    await decision(first, 'deny');
    // The SDK query is read-only and observes the retired request before a new genuine click.
    await vi.waitFor(() =>
      expect(storage.chromeWebLaunchSession.connections[first.pendingId].status).toBe('rejected'),
    );
    await new Promise(resolve => setTimeout(resolve, 1050));
    trustedClick();
    await vi.waitFor(async () => {
      const pending = (await registerPanel()).connectionPending;
      expect(pending?.requiresAction).toBe(true);
      expect(pending?.pendingId).not.toBe(first.pendingId);
    });
    const latest = (await registerPanel()).connectionPending;
    const queried = await external({
      op: 'query',
      bindingId:
        readyMessage?.bindingId ??
        Object.values(storage.chromeWebLaunchSession.connections).at(-1)!.bindingId,
    });
    expect(queried.connectionPending.pendingId).toBe(latest.pendingId);
    permitted = true;
    expect((await decision(latest)).ok).toBe(true);
    await vi.waitFor(() =>
      expect(client.request.mock.calls.some(([method]) => method === WebLaunchMethod.Prepare)).toBe(
        true,
      ),
    );
  });

  it('uses the same HTTP-compatible SHA-256 digest for Unicode and multi-block inputs', async () => {
    for (const prompt of ['hello', '中文😀'.repeat(40), 'a'.repeat(16000)]) {
      const value = { ...input, prompt } as any;
      const expected = createHash('sha256').update(canonicalWebLaunchInput(value)).digest('hex');
      expect(await inputDigest(value, {})).toBe(expected);
      expect(await inputDigest(value, webcrypto)).toBe(expected);
    }
  });

  it('refreshes an unavailable application only from the trusted heartbeat without granting or launching', async () => {
    const original = client.request.getMockImplementation()!;
    client.request.mockImplementation(async (method, params) => {
      if (method === WebLaunchMethod.SitesRead) throw { code: 'APP_NOT_RUNNING' };
      return original(method, params);
    });
    const initial = (await request()).connectionPending;
    expect(initial).toMatchObject({
      status: 'awaiting-consent',
      requiresAction: false,
      code: 'APP_NOT_RUNNING',
    });
    const calls = client.request.mock.calls.length;
    await external({ op: 'query', pendingId: initial.pendingId });
    expect(client.request).toHaveBeenCalledTimes(calls);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 6000);
    client.request.mockImplementation(original);
    await invoke({
      type: 'web-launch:panel:state',
      ...panelScope,
      composerBusy: false,
    });
    await vi.waitFor(async () =>
      expect((await registerPanel()).connectionPending?.requiresAction).toBe(true),
    );
    expect(
      client.request.mock.calls.some(
        ([method]) =>
          method === WebLaunchMethod.SitesWrite ||
          method === WebLaunchMethod.Prepare ||
          method === WebLaunchMethod.Submit,
      ),
    ).toBe(false);
    expect((await registerPanel()).connectionPending.pendingId).toBe(initial.pendingId);
  });

  it('accepts the displayed consent revision when initial lookup resolves after the heartbeat', async () => {
    const original = client.request.getMockImplementation()!;
    const reads: Array<(value: { revision: number; sites: unknown[] }) => void> = [];
    client.request.mockImplementation(async (method, params) =>
      method === WebLaunchMethod.SitesRead
        ? new Promise(resolve => reads.push(resolve))
        : original(method, params),
    );

    const initial = request();
    await vi.waitFor(() => expect(reads).toHaveLength(1));
    await invoke({ type: 'web-launch:panel:state', ...panelScope, composerBusy: false });
    await vi.waitFor(() => expect(reads).toHaveLength(2));

    const policy = { revision: siteRevision, sites: [] };
    reads[1](policy);
    await vi.waitFor(async () =>
      expect((await registerPanel()).connectionPending?.requiresAction).toBe(true),
    );
    const displayed = (await registerPanel()).connectionPending;
    reads[0](policy);
    expect(await initial).toMatchObject({ ok: true, connectionPending: displayed });

    client.request.mockImplementation(original);
    permitted = true;
    expect(await decision(displayed)).toMatchObject({
      ok: true,
      connectionPending: { status: 'connected' },
    });
  });

  it('does not broadcast an old consent when its deferred policy lookup finishes after navigation', async () => {
    const original = client.request.getMockImplementation()!;
    client.request.mockRejectedValueOnce({ code: 'APP_NOT_RUNNING' });
    const old = (await request()).connectionPending;
    expect(old.requiresAction).toBe(false);
    let finishLookup!: (value: { revision: number; sites: unknown[] }) => void;
    client.request.mockImplementation(async (method, params) =>
      method === WebLaunchMethod.SitesRead && !finishLookup
        ? new Promise(resolve => {
            finishLookup = resolve;
          })
        : original(method, params),
    );
    await invoke({ type: 'web-launch:panel:state', ...panelScope, composerBusy: false });
    await vi.waitFor(() => expect(finishLookup).toBeTypeOf('function'));

    currentDocument = 'document-2';
    updated(source.tab.id, { status: 'loading' });
    const fresh = (
      await external(
        {
          op: 'request',
          bindingId: 'binding-2',
          bindingRevision: 1,
          input,
          payloadDigest: await inputDigest(input, webcrypto),
        },
        { ...source, documentId: currentDocument },
      )
    ).connectionPending;
    expect(fresh).toMatchObject({ requiresAction: true });
    expect(fresh.pendingId).not.toBe(old.pendingId);

    api.runtime.sendMessage.mockClear();
    const writes = api.storage.session.set.mock.calls.length;
    finishLookup({ revision: siteRevision, sites: [] });
    await vi.waitFor(() =>
      expect(api.storage.session.set.mock.calls.length).toBeGreaterThan(writes),
    );
    expect(
      await external(
        { op: 'cancel', pendingId: old.pendingId },
        { ...source, documentLifecycle: 'cached' },
      ),
    ).toMatchObject({
      ok: true,
      connectionPending: { pendingId: old.pendingId, status: 'expired' },
    });
    expect(api.runtime.sendMessage).not.toHaveBeenCalled();
    expect((await registerPanel()).connectionPending).toEqual(fresh);
  });

  it('reconnects a revoked original button only on a fresh click, preserving sequence and producing one new manual draft', async () => {
    const handles: any[] = [];
    const states: string[] = [];
    await sdk.bind(document.getElementById('launch'), input, {
      onRequest: value => handles.push(value),
      onConnection: value => states.push(value.status),
    });
    trustedClick();
    await vi.waitFor(async () =>
      expect((await registerPanel()).connectionPending?.requiresAction).toBe(true),
    );
    permitted = true;
    await decision((await registerPanel()).connectionPending);
    await vi.waitFor(() => expect(handles[0]?.launchId).toBe('launch-1'));
    const first = client.request.mock.calls.find(
      ([method]) => method === WebLaunchMethod.Prepare,
    )![1];
    const closed = structuredClone(
      storage.chromeWebLaunchSession.requests[first.requestId].response,
    );
    closed.receipt.request.status = 'cancelled';
    const original = client.request.getMockImplementation()!;
    client.request.mockImplementation(async (method, params) =>
      method === WebLaunchMethod.Observations
        ? { observations: [closed] }
        : original(method, params),
    );
    policies = [];
    siteRevision = 2;
    await invoke({ type: 'web-launch:sites:list' });
    await invoke({ type: 'web-launch:panel:state', ...panelScope });
    await vi.waitFor(() => expect(states).toContain('expired'));
    await vi.waitFor(() =>
      expect(
        storage.chromeWebLaunchSession.requests[first.requestId].response.receipt.request.status,
      ).toBe('cancelled'),
    );
    await expect(handles[0].read()).rejects.toMatchObject({ code: 'EXPIRED' });
    expect(
      client.request.mock.calls.filter(([method]) => method === WebLaunchMethod.Prepare),
    ).toHaveLength(1);
    trustedClick();
    await vi.waitFor(async () =>
      expect((await registerPanel()).connectionPending?.requiresAction).toBe(true),
    );
    await decision((await registerPanel()).connectionPending);
    await vi.waitFor(() => expect(handles[1]?.launchId).toBe('launch-1'));
    const prepares = client.request.mock.calls.filter(
      ([method]) => method === WebLaunchMethod.Prepare,
    );
    expect(prepares).toHaveLength(2);
    expect(prepares[1][1]).toMatchObject({
      connectionOnly: true,
      expectedPolicyRevision: 3,
      clickSequence: 2,
    });
    expect(prepares[1][1].requestId).not.toBe(first.requestId);
    expect(prepares[1][1].documentLeaseId).toBeUndefined();
    expect(client.request.mock.calls.some(([method]) => method === WebLaunchMethod.Submit)).toBe(
      false,
    );
  });

  it('disarms a bound-only revoked page on rejection without replaying that consumed click', async () => {
    permitted = true;
    policies = [
      { origin: source.origin, enabled: true, allowSend: true, allowResult: true, revision: 1 },
    ];
    storage.chromeWebLaunchGrantedOrigins = [source.origin];
    await api.scripting.executeScript({
      target: { tabId: 7, documentIds: [source.documentId] },
      files: ['web-launch-content.js'],
    });
    const states: string[] = [];
    await sdk.bind(document.getElementById('launch'), input, {
      onConnection: value => states.push(value.status),
    });
    policies = [];
    siteRevision = 2;
    trustedClick();
    await vi.waitFor(() => expect(states).toContain('expired'));
    expect(client.request.mock.calls.some(([method]) => method === WebLaunchMethod.Prepare)).toBe(
      false,
    );
    expect((await registerPanel()).connectionPending).toBeNull();
    trustedClick();
    await vi.waitFor(async () =>
      expect((await registerPanel()).connectionPending?.requiresAction).toBe(true),
    );
    await decision((await registerPanel()).connectionPending);
    await vi.waitFor(() =>
      expect(
        client.request.mock.calls.filter(([method]) => method === WebLaunchMethod.Prepare),
      ).toHaveLength(1),
    );
    expect(
      client.request.mock.calls.find(([method]) => method === WebLaunchMethod.Prepare)![1],
    ).toMatchObject({ clickSequence: 2, connectionOnly: true });
  });

  it('keeps connected progress when a query issued before completion returns late', async () => {
    let releaseQuery!: (value: any) => void;
    const events: string[] = [];
    externalSend = message => {
      if (message.op === 'query' && !releaseQuery) {
        return new Promise(resolve => {
          releaseQuery = resolve;
        });
      }
      return external(message);
    };
    await sdk.bind(document.getElementById('launch'), input, {
      onConnection: value => events.push(value.status),
    });
    trustedClick();
    await vi.waitFor(() => expect(releaseQuery).toBeTypeOf('function'), { timeout: 1600 });
    const pending = (await registerPanel()).connectionPending;
    permitted = true;
    expect((await decision(pending)).ok).toBe(true);
    await vi.waitFor(() => expect(events.at(-1)).toBe('connected'));
    releaseQuery({ ok: true, connectionPending: { ...pending, status: 'awaiting-consent' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(events.at(-1)).toBe('connected');
    expect(
      client.request.mock.calls.filter(([method]) => method === WebLaunchMethod.Prepare),
    ).toHaveLength(1);
  });

  it.each(['hello', 'bind-reply'])(
    'does not revive a retired registration through a delayed %s acknowledgement',
    async stage => {
      let release!: () => void;
      let oldNonce: string;
      let releaseQuery: ((value: any) => void) | undefined;
      const events: string[] = [];
      await sdk.bind(document.getElementById('launch'), input, {
        onConnection: value => events.push(value.status),
      });
      if (stage === 'bind-reply') {
        let captured = false;
        externalSend = message => {
          if (message.op === 'query' && !captured) {
            captured = true;
            return new Promise(resolve => {
              releaseQuery = resolve;
            });
          }
          return external(message);
        };
      }
      const send = contentSend;
      let held = false;
      contentSend = async message => {
        if (message.type.endsWith('hello')) {
          oldNonce = message.documentNonce;
          if (stage === 'hello' && !held) {
            held = true;
            await new Promise<void>(resolve => {
              release = resolve;
            });
            return { ok: true };
          }
        }
        return send(message);
      };
      if (stage === 'bind-reply') {
        const post = vi.mocked(window.postMessage).getMockImplementation()!;
        vi.mocked(window.postMessage).mockImplementation((data: any, origin: any) => {
          if (data.kind === 'reply' && data.bindingRevision === 1 && !held) {
            held = true;
            release = () => post(data, origin);
            return;
          }
          post(data, origin);
        });
      }
      trustedClick();
      await vi.waitFor(async () =>
        expect((await registerPanel()).connectionPending?.requiresAction).toBe(true),
      );
      const first = (await registerPanel()).connectionPending;
      if (stage === 'bind-reply')
        await vi.waitFor(() => expect(releaseQuery).toBeTypeOf('function'), { timeout: 1600 });
      permitted = true;
      await decision(first);
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      await api.tabs.sendMessage(
        7,
        { type: 'web-launch:document:retire', documentNonce: oldNonce!, reconnectRequired: true },
        { documentId: source.documentId },
      );
      updated(7, { url: source.url });
      release();
      await vi.waitFor(() => expect(events).toContain('expired'));
      expect(client.request.mock.calls.some(([method]) => method === WebLaunchMethod.Prepare)).toBe(
        false,
      );
      trustedClick();
      await vi.waitFor(async () => {
        const pending = (await registerPanel()).connectionPending;
        expect(pending?.requiresAction).toBe(true);
        expect(pending?.pendingId).not.toBe(first.pendingId);
      });
      const fresh = (await registerPanel()).connectionPending;
      releaseQuery?.({ ok: true, connectionPending: { ...first, status: 'rejected' } });
      await Promise.resolve();
      await Promise.resolve();
      expect(events.at(-1)).not.toBe('rejected');
      expect((await decision(fresh)).ok).toBe(true);
      await vi.waitFor(() =>
        expect(
          client.request.mock.calls.filter(([method]) => method === WebLaunchMethod.Prepare),
        ).toHaveLength(1),
      );
    },
  );
});
