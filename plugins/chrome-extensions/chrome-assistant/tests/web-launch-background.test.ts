import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebLaunchBackground } from '../conversation-overlay/modules/web-launch-background.js';
import { WebLaunchMethod } from '../contracts/webLaunch';

const extensionId = 'fixture-extension';
const sender = {
  id: extensionId,
  frameId: 0,
  documentId: 'document-1',
  documentLifecycle: 'active',
  origin: 'https://business.test:8443',
  url: 'https://business.test:8443/record',
  tab: { id: 7, windowId: 3, title: 'Business' },
};
const trusted = {
  id: extensionId,
  frameId: 0,
  url: `chrome-extension://${extensionId}/options.html`,
};
const launch = {
  type: 'web-launch:document:launch',
  documentNonce: 'document-nonce',
  requestId: 'request-1',
  bindingRevision: 1,
  clickSequence: 1,
  payloadDigest: 'a'.repeat(64),
  input: { prompt: 'hello', mode: 'draft', result: 'final' },
};

describe('web launch background', () => {
  let api: any;
  let storage: Record<string, any>;
  let client: { request: ReturnType<typeof vi.fn> };
  let order: string[];
  let permissionRemoved: () => void;
  let reply: any;
  beforeEach(() => {
    order = [];
    storage = {};
    reply = {
      receipt: {
        requestId: 'request-1',
        launchId: 'launch-1',
        receiptRevision: 1,
        request: { status: 'drafted' },
        execution: { status: 'not-started', executionSettled: false },
        output: { status: 'awaiting-consent' },
        delivery: { status: 'connected' },
        localAppServerUrl: 'ws://private-token',
      },
      internal: {
        threadId: 'private-thread',
        documentLeaseId: 'private-lease',
        composeRevision: 1,
        deadlineAt: Date.now() + 60_000,
        requiresSendConfirmation: true,
        requiresResultConsent: true,
        nativeRunId: 'private-run',
      },
    };
    const session = {
      get: vi.fn(async (key: string) => {
        order.push('storage');
        return { [key]: structuredClone(storage[key]) };
      }),
      set: vi.fn(async (value: unknown) => Object.assign(storage, structuredClone(value))),
    };
    api = {
      runtime: {
        id: extensionId,
        getManifest: () => ({ version: '1.0' }),
        sendMessage: vi.fn(async () => ({})),
      },
      storage: { session, local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
      sidePanel: {
        open: vi.fn(() => {
          order.push('open');
          return Promise.resolve();
        }),
      },
      tabs: {
        get: vi.fn(async () => ({ url: sender.url, windowId: 3 })),
        sendMessage: vi.fn(async (_tab: number, message: any) => ({
          active: true,
          documentNonce: message.documentNonce,
        })),
        onRemoved: { addListener: vi.fn() },
        onUpdated: { addListener: vi.fn() },
      },
      windows: { onRemoved: { addListener: vi.fn() } },
      permissions: {
        contains: vi.fn(async () => true),
        onRemoved: {
          addListener: (listener: () => void) => {
            permissionRemoved = listener;
          },
        },
      },
      scripting: {
        getRegisteredContentScripts: vi.fn(async () => []),
        unregisterContentScripts: vi.fn(async () => {}),
        registerContentScripts: vi.fn(async () => {}),
      },
    };
    client = {
      request: vi.fn(async method => {
        if (method === WebLaunchMethod.SitesRead)
          return {
            revision: 1,
            sites: [
              {
                origin: sender.origin,
                enabled: true,
                allowSend: false,
                allowResult: false,
                revision: 1,
              },
            ],
          };
        if (method === WebLaunchMethod.RevokeDocument) return {};
        return structuredClone(reply);
      }),
    };
  });
  const invoke = (controller: any, message: any, from = sender) =>
    new Promise<any>(resolve => controller.handleMessage(message, from, resolve));

  it('opens on the synchronous message path, verifies the precise document and strips private metadata', async () => {
    const controller = createWebLaunchBackground({ chromeApi: api, client });
    const pending = invoke(controller, launch);
    expect(order[0]).toBe('open');
    const response = await pending;
    expect(response.ok).toBe(true);
    expect(response.receipt.launchId).toBe('launch-1');
    expect(JSON.stringify(response.receipt)).not.toMatch(
      /private|nativeRunId|threadId|localAppServerUrl/,
    );
    const prepare = client.request.mock.calls.find(
      ([method]) => method === WebLaunchMethod.Prepare,
    )![1];
    expect(prepare.source.origin).toBe(sender.origin);
    expect(prepare.source.documentId).toBe(sender.documentId);
    expect(api.tabs.sendMessage.mock.calls[0][2]).toEqual({ documentId: sender.documentId });
    expect(await invoke(controller, { type: 'web-launch:sites:list' })).toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
  });

  it('rejects iframes before opening and denies a second window request without queueing it', async () => {
    const controller = createWebLaunchBackground({ chromeApi: api, client });
    expect(await invoke(controller, launch, { ...sender, frameId: 1 })).toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
    expect(api.sidePanel.open).not.toHaveBeenCalled();
    await invoke(controller, launch);
    expect(
      await invoke(controller, { ...launch, requestId: 'request-2', clickSequence: 2 }),
    ).toEqual({ ok: false, code: 'WINDOW_BUSY' });
    expect(
      client.request.mock.calls.filter(([method]) => method === WebLaunchMethod.Prepare),
    ).toHaveLength(1);
  });

  it('restores only observation after a worker restart, advancing its persisted document channel', async () => {
    const first = createWebLaunchBackground({ chromeApi: api, client });
    await invoke(first, launch);
    const initialSource = client.request.mock.calls.find(
      ([method]) => method === WebLaunchMethod.Prepare,
    )![1].source;
    const second = createWebLaunchBackground({ chromeApi: api, client });
    const response = await invoke(second, {
      type: 'web-launch:document:read',
      documentNonce: launch.documentNonce,
      documentLeaseId: 'private-lease',
      requestId: launch.requestId,
      launchId: 'launch-1',
    });
    expect(response.ok).toBe(true);
    const reference = client.request.mock.calls.findLast(
      ([method]) => method === WebLaunchMethod.Read,
    )![1];
    expect(reference.source.chromeInstanceId).toBe(initialSource.chromeInstanceId);
    expect(reference.source.channelGeneration).toBe(initialSource.channelGeneration + 1);
    expect(
      client.request.mock.calls.filter(([method]) => method === WebLaunchMethod.Prepare),
    ).toHaveLength(1);
  });

  it('drops an in-flight final result when permission is revoked before webpage delivery', async () => {
    const controller = createWebLaunchBackground({ chromeApi: api, client });
    await invoke(controller, launch);
    let release: (value: unknown) => void;
    client.request.mockImplementation(async method => {
      if (method === WebLaunchMethod.SitesRead)
        return { revision: 1, sites: [{ origin: sender.origin, enabled: true, revision: 1 }] };
      if (method === WebLaunchMethod.Read)
        return new Promise(resolve => {
          release = resolve;
        });
      return {};
    });
    const pending = invoke(controller, {
      type: 'web-launch:document:read',
      documentNonce: launch.documentNonce,
      requestId: launch.requestId,
      launchId: 'launch-1',
      documentLeaseId: 'private-lease',
    });
    await vi.waitFor(() => expect(release!).toBeTypeOf('function'));
    permissionRemoved();
    release!({
      ...reply,
      receipt: {
        ...reply.receipt,
        execution: { status: 'completed', executionSettled: true },
        output: { status: 'available', text: 'private result' },
      },
    });
    expect(await pending).toEqual({ ok: false, code: 'LEASE_REVOKED' });
  });

  it('lets trusted settings abandon a durable observation without requiring a local browser record', async () => {
    const controller = createWebLaunchBackground({ chromeApi: api, client });
    expect(
      (
        await invoke(
          controller,
          { type: 'web-launch:launch:abandon', launchId: 'launch-old', confirm: true },
          trusted,
        )
      ).ok,
    ).toBe(true);
    expect(client.request).toHaveBeenCalledWith(WebLaunchMethod.Abandon, {
      launchId: 'launch-old',
      confirm: true,
    });
  });

  it('waits for a pending prepare then recovers a lost ACK by read, never another prepare', async () => {
    const original = client.request.getMockImplementation()!;
    let rejectPrepare: (error: unknown) => void;
    client.request.mockImplementation(async method =>
      method === WebLaunchMethod.Prepare
        ? new Promise((_resolve, reject) => {
            rejectPrepare = reject;
          })
        : original(method),
    );
    const controller = createWebLaunchBackground({ chromeApi: api, client });
    const pending = invoke(controller, launch);
    await vi.waitFor(() => expect(rejectPrepare!).toBeTypeOf('function'));
    const query = {
      type: 'web-launch:document:read',
      documentNonce: launch.documentNonce,
      requestId: launch.requestId,
      result: 'final',
    };
    expect(await invoke(controller, query)).toEqual({ ok: true, pending: true });
    rejectPrepare!({ code: 'REQUEST_TIMEOUT', requestSent: true });
    expect(await pending).toEqual({ ok: false, code: 'REQUEST_TIMEOUT' });
    expect((await invoke(controller, query)).receipt.launchId).toBe('launch-1');
    expect(
      client.request.mock.calls.filter(([method]) => method === WebLaunchMethod.Prepare),
    ).toHaveLength(1);
    expect(
      client.request.mock.calls.find(([method]) => method === WebLaunchMethod.Read)![1],
    ).toMatchObject({ requestId: launch.requestId });
  });

  it('allows only an existing exact document to revoke during cached pagehide', async () => {
    const controller = createWebLaunchBackground({ chromeApi: api, client });
    await invoke(controller, launch);
    const inactive = { ...sender, documentLifecycle: 'cached' };
    expect(
      await invoke(
        controller,
        { type: 'web-launch:document:revoke', documentNonce: 'unknown', reason: 'pagehide' },
        inactive,
      ),
    ).toEqual({ ok: false, code: 'EXPIRED' });
    expect(
      await invoke(
        controller,
        {
          type: 'web-launch:document:revoke',
          documentNonce: launch.documentNonce,
          reason: 'pagehide',
        },
        inactive,
      ),
    ).toEqual({ ok: true });
    expect(
      client.request.mock.calls.filter(([method]) => method === WebLaunchMethod.RevokeDocument),
    ).toHaveLength(1);
    expect(
      (await invoke(controller, { ...launch, requestId: 'request-2', clickSequence: 2 }, inactive))
        .code,
    ).toBe('FORBIDDEN');
  });

  it('refreshes trusted metadata without a live webpage and restores a running card without input', async () => {
    const controller = createWebLaunchBackground({ chromeApi: api, client });
    await invoke(controller, launch);
    const running = {
      ...reply,
      receipt: {
        ...reply.receipt,
        receiptRevision: 2,
        request: { status: 'submitted' },
        execution: { status: 'running', executionSettled: false },
      },
    };
    client.request.mockImplementation(async method =>
      method === WebLaunchMethod.Observations ? { observations: [running] } : running,
    );
    await invoke(
      controller,
      {
        type: 'web-launch:panel:register',
        panelInstanceId: 'panel-1',
        windowId: 3,
        composerBusy: false,
      },
      trusted,
    );
    await invoke(
      controller,
      {
        type: 'web-launch:panel:state',
        panelInstanceId: 'panel-1',
        windowId: 3,
        composerBusy: false,
        launchId: 'launch-1',
      },
      trusted,
    );
    await vi.waitFor(() =>
      expect(api.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          receipt: expect.objectContaining({
            execution: { status: 'running', executionSettled: false },
          }),
        }),
      ),
    );
    const reopened = await invoke(
      controller,
      {
        type: 'web-launch:panel:register',
        panelInstanceId: 'panel-2',
        windowId: 3,
        composerBusy: false,
      },
      trusted,
    );
    expect(reopened.envelope).toMatchObject({
      prompt: '',
      mode: 'draft',
      result: 'final',
      threadId: 'private-thread',
      restored: true,
    });
    expect(reopened.envelope.contextText).toBeUndefined();
  });

  it('never leaves a result body in session metadata when persistence fails', async () => {
    const controller = createWebLaunchBackground({ chromeApi: api, client });
    await invoke(controller, launch);
    const original = client.request.getMockImplementation()!;
    let once = true;
    client.request.mockImplementation(async method => {
      if (method !== WebLaunchMethod.Read) return original(method);
      if (once) {
        once = false;
        api.storage.session.set.mockRejectedValueOnce(new Error('disk error'));
      }
      return {
        ...reply,
        receipt: {
          ...reply.receipt,
          execution: { status: 'completed', executionSettled: true },
          output: { status: 'available', text: 'result-must-never-persist' },
        },
      };
    });
    const query = {
      type: 'web-launch:document:read',
      documentNonce: launch.documentNonce,
      requestId: launch.requestId,
      launchId: 'launch-1',
      result: 'final',
    };
    expect((await invoke(controller, query)).ok).toBe(false);
    expect((await invoke(controller, query)).ok).toBe(true);
    expect(JSON.stringify(storage)).not.toContain('result-must-never-persist');
  });

  it('bounds retired metadata without replaying old operations', async () => {
    const controller = createWebLaunchBackground({ chromeApi: api, client });
    const receipts = new Map();
    client.request.mockImplementation(async (method, params) => {
      if (method === WebLaunchMethod.SitesRead)
        return { revision: 1, sites: [{ origin: sender.origin, enabled: true, revision: 1 }] };
      if (method === WebLaunchMethod.Prepare) {
        const value = {
          ...reply,
          receipt: {
            ...reply.receipt,
            requestId: params.requestId,
            launchId: `launch-${params.requestId}`,
          },
        };
        receipts.set(value.receipt.launchId, value);
        return value;
      }
      const value = receipts.get(params.launchId);
      return {
        ...value,
        receipt: {
          ...value.receipt,
          request: { status: 'submitted' },
          execution: { status: 'completed', executionSettled: true },
          output: { status: 'empty' },
        },
      };
    });
    for (let index = 0; index < 120; index += 1) {
      const requestId = `request-${index}`;
      const response = await invoke(controller, { ...launch, requestId, clickSequence: index + 1 });
      await invoke(controller, {
        type: 'web-launch:document:read',
        documentNonce: launch.documentNonce,
        requestId,
        launchId: response.receipt.launchId,
        result: 'final',
      });
    }
    expect(Object.keys(storage.chromeWebLaunchSession.requests).length).toBeLessThanOrEqual(100);
    expect(
      client.request.mock.calls.filter(([method]) => method === WebLaunchMethod.Prepare),
    ).toHaveLength(120);
  });

  it('retires a soft-navigation lease and permits only a new click with a new private nonce', async () => {
    const controller = createWebLaunchBackground({ chromeApi: api, client });
    await invoke(controller, launch);
    const original = client.request.getMockImplementation()!;
    client.request.mockImplementation(async method =>
      method === WebLaunchMethod.Observations
        ? {
            observations: [
              { ...reply, receipt: { ...reply.receipt, request: { status: 'cancelled' } } },
            ],
          }
        : original(method),
    );
    const changed = api.tabs.onUpdated.addListener.mock.calls[0][0];
    changed(7, { url: 'https://business.test:8443/another-record' });
    await vi.waitFor(() =>
      expect(
        client.request.mock.calls.some(([method]) => method === WebLaunchMethod.Observations),
      ).toBe(true),
    );
    expect(
      api.tabs.sendMessage.mock.calls.some(
        ([, message]) => message.type === 'web-launch:document:retire',
      ),
    ).toBe(true);
    reply.receipt.requestId = 'request-2';
    reply.receipt.launchId = 'launch-2';
    const response = await invoke(controller, {
      ...launch,
      documentNonce: 'fresh-nonce',
      requestId: 'request-2',
      clickSequence: 2,
    });
    expect(response.ok).toBe(true);
    const prepared = client.request.mock.calls.filter(
      ([method]) => method === WebLaunchMethod.Prepare,
    );
    expect(prepared).toHaveLength(2);
    expect(prepared[1][1].documentLeaseId).toBeUndefined();
  });

  it('refuses trusted submission of a restored draft whose exact source document is gone', async () => {
    const first = createWebLaunchBackground({ chromeApi: api, client });
    await invoke(first, launch);
    const second = createWebLaunchBackground({ chromeApi: api, client });
    api.tabs.sendMessage.mockRejectedValue(new Error('No document'));
    const response = await invoke(
      second,
      {
        type: 'web-launch:launch:submit',
        launchId: 'launch-1',
        composeRevision: 1,
        input: { prompt: 'hello', permissionMode: 'ask' },
        submission: 'confirmed',
        shareResult: false,
      },
      trusted,
    );
    expect(response).toEqual({ ok: false, code: 'EXPIRED' });
    expect(client.request.mock.calls.some(([method]) => method === WebLaunchMethod.Submit)).toBe(
      false,
    );
  });

  it('never presents an automatic-send envelope after cancellation races a prepare ACK', async () => {
    let release: (value: unknown) => void;
    const original = client.request.getMockImplementation()!;
    client.request.mockImplementation(async method => {
      if (method === WebLaunchMethod.Prepare)
        return new Promise(resolve => {
          release = resolve;
        });
      if (method === WebLaunchMethod.Cancel)
        return { ...reply, receipt: { ...reply.receipt, request: { status: 'cancelled' } } };
      return original(method);
    });
    const controller = createWebLaunchBackground({ chromeApi: api, client });
    await invoke(
      controller,
      {
        type: 'web-launch:panel:register',
        panelInstanceId: 'panel-1',
        windowId: 3,
        composerBusy: false,
      },
      trusted,
    );
    const pending = invoke(controller, launch);
    await vi.waitFor(() => expect(release!).toBeTypeOf('function'));
    await invoke(controller, {
      type: 'web-launch:document:cancel',
      documentNonce: launch.documentNonce,
      requestId: launch.requestId,
    });
    release!(reply);
    expect((await pending).receipt.request.status).toBe('cancelled');
    expect(
      api.runtime.sendMessage.mock.calls.some(
        ([event]) => event.type === 'web-launch:panel:event' && event.envelope,
      ),
    ).toBe(false);
  });

  it('retires the exact webpage channel on trusted abandon before accepting a new clicked operation', async () => {
    const controller = createWebLaunchBackground({ chromeApi: api, client });
    await invoke(controller, launch);
    await invoke(
      controller,
      { type: 'web-launch:launch:abandon', launchId: 'launch-1', confirm: true },
      trusted,
    );
    expect(
      api.tabs.sendMessage.mock.calls.some(
        ([tabId, message, options]) =>
          tabId === 7 &&
          message.type === 'web-launch:document:retire' &&
          message.documentNonce === launch.documentNonce &&
          options.documentId === sender.documentId,
      ),
    ).toBe(true);
    reply.receipt.requestId = 'request-2';
    reply.receipt.launchId = 'launch-2';
    const result = await invoke(controller, {
      ...launch,
      requestId: 'request-2',
      documentNonce: 'new-nonce',
      clickSequence: 2,
    });
    expect(result.ok).toBe(true);
    expect(
      client.request.mock.calls.filter(([method]) => method === WebLaunchMethod.Prepare)[1][1]
        .documentLeaseId,
    ).toBeUndefined();
  });
});
