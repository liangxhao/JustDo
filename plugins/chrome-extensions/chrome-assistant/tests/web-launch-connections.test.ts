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
  url: `chrome-extension://${extensionId}/sidepanel.html`,
};
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
      panelInstanceId: 'panel-1',
      windowId: 3,
      composerBusy: false,
    });
  const decision = (value: any, decision = 'allow', extra = {}) =>
    invoke({
      type: 'web-launch:connection:decide',
      panelInstanceId: 'panel-1',
      windowId: 3,
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
        getManifest: () => ({ version: '1' }),
        sendMessage: vi.fn(async () => ({})),
        onMessage: {
          addListener: (listener: any) => contentListeners.push(listener),
          removeListener: vi.fn(),
        },
      },
      storage: { session: area, local: area },
      sidePanel: { open: vi.fn(() => Promise.resolve()) },
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
    click = undefined as any;
    sdk = createChromeAssistant({
      window,
      document,
      cryptoApi: webcrypto,
      extensionId,
      runtimeApi: { sendMessage: (_id: string, message: any) => externalSend(message) },
    });
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

  it('keeps an already-authorized older document clickable without assuming its content bridge was injected', async () => {
    permitted = true;
    policies = [
      { origin: source.origin, enabled: true, allowSend: true, allowResult: true, revision: 1 },
    ];
    storage.chromeWebLaunchSites = [source.origin];
    const events: string[] = [];
    await sdk.bind(document.getElementById('launch'), input, {
      onRequest: () => events.push('request'),
    });
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
    trustedClick();
    await vi.waitFor(async () =>
      expect((await registerPanel()).connectionPending?.requiresAction).toBe(true),
    );
    expect((await decision((await registerPanel()).connectionPending)).ok).toBe(true);
    await vi.waitFor(() => expect(events).toContain('request'));
    expect(
      client.request.mock.calls.some(([method]) => method === WebLaunchMethod.SitesWrite),
    ).toBe(false);
    expect(policies[0]).toMatchObject({ allowSend: true, allowResult: true });
    expect(
      client.request.mock.calls.find(([method]) => method === WebLaunchMethod.Prepare)?.[1],
    ).toMatchObject({ connectionOnly: true, expectedPolicyRevision: 1 });
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

  it('accepts decisions only from the currently registered side panel in the pending window', async () => {
    const pending = (await request()).connectionPending;
    const message = {
      type: 'web-launch:connection:decide',
      pendingId: pending.pendingId,
      expectedRevision: pending.revision,
      decision: 'allow',
      windowId: 3,
      panelInstanceId: 'panel-1',
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
    await invoke({
      type: 'web-launch:panel:register',
      panelInstanceId: 'another-panel',
      windowId: 4,
    });
    expect(await invoke({ ...message, panelInstanceId: 'another-panel', windowId: 4 })).toEqual({
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
    await vi.waitFor(async () =>
      expect((await registerPanel()).connectionPending?.pendingId).not.toBe(first.pendingId),
    );
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
      panelInstanceId: 'panel-1',
      windowId: 3,
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
    await invoke({ type: 'web-launch:panel:state', panelInstanceId: 'panel-1', windowId: 3 });
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
      { origin: source.origin, enabled: true, allowSend: false, allowResult: false, revision: 1 },
    ];
    storage.chromeWebLaunchSites = [source.origin];
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
      await vi.waitFor(async () =>
        expect((await registerPanel()).connectionPending?.pendingId).not.toBe(first.pendingId),
      );
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
