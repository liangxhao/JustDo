import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WebLaunchMethod } from '../../../plugins/chrome-extensions/chrome-assistant/contracts/webLaunch';
import { AppServerConnection } from '../clients/appServer/protocol/appServerConnection';
import type { AppServerConnectionContext, AppServerOperation } from '../clients/appServer/protocol/appServerProtocol';
import { ChromeAppServerHub } from './chromeAppServerBinding';
import { ChromeAppServerMethod, ChromeAppServerNotificationMethod, chromeWebLaunchMethods } from './chromeAppServerProtocol';
import type { ChromeExtensionChatApi } from './chromeAppServerTypes';
import type { ChromeWebLaunchService } from './chromeWebLaunchService';

const connections: AppServerConnection[] = [];
const hubs: ChromeAppServerHub[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map(connection => connection.close()));
  await Promise.all(hubs.splice(0).map(hub => hub.stop()));
});

function fixture(operations?: Partial<Record<WebLaunchMethod, AppServerOperation>>, executeNotifications = false) {
  const thread = { id: 'owned', title: 'Browser', cwd: '/task', permissionMode: 'ask' as const,
    status: 'idle', createdAt: 1, updatedAt: 1 };
  const api: ChromeExtensionChatApi = {
    listSessions: vi.fn(() => [thread]),
    startThread: vi.fn(async () => thread),
    subscribeThreadEvents: vi.fn(async () => vi.fn()),
    getMessages: vi.fn(async () => []),
    getComposerOptions: vi.fn(async () => ({ models: [], permissionMode: 'ask' })),
    readManagedImage: vi.fn(async () => 'data:image/png;base64,'),
    getThreadRuntimeStatus: vi.fn(async () => ({ known: true, running: false })),
    consumeTurnError: vi.fn(),
    getTurnState: vi.fn(async () => null),
    sendMessage: vi.fn(),
    interruptThread: vi.fn(),
  };
  const pair = vi.fn(async () => ({ pairingString: 'prepared-pairing' }));
  const service = operations ? { getOperations: () => operations, close: vi.fn() } as unknown as ChromeWebLaunchService : undefined;
  const hub = new ChromeAppServerHub(api, 'test', pair, service);
  hub.activate();
  hubs.push(hub);
  const output: Array<Record<string, unknown>> = [];
  let context!: AppServerConnectionContext;
  const connection = new AppServerConnection(value => {
    context = value;
    const binding = hub.connect(value);
    binding.initialization.executeNotifications = executeNotifications;
    return binding;
  }, value => output.push(value as Record<string, unknown>));
  connections.push(connection);
  const request = (method: string, params = {}) => connection.receive({ id: output.length + 1, method, params });
  const initialize = async (capabilities = {}) => {
    await request('initialize', { clientInfo: { name: 'browser-protocol-test', version: '1' }, capabilities });
    await connection.receive({ method: 'initialized' });
  };
  return { api, pair, connection, output, request, initialize, get context() { return context; } };
}

