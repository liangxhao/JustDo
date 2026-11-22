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
const panelSender = (tabId: number) => ({
  ...trusted,
  url: `chrome-extension://${extensionId}/sidepanel.html?tabId=${tabId}`,
});
const panelScope = { tabId: 7, windowId: 3, panelInstanceId: 'panel-1' };
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
        getURL: (path: string) => `chrome-extension://${extensionId}/${path}`,
        getManifest: () => ({ version: '1.0' }),
        sendMessage: vi.fn(async () => ({})),
      },
      storage: { session, local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
      sidePanel: {
        setOptions: vi.fn(async () => {}),
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
                allowSend: true,
                allowResult: true,
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

  it('routes launch state and controls to the originating tab while retaining window admission', async () => {
    const controller = createWebLaunchBackground({ chromeApi: api, client });
    const register = { type: 'web-launch:panel:register', ...panelScope };
    const otherPanel = { tabId: 8, windowId: 3, panelInstanceId: 'another-panel' };
    await invoke(controller, register, panelSender(7));
    const otherRegistration = { ...register, ...otherPanel, composerBusy: true };
    expect(await invoke(controller, otherRegistration, panelSender(7))).toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
    expect(await invoke(controller, otherRegistration, panelSender(8))).toMatchObject({ ok: true });

    expect(await invoke(controller, launch)).toMatchObject({ ok: true });
    expect(api.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ...panelScope,
        envelope: expect.objectContaining({ prompt: 'hello', launchId: 'launch-1' }),
      }),
    );
    expect(await invoke(controller, otherRegistration, panelSender(8))).toMatchObject({
      ok: true,
      envelope: undefined,
      observations: [],
    });
    const stop = { type: 'web-launch:launch:stop', launchId: 'launch-1' };
    expect(await invoke(controller, { ...stop, ...otherPanel }, panelSender(8))).toEqual({
      ok: false,
      code: 'UNKNOWN_REQUEST',
    });
    expect(client.request).not.toHaveBeenCalledWith(WebLaunchMethod.Stop, expect.anything());
    expect(await invoke(controller, { ...stop, ...panelScope }, panelSender(7))).toMatchObject({
      ok: true,
    });
    expect(client.request).toHaveBeenCalledWith(WebLaunchMethod.Stop, { launchId: 'launch-1' });
    expect(
      await invoke(
        controller,
        { ...launch, requestId: 'request-2' },
        {
          ...sender,
          documentId: 'document-2',
          tab: { ...sender.tab, id: 8 },
        },
      ),
    ).toMatchObject({ ok: true, queueStatus: 'queued' });

    api.tabs.onRemoved.addListener.mock.calls[0][0](7);
    expect(await invoke(controller, { ...stop, ...panelScope }, panelSender(7))).toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
  });

  it('only accepts trusted sending preferences and presents the effective mode from Main', async () => {
    const controller = createWebLaunchBackground({ chromeApi: api, client });
    const preference = {
      type: 'web-launch:sites:send-mode',
      sendMode: 'send',
      expectedRevision: 1,
    };
    expect(await invoke(controller, preference)).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(client.request).not.toHaveBeenCalled();

    const request = client.request.getMockImplementation()!;
    client.request.mockImplementation(async (method, params) => {
      if (method === WebLaunchMethod.SendModeSet)
        return { sites: [], revision: 2, sendMode: 'send' };
      if (method === WebLaunchMethod.SitesRead) {
        const value = await request(method, params);
        return { ...value, revision: 2, sendMode: 'send' };
      }
      return request(method, params);
    });
    expect(await invoke(controller, preference, trusted)).toMatchObject({
      ok: true,
      sitesRevision: 2,
      sendMode: 'send',
    });
    expect(client.request).toHaveBeenCalledWith(WebLaunchMethod.SendModeSet, {
      expectedRevision: 1,
      sendMode: 'send',
    });
    reply.internal.effectiveMode = 'send';
    reply.internal.requiresSendConfirmation = false;
    reply.internal.requiresResultConsent = false;
    expect(await invoke(controller, launch)).toMatchObject({ ok: true });

    const result = await invoke(
      controller,
      { type: 'web-launch:panel:register', ...panelScope },
      panelSender(7),
    );
    expect(result.envelope).toMatchObject({ mode: 'send', automaticSendAllowed: true });
    expect(client.request).toHaveBeenCalledWith(
      WebLaunchMethod.Prepare,
      expect.objectContaining({ input: launch.input }),
    );
  });

  it('rejects iframes before opening and queues an independent request while the window is occupied', async () => {
    const controller = createWebLaunchBackground({ chromeApi: api, client });
    expect(await invoke(controller, launch, { ...sender, frameId: 1 })).toEqual({
      ok: false,
      code: 'FORBIDDEN',
    });
    expect(api.sidePanel.open).not.toHaveBeenCalled();
    await invoke(controller, launch);
    expect(
      await invoke(controller, { ...launch, requestId: 'request-2', clickSequence: 2 }),
    ).toMatchObject({ ok: true, queueStatus: 'queued' });
    expect(
      client.request.mock.calls.filter(([method]) => method === WebLaunchMethod.Prepare),
    ).toHaveLength(1);
  });

  it('keeps a click queued until the user opens the side panel from the toolbar', async () => {
    const controller = createWebLaunchBackground({ chromeApi: api, client });
    api.sidePanel.open.mockRejectedValueOnce(new Error('Chrome did not open the panel'));
    expect(await invoke(controller, launch)).toMatchObject({
      ok: true, queueStatus: 'queued', queueReason: 'panel',
    });
    expect(client.request).not.toHaveBeenCalledWith(WebLaunchMethod.Prepare, expect.anything());

    const panel = panelSender(7);
    await invoke(controller, { type: 'web-launch:panel:register', ...panelScope }, panel);
    await invoke(controller, { type: 'web-launch:panel:state', ...panelScope, composerBusy: false }, panel);
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith(
      WebLaunchMethod.Prepare, expect.objectContaining({ requestId: launch.requestId }),
    ));
    expect(api.sidePanel.open).toHaveBeenCalledTimes(1);
  });

  it('replaces the visible manual draft on a newer click from the same document', async () => {
    const controller = createWebLaunchBackground({ chromeApi: api, client });
    const panel = panelSender(7);
    const panelState = { type: 'web-launch:panel:state', ...panelScope };
    await invoke(controller, { type: 'web-launch:panel:register', ...panelScope }, panel);
    await invoke(controller, launch);
    await invoke(controller, {
      ...panelState, composerBusy: true, replaceableDraftLaunchId: 'launch-1',
    }, panel);
    const original = client.request.getMockImplementation()!;
    client.request.mockImplementation(async (method, params) => {
      if (method === WebLaunchMethod.Cancel) return {
        receipt: { ...reply.receipt, receiptRevision: 2, request: { status: 'cancelled' } },
        internal: { ...reply.internal, replacedDraft: true },
      };
      if (method === WebLaunchMethod.Prepare) return {
        ...reply, receipt: { ...reply.receipt, requestId: params.requestId, launchId: 'launch-2' },
      };
      return original(method, params);
    });
    const otherPage = { ...sender, documentId: 'other-document' };
    const otherClick = { ...launch, requestId: 'other-request', documentNonce: 'other-nonce' };
    expect(await invoke(controller, otherClick, otherPage)).toMatchObject({ queueStatus: 'queued' });
    expect(client.request).not.toHaveBeenCalledWith(WebLaunchMethod.Cancel, expect.anything());
    await invoke(controller, { ...otherClick, type: 'web-launch:document:cancel' }, otherPage);

    expect(await invoke(controller, { ...launch, requestId: 'request-2', clickSequence: 2 }))
      .toMatchObject({ ok: true, queueStatus: 'queued' });
    expect(client.request).toHaveBeenCalledWith(WebLaunchMethod.Cancel, expect.objectContaining({
      launchId: 'launch-1', replacement: { clickSequence: 2, expectedPolicyRevision: 1 },
    }));
    expect(api.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      receipt: expect.objectContaining({ request: { status: 'cancelled' } }),
      internal: expect.objectContaining({ replacedDraft: true }),
    }));
    await invoke(controller, { ...panelState, composerBusy: false }, panel);
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledWith(
      WebLaunchMethod.Prepare, expect.objectContaining({ requestId: 'request-2' }),
    ));
  });

  it.each([
    { panelOpen: true, restart: false },
    { panelOpen: false, restart: false },
    { panelOpen: false, restart: true },
  ])(
    'starts a fresh request while the first is running (panelOpen=$panelOpen, restart=$restart)',
    async ({ panelOpen, restart }) => {
      let controller = createWebLaunchBackground({ chromeApi: api, client });
      const panel = { ...panelSender(7), documentId: 'panel-document' };
      const draft = structuredClone(reply);
      await invoke(controller, { type: 'web-launch:panel:register', ...panelScope }, panel);
      await invoke(controller, launch);
      reply.receipt = {
        ...reply.receipt,
        receiptRevision: 2,
        request: { status: 'submitted' },
        execution: { status: 'running', executionSettled: false },
      };
      await invoke(
        controller,
        { type: 'web-launch:launch:submit', launchId: 'launch-1', ...panelScope },
        panel,
      );
      if (!panelOpen) api.runtime.sendMessage.mockRejectedValue(new Error('Panel closed'));
      if (restart) controller = createWebLaunchBackground({ chromeApi: api, client });

      const running = {
        ...reply,
        receipt: {
          ...reply.receipt,
          receiptRevision: 3,
          request: { status: 'submitted' },
          execution: { status: 'running', executionSettled: false },
          output: { status: 'pending' },
        },
      };
      const original = client.request.getMockImplementation()!;
      client.request.mockImplementation(async (method, params) => {
        if (method === WebLaunchMethod.Observations) return { observations: [running] };
        if (method === WebLaunchMethod.Prepare)
          return {
            ...draft,
            receipt: { ...draft.receipt, requestId: params.requestId, launchId: 'launch-2' },
          };
        return original(method, params);
      });

      order.length = 0;
      const next = invoke(controller, {
        ...launch,
        requestId: 'request-2',
        clickSequence: 2,
      });
      expect(order[0]).toBe('open');
      expect(await next).toMatchObject({ ok: true, receipt: { launchId: 'launch-2' } });
      const preparations = client.request.mock.calls.filter(
        ([method]) => method === WebLaunchMethod.Prepare,
      );
      expect(preparations.map(([, params]) => params.requestId)).toEqual([
        launch.requestId,
        'request-2',
      ]);
    },
  );

  it('cancels a new preparation after a failed probe without revoking the running launch', async () => {
    const controller = createWebLaunchBackground({ chromeApi: api, client });
    const draft = structuredClone(reply);
    await invoke(controller, { type: 'web-launch:panel:register', ...panelScope }, panelSender(7));
    await invoke(controller, launch);
    reply.receipt = {
      ...reply.receipt,
      receiptRevision: 2,
      request: { status: 'submitted' },
      execution: { status: 'running', executionSettled: false },
    };
    await invoke(controller, { type: 'web-launch:launch:submit', launchId: 'launch-1', ...panelScope }, panelSender(7));

    const original = client.request.getMockImplementation()!;
    client.request.mockImplementation(async (method, params) => {
      if (method === WebLaunchMethod.Prepare) {
        api.tabs.sendMessage.mockRejectedValueOnce(new Error('Document probe failed'));
        return { ...draft, receipt: { ...draft.receipt, requestId: params.requestId, launchId: 'launch-2' } };
      }
      if (method === WebLaunchMethod.Cancel) return {};
      return original(method, params);
    });
    expect(await invoke(controller, { ...launch, requestId: 'request-2', clickSequence: 2 }))
      .toMatchObject({ ok: false, code: 'LEASE_REVOKED' });
    expect(client.request).toHaveBeenCalledWith(WebLaunchMethod.Cancel, expect.objectContaining({ launchId: 'launch-2' }));
    expect(client.request).not.toHaveBeenCalledWith(WebLaunchMethod.RevokeDocument, expect.anything());
    expect(await invoke(controller, {
      type: 'web-launch:document:read', requestId: launch.requestId, documentNonce: launch.documentNonce,
    })).toMatchObject({ ok: true, receipt: { launchId: 'launch-1', execution: { status: 'running' } } });
  });

  it('cancels a queued click during reconciliation and keeps the next click queued', async () => {
    const controller = createWebLaunchBackground({ chromeApi: api, client });
    await invoke(controller, launch);
    const original = client.request.getMockImplementation()!;
    let finishObservations!: (value: unknown) => void;
    client.request.mockImplementation(async (method, params) =>
      method === WebLaunchMethod.Observations
        ? new Promise(resolve => {
            finishObservations = resolve;
          })
        : original(method, params),
    );
    const next = invoke(controller, { ...launch, requestId: 'request-2', clickSequence: 2 });
    await vi.waitFor(() => expect(finishObservations).toBeDefined());
    expect(
      await invoke(controller, { ...launch, requestId: 'request-3', clickSequence: 3 }),
    ).toMatchObject({ ok: true, queueStatus: 'queued' });
    await invoke(controller, {
      type: 'web-launch:document:cancel',
      documentNonce: launch.documentNonce,
      requestId: 'request-2',
    });
    finishObservations({
      observations: [
        {
          ...reply,
          receipt: {
            ...reply.receipt,
            receiptRevision: 2,
            request: { status: 'submitted' },
            execution: { status: 'completed', executionSettled: true },
          },
        },
      ],
    });

    expect(await next).toEqual({ ok: true, queueStatus: 'cancelled' });
    expect(
      client.request.mock.calls.filter(([method]) => method === WebLaunchMethod.Prepare),
    ).toHaveLength(1);
  });

  it.each([false, true])(
    'starts each queued click once and in order after a closed panel returns (restart=%s)',
    async restart => {
      let controller = createWebLaunchBackground({ chromeApi: api, client });
      const panel = { ...panelSender(7), documentId: 'panel-document' };
      api.runtime.getContexts = vi.fn().mockResolvedValue([{ documentId: panel.documentId }]);
      const register = { type: 'web-launch:panel:register', ...panelScope };
      await invoke(controller, register, panel);
      const original = client.request.getMockImplementation()!;
      let running: any;
      client.request.mockImplementation(async (method, params) => {
        if (method === WebLaunchMethod.Observations)
          return { observations: running ? [running] : [] };
        if (method === WebLaunchMethod.Prepare)
          return {
            ...reply,
            receipt: {
              ...reply.receipt,
              requestId: params.requestId,
              launchId: `launch-${params.clickSequence}`,
            },
          };
        return original(method, params);
      });
      const click = (sequence: number) =>
        invoke(controller, {
          ...launch,
          requestId: `request-${sequence}`,
          clickSequence: sequence,
        });
      const read = (sequence: number) =>
        invoke(controller, {
          type: 'web-launch:document:read',
          requestId: `request-${sequence}`,
          documentNonce: launch.documentNonce,
        });
      const confirmSend = (sequence: number) => {
        running = {
          ...reply,
          receipt: {
            ...reply.receipt,
            requestId: `request-${sequence}`,
            launchId: `launch-${sequence}`,
            receiptRevision: 2,
            request: { status: 'submitted' },
            execution: { status: 'running', executionSettled: false },
          },
        };
      };
      expect(await click(1)).toMatchObject({ ok: true, receipt: { launchId: 'launch-1' } });
      const waiting = Array.from({ length: 12 }, (_, index) => index + 2);
      const queued = await Promise.all(waiting.map(click));
      expect(queued).toEqual(waiting.map(() => ({ ok: true, queueStatus: 'queued' })));

      api.runtime.getContexts.mockResolvedValue([]);
      if (restart) controller = createWebLaunchBackground({ chromeApi: api, client });
      confirmSend(1);
      expect(await read(2)).toMatchObject({ ok: true, queueStatus: 'queued' });
      await invoke(controller, register, panel);
      api.runtime.getContexts.mockResolvedValue([{ documentId: panel.documentId }]);
      expect(await read(3)).toMatchObject({ ok: true, queueStatus: 'queued' });
      for (const sequence of waiting) {
        expect(await read(sequence)).toMatchObject({ ok: true, receipt: { launchId: `launch-${sequence}` } });
        if (sequence < waiting.at(-1)!)
          expect(await read(sequence + 1)).toMatchObject({ ok: true, queueStatus: 'queued' });
        confirmSend(sequence);
      }
      expect(
        client.request.mock.calls
          .filter(([method]) => method === WebLaunchMethod.Prepare)
          .map(([, params]) => params.clickSequence),
      ).toEqual([1, ...waiting]);
    },
  );

  it('keeps the same request queued behind a local draft until its panel can receive it', async () => {
    const controller = createWebLaunchBackground({ chromeApi: api, client });
    const oldContext = { documentId: 'old-panel-context' };
    api.runtime.getContexts = vi.fn().mockResolvedValue([oldContext]);
    const panel = panelSender(7);
    await invoke(
      controller,
      { type: 'web-launch:panel:register', ...panelScope, composerBusy: true },
      panel,
    );
    expect(api.runtime.getContexts).toHaveBeenCalledWith({
      contextTypes: ['SIDE_PANEL'],
      documentUrls: [panel.url],
    });

    expect(await invoke(controller, launch)).toEqual({
      ok: true,
      queueStatus: 'queued',
      queueReason: 'composer',
    });
    expect(client.request).not.toHaveBeenCalledWith(WebLaunchMethod.Prepare, expect.anything());
    const read = {
      type: 'web-launch:document:read',
      documentNonce: launch.documentNonce,
      requestId: launch.requestId,
    };
    api.runtime.getContexts.mockResolvedValue([]);
    expect(await invoke(controller, read)).toMatchObject({ ok: true, queueStatus: 'queued' });
    expect(api.runtime.getContexts).toHaveBeenLastCalledWith({
      contextTypes: ['SIDE_PANEL'],
      documentIds: ['old-panel-context'],
    });
    api.runtime.getContexts.mockResolvedValue([{ documentId: 'new-panel-context' }]);
    await invoke(
      controller,
      {
        type: 'web-launch:panel:register',
        ...panelScope,
        panelInstanceId: 'new-panel',
        composerBusy: false,
      },
      panel,
    );
    expect(await invoke(controller, read)).toMatchObject({
      ok: true,
      receipt: { requestId: launch.requestId, launchId: 'launch-1' },
    });
  });

  it.each([false, true])(
    'reconciles a lost Prepare ACK after restart without replaying the old click (found=%s)',
    async found => {
      const original = client.request.getMockImplementation()!;
      client.request.mockImplementation(async (method, params) => {
        if (method === WebLaunchMethod.Prepare) {
          if (params.requestId === launch.requestId)
            throw { code: 'REQUEST_TIMEOUT', requestSent: true };
          return {
            ...reply,
            receipt: { ...reply.receipt, requestId: params.requestId, launchId: 'launch-2' },
          };
        }
        if (method === WebLaunchMethod.Read && !found) throw { code: 'EXPIRED' };
        return original(method, params);
      });
      const first = createWebLaunchBackground({ chromeApi: api, client });
      expect(await invoke(first, launch)).toMatchObject({ prepareUncertain: true });
      const restarted = createWebLaunchBackground({ chromeApi: api, client });
      const replacement = await invoke(restarted, {
        ...launch,
        requestId: 'request-2',
        clickSequence: 2,
      });
      expect(replacement).toMatchObject(
        found
          ? { ok: true, queueStatus: 'queued' }
          : { ok: true, receipt: { launchId: 'launch-2' } },
      );
      expect(client.request).toHaveBeenCalledWith(
        WebLaunchMethod.Read,
        expect.objectContaining({ requestId: launch.requestId }),
      );
      if (!found) {
        const nextWorker = createWebLaunchBackground({ chromeApi: api, client });
        expect(
          await invoke(nextWorker, { ...launch, requestId: 'request-3', clickSequence: 3 }),
        ).toEqual({ ok: true, queueStatus: 'queued' });
      }
      expect(
        client.request.mock.calls
          .filter(([method]) => method === WebLaunchMethod.Prepare)
          .map(([, params]) => params.requestId),
      ).toEqual(found ? ['request-1'] : ['request-1', 'request-2']);
    },
  );

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
        return {
          revision: 1,
          sites: [
            {
              origin: sender.origin,
              enabled: true,
              allowSend: true,
              allowResult: true,
              revision: 1,
            },
          ],
        };
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
    expect(await pending).toEqual({ ok: false, code: 'REQUEST_TIMEOUT', prepareUncertain: true });
    expect((await invoke(controller, query)).receipt.launchId).toBe('launch-1');
    expect(
      client.request.mock.calls.filter(([method]) => method === WebLaunchMethod.Prepare),
    ).toHaveLength(1);
    expect(
      client.request.mock.calls.find(([method]) => method === WebLaunchMethod.Read)![1],
    ).toMatchObject({ requestId: launch.requestId });
  });

  it('recovers a new click on the same page after lease rotation without reusing a late old read', async () => {
    const original = client.request.getMockImplementation()!;
    const completed = {
      ...reply,
      receipt: {
        ...reply.receipt,
        request: { status: 'submitted' },
        execution: { status: 'completed', executionSettled: true },
        output: { status: 'available', format: 'text', text: 'Old result' },
      },
    };
    const next = { ...launch, requestId: 'request-2', clickSequence: 2 };
    const prepared = {
      receipt: { ...reply.receipt, requestId: next.requestId, launchId: 'launch-2' },
      internal: { ...reply.internal, documentLeaseId: 'new-lease' },
    };
    let releaseOldRead!: (value: typeof completed) => void;
    client.request.mockImplementation(async (method, params) => {
      if (method === WebLaunchMethod.Prepare) {
        if (params.requestId === launch.requestId) return completed;
        expect(params).not.toHaveProperty('documentLeaseId');
        throw { code: 'REQUEST_TIMEOUT', requestSent: true };
      }
      if (method === WebLaunchMethod.Read) {
        if (params.launchId === completed.receipt.launchId)
          return new Promise(resolve => {
            releaseOldRead = resolve;
          });
        return prepared;
      }
      return original(method);
    });
    const controller = createWebLaunchBackground({ chromeApi: api, client });
    expect((await invoke(controller, launch)).ok).toBe(true);
    const query = {
      type: 'web-launch:document:read',
      documentNonce: launch.documentNonce,
      result: 'final',
    };
    const oldRead = invoke(controller, {
      ...query,
      requestId: launch.requestId,
      launchId: completed.receipt.launchId,
    });
    await vi.waitFor(() => expect(releaseOldRead).toBeTypeOf('function'));
    expect(await invoke(controller, next)).toMatchObject({ prepareUncertain: true });

    const recovered = await invoke(controller, { ...query, requestId: next.requestId });
    expect(recovered).toMatchObject({ ok: true, receipt: { launchId: prepared.receipt.launchId } });
    const readParams = client.request.mock.calls.findLast(
      ([method]) => method === WebLaunchMethod.Read,
    )![1];
    expect(readParams).toMatchObject({
      requestId: next.requestId,
      source: { documentId: sender.documentId },
    });
    expect(readParams).not.toHaveProperty('documentLeaseId');
    releaseOldRead(completed);
    expect(await oldRead).toEqual({ ok: false, code: 'LEASE_REVOKED' });

    expect(
      await invoke(controller, {
        ...query,
        requestId: next.requestId,
        launchId: prepared.receipt.launchId,
      }),
    ).toMatchObject({ ok: true });
    expect(
      client.request.mock.calls.findLast(([method]) => method === WebLaunchMethod.Read)![1],
    ).toMatchObject({ launchId: prepared.receipt.launchId, documentLeaseId: 'new-lease' });
    expect(
      client.request.mock.calls.filter(([method]) => method === WebLaunchMethod.Prepare),
    ).toHaveLength(2);
  });

  it('releases the launch slot when Main confirms rejection even though the request was sent', async () => {
    const original = client.request.getMockImplementation()!;
    client.request.mockImplementation(async (method, params) => {
      if (method === WebLaunchMethod.Prepare && params.requestId === launch.requestId)
        throw { code: 'CAPACITY_EXCEEDED', requestSent: true, responseReceived: true };
      return original(method, params);
    });
    const controller = createWebLaunchBackground({ chromeApi: api, client });
    expect(await invoke(controller, launch)).toMatchObject({ ok: false, code: 'CAPACITY_EXCEEDED' });
    expect(storage.chromeWebLaunchSession.requests[launch.requestId]).toBeUndefined();

    const next = { ...launch, requestId: 'request-2', clickSequence: 2 };
    reply.receipt.requestId = next.requestId;
    expect(await invoke(controller, next)).toMatchObject({
      ok: true,
      receipt: { requestId: next.requestId },
    });
  });

  it('releases the window when the document is revoked while a new prepare ACK is being checked', async () => {
    reply.receipt.execution = { status: 'completed', executionSettled: true };
    const controller = createWebLaunchBackground({ chromeApi: api, client });
    expect((await invoke(controller, launch)).ok).toBe(true);
    const original = client.request.getMockImplementation()!;
    const revokeLease = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce({ code: 'EXPIRED' });
    const activeProbe = api.tabs.sendMessage.getMockImplementation();
    let releaseProbe!: () => void;
    client.request.mockImplementation(async (method, params) => {
      if (method === WebLaunchMethod.RevokeDocument) return revokeLease();
      if (method === WebLaunchMethod.Prepare && params.requestId === 'request-2') {
        api.tabs.sendMessage.mockImplementationOnce(async (_tab: number, message: any) => {
          await new Promise<void>(resolve => {
            releaseProbe = resolve;
          });
          return { active: true, documentNonce: message.documentNonce };
        });
      }
      return original(method, params);
    });
    const next = { ...launch, requestId: 'request-2', clickSequence: 2 };
    reply.receipt.requestId = next.requestId;
    reply.receipt.launchId = 'launch-2';
    const pending = invoke(controller, next);
    await vi.waitFor(() => expect(releaseProbe).toBeTypeOf('function'));
    expect(
      await invoke(controller, {
        type: 'web-launch:document:revoke',
        documentNonce: launch.documentNonce,
        reason: 'pagehide',
      }),
    ).toEqual({ ok: true });
    releaseProbe();
    expect(await pending).toMatchObject({ ok: false, code: 'LEASE_REVOKED' });
    expect(revokeLease).toHaveBeenCalledTimes(2);
    expect(storage.chromeWebLaunchSession.requests[next.requestId]).toBeUndefined();

    api.tabs.sendMessage.mockImplementation(activeProbe);
    reply.receipt.requestId = 'request-3';
    reply.receipt.launchId = 'launch-3';
    expect(
      await invoke(
        controller,
        {
          ...launch,
          requestId: 'request-3',
          documentNonce: 'next-document-nonce',
        },
        { ...sender, documentId: 'next-document' },
      ),
    ).toMatchObject({ ok: true });
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
        ...panelScope,
        composerBusy: false,
      },
      panelSender(7),
    );
    await invoke(
      controller,
      {
        type: 'web-launch:panel:state',
        ...panelScope,
        composerBusy: false,
        launchId: 'launch-1',
      },
      panelSender(7),
    );
    await vi.waitFor(() =>
      expect(api.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          receipt: expect.objectContaining({
            execution: { status: 'running', executionSettled: false },
          }),
          envelope: undefined,
        }),
      ),
    );
    const reopened = await invoke(
      controller,
      {
        type: 'web-launch:panel:register',
        ...panelScope,
        panelInstanceId: 'panel-2',
        composerBusy: false,
      },
      panelSender(7),
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

  it('restores a revised lower permission with its input after a worker restart and an older observation', async () => {
    const first = createWebLaunchBackground({ chromeApi: api, client });
    reply.internal.permissionMode = 'full';
    const webpage = await invoke(first, launch);
    expect(webpage.receipt).not.toHaveProperty('permissionMode');
    expect(webpage).not.toHaveProperty('internal');

    const older = structuredClone(reply);
    const revision = {
      ...reply,
      receipt: { ...reply.receipt, receiptRevision: 2 },
      internal: { ...reply.internal, composeRevision: 2, permissionMode: 'ask' },
    };
    const original = client.request.getMockImplementation()!;
    let releaseObservation!: (value: unknown) => void;
    let releaseRevision!: (value: unknown) => void;
    client.request.mockImplementation(async (method, params) => {
      if (method === WebLaunchMethod.Observations)
        return new Promise(resolve => {
          releaseObservation = resolve;
        });
      if (method === WebLaunchMethod.Revise)
        return new Promise(resolve => {
          releaseRevision = resolve;
        });
      return original(method, params);
    });
    const restarted = createWebLaunchBackground({ chromeApi: api, client });
    const register = { type: 'web-launch:panel:register', ...panelScope };
    const panel = panelSender(7);
    expect((await invoke(restarted, register, panel)).envelope.permissionMode).toBe('full');
    await invoke(restarted, { type: 'web-launch:panel:state', ...panelScope }, panel);
    await vi.waitFor(() => expect(releaseObservation).toBeTypeOf('function'));

    const revising = invoke(
      restarted,
      {
        type: 'web-launch:launch:revise',
        ...panelScope,
        launchId: reply.receipt.launchId,
        expectedComposeRevision: 1,
        input: { prompt: 'revised', context: { text: 'edited context' }, permissionMode: 'ask' },
      },
      panel,
    );
    await vi.waitFor(() => expect(releaseRevision).toBeTypeOf('function'));
    const reopened = { ...register, panelInstanceId: 'reopened-panel' };
    expect((await invoke(restarted, reopened, panel)).envelope).toBeNull();

    releaseRevision(revision);
    const revised = await revising;
    const draft = {
      prompt: 'revised',
      contextText: 'edited context',
      permissionMode: 'ask',
      composeRevision: 2,
    };
    expect(revised.envelope).toMatchObject(draft);
    expect(api.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        panelInstanceId: 'reopened-panel',
        envelope: expect.objectContaining(draft),
      }),
    );

    const events = api.runtime.sendMessage.mock.calls.length;
    releaseObservation({ observations: [older] });
    await vi.waitFor(() =>
      expect(api.runtime.sendMessage.mock.calls.length).toBeGreaterThan(events),
    );
    const restored = await invoke(restarted, reopened, panel);
    expect(restored.envelope).toMatchObject(draft);
    expect(restored.envelope.receipt.receiptRevision).toBe(2);
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
        return {
          revision: 1,
          sites: [
            {
              origin: sender.origin,
              enabled: true,
              allowSend: true,
              allowResult: true,
              revision: 1,
            },
          ],
        };
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
    const panel = panelSender(7);
    await invoke(second, { type: 'web-launch:panel:register', ...panelScope }, panel);
    api.tabs.sendMessage.mockRejectedValue(new Error('No document'));
    const response = await invoke(
      second,
      {
        type: 'web-launch:launch:submit',
        ...panelScope,
        launchId: 'launch-1',
        composeRevision: 1,
        input: { prompt: 'hello', permissionMode: 'ask' },
        submission: 'confirmed',
        shareResult: false,
      },
      panel,
    );
    expect(response).toEqual({ ok: false, code: 'EXPIRED' });
    expect(client.request.mock.calls.some(([method]) => method === WebLaunchMethod.Submit)).toBe(
      false,
    );
  });

  it('passes a definite pre-dispatch error only to the trusted submitting panel', async () => {
    const controller = createWebLaunchBackground({ chromeApi: api, client });
    await invoke(controller, launch);
    const panel = panelSender(7);
    await invoke(controller, { type: 'web-launch:panel:register', ...panelScope }, panel);
    const original = client.request.getMockImplementation()!;
    const failures = [
      { code: 'CONFIRMATION_REQUIRED', requestSent: false },
      { code: 'CONFIRMATION_REQUIRED', requestSent: true },
    ];
    client.request.mockImplementation(async (method, params) => {
      if (method === WebLaunchMethod.Submit) throw failures.shift();
      return original(method, params);
    });
    const submit = {
      type: 'web-launch:launch:submit',
      ...panelScope,
      launchId: 'launch-1',
      composeRevision: 1,
      input: { prompt: 'hello', permissionMode: 'ask' },
      submission: 'confirmed',
      shareResult: false,
    };

    expect(await invoke(controller, submit)).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(await invoke(controller, submit, panel)).toEqual({
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
      requestSent: false,
    });
    expect(await invoke(controller, submit, panel)).toEqual({
      ok: false,
      code: 'CONFIRMATION_REQUIRED',
    });
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
        ...panelScope,
        composerBusy: false,
      },
      panelSender(7),
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

  it('abandons one observation without retiring its webpage channel', async () => {
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
    ).toBe(false);
    reply.receipt.requestId = 'request-2';
    reply.receipt.launchId = 'launch-2';
    const result = await invoke(controller, {
      ...launch,
      requestId: 'request-2',
      clickSequence: 2,
    });
    expect(result.ok).toBe(true);
    const preparations = client.request.mock.calls.filter(([method]) => method === WebLaunchMethod.Prepare);
    expect(preparations[1][1].source).toEqual(preparations[0][1].source);
  });

  it('drops a delayed preparation for an abandoned launch and processes the next click', async () => {
    const controller = createWebLaunchBackground({ chromeApi: api, client });
    const original = client.request.getMockImplementation()!;
    let resolvePrepare!: (value: unknown) => void;
    client.request.mockImplementation(async (method, params) => {
      if (method === WebLaunchMethod.Prepare && params.requestId === launch.requestId)
        return new Promise(resolve => { resolvePrepare = resolve; });
      if (method === WebLaunchMethod.Abandon)
        return { status: 'abandoned', requestId: launch.requestId };
      return original(method, params);
    });
    const first = invoke(controller, launch);
    await vi.waitFor(() => expect(resolvePrepare).toBeDefined());
    await invoke(
      controller,
      { type: 'web-launch:launch:abandon', launchId: 'launch-1', confirm: true },
      trusted,
    );
    resolvePrepare(structuredClone(reply));
    expect(await first).toMatchObject({ ok: false, code: 'EXPIRED' });

    reply.receipt.requestId = 'request-2';
    reply.receipt.launchId = 'launch-2';
    expect(await invoke(controller, { ...launch, requestId: 'request-2', clickSequence: 2 }))
      .toMatchObject({ ok: true, receipt: { launchId: 'launch-2' } });
  });
});