describe('browser-owned app-server extensions', () => {
  it('routes image, composer and pairing only by their explicit browser namespaces', async () => {
    const h = fixture();
    await h.initialize();
    for (const method of ['thread/image', 'composer/options', 'extension/pair']) {
      await h.request(method, { threadId: 'owned' });
      expect(h.output.at(-1)).toMatchObject({ error: { code: -32601 } });
    }
    expect(h.api.readManagedImage).not.toHaveBeenCalled();
    expect(h.api.getComposerOptions).not.toHaveBeenCalled();
    expect(h.pair).not.toHaveBeenCalled();

    await h.request(ChromeAppServerMethod.ThreadImage, { threadId: 'owned', source: 'media:outgoing:image' });
    expect(h.api.readManagedImage).toHaveBeenCalledExactlyOnceWith('owned', 'media:outgoing:image');
    await h.request(ChromeAppServerMethod.ComposerOptions, { threadId: 'owned' });
    expect(h.api.getComposerOptions).toHaveBeenCalledExactlyOnceWith('owned');
    await h.request(ChromeAppServerMethod.ChromePair);
    expect(h.output.at(-1)).toMatchObject({ result: { pairingString: 'prepared-pairing' } });
    h.context.notify(ChromeAppServerNotificationMethod.ThreadStream, { threadId: 'owned' });
    expect(h.output.at(-1)).toEqual({ method: 'chrome/thread/stream', params: { threadId: 'owned' } });
    h.context.notify(ChromeAppServerNotificationMethod.ThreadUpdated, { threadId: 'owned' });
    expect(h.output.at(-1)).toEqual({ method: 'chrome/thread/updated', params: { threadId: 'owned' } });
    h.context.notify(ChromeAppServerNotificationMethod.WebLaunchChanged, {});
    expect(h.output.at(-1)).toEqual({ method: 'chrome/webLaunch/changed', params: {} });
  });

  it('cannot enable absent web capabilities through clientInfo or handshake declarations', async () => {
    const h = fixture();
    await h.initialize({ webLaunch: true, chromePairing: true });
    await h.request(ChromeAppServerMethod.WebLaunchPrepare, { launchId: 'untrusted' });
    expect(h.output.at(-1)).toMatchObject({ error: { code: -32601 } });
    expect(h.api.sendMessage).not.toHaveBeenCalled();
  });

  it('admits only registered web methods and never launches work from an ID-less message', async () => {
    const prepare = vi.fn(() => ({ receipt: { launchId: 'owned' } }));
    const arbitrary = vi.fn(() => ({}));
    const h = fixture({ [ChromeAppServerMethod.WebLaunchPrepare]: prepare,
      'chrome/webLaunch/arbitraryGatewayRpc': arbitrary } as never, true);
    await h.initialize();
    for (const method of chromeWebLaunchMethods)
      await h.connection.receive({ method, params: {} });
    expect(prepare).not.toHaveBeenCalled();
    await h.request(ChromeAppServerMethod.WebLaunchPrepare, { requestId: 'one' });
    expect(prepare).toHaveBeenCalledExactlyOnceWith({ requestId: 'one' });
    await h.request('chrome/webLaunch/arbitraryGatewayRpc');
    expect(h.output.at(-1)).toMatchObject({ error: { code: -32601 } });
    expect(arbitrary).not.toHaveBeenCalled();
  });

  it('closes web errors over known codes without exposing native exceptions or offered message keys', async () => {
    const read = vi.fn(() => { throw new Error('private URL and token'); });
    const h = fixture({ [ChromeAppServerMethod.WebLaunchRead]: read });
    await h.initialize();
    await h.request(ChromeAppServerMethod.WebLaunchRead);
    expect(h.output.at(-1)).toEqual({ id: 2, error: { code: -32603, message: 'INTERNAL_ERROR',
      data: { code: 'INTERNAL_ERROR', messageKey: 'webLaunchErrorINTERNAL_ERROR' } } });

    read.mockImplementationOnce(() => {
      throw Object.assign(new Error('private cause'), { publicError: { code: 'EXPIRED', messageKey: 'unsafe body' } });
    });
    await h.request(ChromeAppServerMethod.WebLaunchRead);
    expect(h.output.at(-1)).toMatchObject({ error: { code: -32603, message: 'EXPIRED',
      data: { code: 'EXPIRED', messageKey: 'webLaunchErrorEXPIRED' } } });

    read.mockImplementationOnce(() => {
      throw { message: 'private cause', publicError: { code: 'PRIVATE_CODE', messageKey: 'private key' }, data: { secret: 'private detail' } };
    });
    await h.request(ChromeAppServerMethod.WebLaunchRead);
    expect(h.output.at(-1)).toMatchObject({ error: { code: -32603, message: 'INTERNAL_ERROR',
      data: { code: 'INTERNAL_ERROR', messageKey: 'webLaunchErrorINTERNAL_ERROR' } } });
    expect(JSON.stringify(h.output)).not.toMatch(/private|unsafe|PRIVATE_CODE/);
  });

  it('keeps pairing credential-bearing failures private', async () => {
    const h = fixture();
    h.pair.mockRejectedValueOnce(new Error('private pairing credentials'));
    await h.initialize();
    await h.request(ChromeAppServerMethod.ChromePair);
    expect(h.output.at(-1)).toMatchObject({ error: { message: 'Chrome extension pairing is unavailable.' } });
    expect(JSON.stringify(h.output)).not.toContain('private pairing credentials');
  });
});
