import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { BrowserExtensionStream } from '../../../renderer/libs/openclaw-chat/model/browser-extension-stream';
import type { BrowserExtensionStreamEvent } from '../../../shared/browser/browserExtensionStream';
import {
  BROWSER_EXTENSION_ID,
  BROWSER_EXTENSION_PAIR_METHOD,
  type BrowserExtensionChatApi,
  BrowserExtensionChatServer,
} from './browserExtensionChatServer';

const token = 'a'.repeat(64);
let server: BrowserExtensionChatServer | null = null;

const createApi = (): BrowserExtensionChatApi => ({
  subscribeThreadEvents: vi.fn(async () => () => {}),
  listSessions: vi.fn(() => [
    {
      createdAt: 1_000,
      cwd: 'C:\\workspace',
      id: 'one',
      permissionMode: 'full',
      status: 'idle',
      title: 'One',
      updatedAt: 2_000,
    },
  ]),
  getMessages: vi.fn(async () => [{ role: 'assistant', text: 'Hello' }]),
  getComposerOptions: vi.fn(async () => ({
    modelRef: 'provider/model',
    models: [{ id: 'provider/model', name: 'Model' }],
    permissionMode: 'full',
  })),
  startThread: vi.fn(async title => ({
    id: 'new',
    createdAt: 1_000,
    cwd: 'C:\\workspace',
    permissionMode: 'full',
    status: 'idle',
    title: title ?? 'New',
    updatedAt: 2,
  })),
  sendMessage: vi.fn(async () => ({ sessionId: 'one', runId: 'run-1' })),
  getThreadRuntimeStatus: vi.fn(async () => ({ known: true, running: false })),
  consumeTurnError: vi.fn(() => undefined),
  interruptThread: vi.fn(async () => undefined),
});

const connect = async (url: string, origin = `chrome-extension://${BROWSER_EXTENSION_ID}`) => {
  const socket = new WebSocket(url, { origin });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
};

const request = async (socket: WebSocket, id: string, method: string, params = {}) => {
  const response = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out.')), 2_000);
    const onMessage = (data: WebSocket.RawData) => {
      const parsed = JSON.parse(data.toString()) as Record<string, unknown>;
      if (parsed.id !== id) return;
      clearTimeout(timeout);
      socket.off('message', onMessage);
      resolve(parsed);
    };
    socket.on('message', onMessage);
  });
  socket.send(JSON.stringify({ id, method, params }));
  return response;
};

afterEach(async () => {
  await server?.stop();
  server = null;
});

describe('BrowserExtensionChatServer', () => {
  it('provides relay pairing only after the authenticated initialization handshake', async () => {
    const createPairing = vi.fn(async () => ({ pairingString: 'fixture-pairing' }));
    const api = createApi();
    server = new BrowserExtensionChatServer(api, token, 'test', 0, createPairing);
    await server.start();
    const socket = await connect(server.getCapability().localAppServerUrl);
    try {
      expect(await request(socket, 'early', BROWSER_EXTENSION_PAIR_METHOD)).toHaveProperty('error');
      expect(createPairing).not.toHaveBeenCalled();
      socket.send(JSON.stringify({ method: 'initialized' }));
      expect(await request(socket, 'premature', BROWSER_EXTENSION_PAIR_METHOD)).toHaveProperty(
        'error',
      );
      expect(createPairing).not.toHaveBeenCalled();
      await request(socket, 'init', 'initialize');
      socket.send(JSON.stringify({ method: 'initialized' }));
      expect(await request(socket, 'pair', BROWSER_EXTENSION_PAIR_METHOD)).toMatchObject({
        result: { pairingString: 'fixture-pairing' },
      });
      expect(createPairing).toHaveBeenCalledOnce();
      expect(api.listSessions).not.toHaveBeenCalled();
      expect(api.startThread).not.toHaveBeenCalled();
    } finally {
      socket.close();
    }
  });

  it('redacts native pairing errors that may contain credential-bearing CLI output', async () => {
    server = new BrowserExtensionChatServer(createApi(), token, 'test', 0, async () => {
      throw new Error('private-pairing-token in CLI stdout');
    });
    await server.start();
    const socket = await connect(server.getCapability().localAppServerUrl);
    try {
      await request(socket, 'init', 'initialize');
      socket.send(JSON.stringify({ method: 'initialized' }));
      const response = await request(socket, 'pair', BROWSER_EXTENSION_PAIR_METHOD);
      expect(response).toMatchObject({
        error: { message: 'Browser extension pairing is unavailable.' },
      });
      expect(JSON.stringify(response)).not.toContain('private-pairing-token');
    } finally {
      socket.close();
    }
  });
  it('shares pending pairing across connections and retries after failure', async () => {
    const pending = Promise.withResolvers<{ pairingString: string }>();
    const createPairing = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ pairingString: 'fixture-pairing' });
    server = new BrowserExtensionChatServer(createApi(), token, 'test', 0, createPairing);
    await server.start();
    const first = await connect(server.getCapability().localAppServerUrl);
    const second = await connect(server.getCapability().localAppServerUrl);
    try {
      for (const socket of [first, second]) {
        await request(socket, 'init', 'initialize');
        socket.send(JSON.stringify({ method: 'initialized' }));
      }
      const firstRequest = request(first, 'pair-1', BROWSER_EXTENSION_PAIR_METHOD);
      const secondRequest = request(second, 'pair-2', BROWSER_EXTENSION_PAIR_METHOD);
      // Both transports must have reached dispatch before completing the shared work.
      await request(second, 'barrier', 'initialize');
      expect(createPairing).toHaveBeenCalledOnce();
      pending.reject(new Error('copy failed'));
      const failures = await Promise.all([firstRequest, secondRequest]);
      expect(failures.every(response => Boolean(response.error))).toBe(true);
      expect(await request(first, 'retry', BROWSER_EXTENSION_PAIR_METHOD)).toMatchObject({
        result: { pairingString: 'fixture-pairing' },
      });
      expect(createPairing).toHaveBeenCalledTimes(2);
    } finally {
      first.close();
      second.close();
    }
  });
  it.each(['media://inbound/photo.jpg', '/api/chat/media/outgoing/session/artifact/full'])(
    'loads managed images through the session-scoped desktop bridge: %s',
    async source => {
      const api = createApi();
      api.readManagedImage = vi.fn(async () => 'data:image/jpeg;base64,aW1hZ2U=');
      server = new BrowserExtensionChatServer(api, token, 'test');
      await server.start();
      const socket = await connect(server.getCapability().localAppServerUrl);
      try {
        await request(socket, 'init', 'initialize', { clientInfo: { name: 'test', version: '1' } });
        socket.send(JSON.stringify({ method: 'initialized' }));
        expect(
          await request(socket, 'image', 'thread/image', { threadId: 'one', source }),
        ).toMatchObject({ result: { dataUrl: 'data:image/jpeg;base64,aW1hZ2U=' } });
        expect(api.readManagedImage).toHaveBeenCalledWith('one', source);
        expect(api.getMessages).not.toHaveBeenCalled();
      } finally {
        socket.close();
      }
    },
  );
  it('returns image-only items and rejects image reads before initialization or for another thread', async () => {
    const api = createApi();
    const rawMessage = {
      role: 'assistant',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } },
      ],
    };
    vi.mocked(api.getMessages).mockResolvedValue([{ role: 'assistant', text: '', rawMessage }]);
    server = new BrowserExtensionChatServer(api, token, 'test');
    await server.start();
    const capability = server.getCapability();
    const socket = await connect(capability.localAppServerUrl);
    try {
      expect(
        await request(socket, 'early', 'thread/image', { threadId: 'one', source: 'secret.png' }),
      ).toHaveProperty('error');
      await request(socket, 'init', 'initialize', { clientInfo: { name: 'test', version: '1' } });
      socket.send(JSON.stringify({ method: 'initialized' }));
      const result = await request(socket, 'read', 'thread/read', {
        threadId: 'one',
        includeTurns: true,
      });
      expect(result).toMatchObject({
        result: {
          thread: { turns: [{ items: [{ type: 'agentMessage', text: '', rawMessage }] }] },
        },
      });
      expect(
        await request(socket, 'image', 'thread/image', { threadId: 'other', source: 'secret.png' }),
      ).toHaveProperty('error');
    } finally {
      socket.close();
    }
  });

  it('delivers and projects text before the send acknowledgement or persisted assistant reply', async () => {
    const api = createApi();
    let emit: (event: BrowserExtensionStreamEvent) => void = () => {
      throw new Error('Not subscribed');
    };
    const dispose = vi.fn();
    vi.mocked(api.subscribeThreadEvents).mockImplementation(async (_id, listener) => {
      emit = listener;
      return dispose;
    });
    vi.mocked(api.getMessages).mockResolvedValue([{ role: 'user', text: 'Question' }]);
    vi.mocked(api.getThreadRuntimeStatus).mockResolvedValue({ known: true, running: true });
    vi.mocked(api.sendMessage).mockImplementation(async () => {
      emit({
        kind: 'agent',
        event: {
          sessionKey: 'agent:main:justdo:one',
          sessionId: null,
          runId: 'run-1',
          agentSeq: 1,
          frameSeq: 1,
          lifecycleGeneration: null,
          agentId: 'main',
          spawnedBy: null,
          deliveryEvent: 'agent',
          stream: 'assistant',
          timestamp: 1,
          data: { text: 'First words' },
        },
      });
      return { sessionId: 'one', runId: 'run-1' };
    });
    server = new BrowserExtensionChatServer(api, token, '1.0.0');
    await server.start();
    const socket = await connect(server.getCapability().localAppServerUrl);
    await request(socket, 'init', 'initialize');
    socket.send(JSON.stringify({ method: 'initialized' }));
    const view = new BrowserExtensionStream('one');
    view.start('Question');
    const received: string[] = [];
    socket.on('message', data => {
      const value = JSON.parse(data.toString());
      received.push(value.method ?? value.id);
      if (value.method === 'thread/stream') view.accept(value.params);
      if (value.method === 'thread/updated') view.setHistory(value.params.thread);
    });
    await request(socket, 'send', 'turn/start', { threadId: 'one', message: 'Question' });
    expect(received.indexOf('thread/stream')).toBeLessThan(received.indexOf('send'));
    expect(view.project().turns[0].items).toMatchObject([
      { type: 'userMessage' },
      { type: 'agentMessage', text: 'First words' },
    ]);
    expect(await api.getMessages('one')).toEqual([{ role: 'user', text: 'Question' }]);
    await request(socket, 'unsubscribe', 'thread/unsubscribe', { threadId: 'one' });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
  });

  it('shares a stream between panels and releases it after the last panel leaves', async () => {
    const api = createApi();
    const dispose = vi.fn();
    vi.mocked(api.subscribeThreadEvents).mockResolvedValue(dispose);
    server = new BrowserExtensionChatServer(api, token, '1.0.0');
    await server.start();
    const a = await connect(server.getCapability().localAppServerUrl);
    const b = await connect(server.getCapability().localAppServerUrl);
    for (const socket of [a, b]) {
      await request(socket, 'init', 'initialize');
      socket.send(JSON.stringify({ method: 'initialized' }));
      await request(socket, 'read', 'thread/read', { threadId: 'one', includeTurns: true });
    }
    expect(api.subscribeThreadEvents).toHaveBeenCalledTimes(1);
    await request(a, 'leave', 'thread/unsubscribe', { threadId: 'one' });
    expect(dispose).not.toHaveBeenCalled();
    b.close();
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
  });
  it('releases a pending subscription after its panel disconnects', async () => {
    const api = createApi();
    const dispose = vi.fn();
    let resolveSubscription!: (dispose: () => void) => void;
    vi.mocked(api.subscribeThreadEvents).mockReturnValue(
      new Promise(resolve => {
        resolveSubscription = resolve;
      }),
    );
    server = new BrowserExtensionChatServer(api, token, '1.0.0');
    await server.start();
    const socket = await connect(server.getCapability().localAppServerUrl);
    await request(socket, 'init', 'initialize');
    socket.send(JSON.stringify({ method: 'initialized' }));
    socket.send(JSON.stringify({ id: 'read', method: 'thread/read', params: { threadId: 'one' } }));
    await vi.waitFor(() => expect(api.subscribeThreadEvents).toHaveBeenCalledTimes(1));
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
    socket.close();
    await closed;
    resolveSubscription(dispose);
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
    expect(api.getMessages).not.toHaveBeenCalled();
  });

  it('keeps a pending subscription for a replacement panel after the first disconnects', async () => {
    const api = createApi();
    const dispose = vi.fn();
    let resolveSubscription!: (dispose: () => void) => void;
    vi.mocked(api.subscribeThreadEvents).mockReturnValue(
      new Promise(resolve => {
        resolveSubscription = resolve;
      }),
    );
    server = new BrowserExtensionChatServer(api, token, '1.0.0');
    await server.start();
    const url = server.getCapability().localAppServerUrl;
    const a = await connect(url);
    await request(a, 'init', 'initialize');
    a.send(JSON.stringify({ method: 'initialized' }));
    a.send(JSON.stringify({ id: 'read', method: 'thread/read', params: { threadId: 'one' } }));
    await vi.waitFor(() => expect(api.subscribeThreadEvents).toHaveBeenCalledTimes(1));
    const closed = new Promise<void>(resolve => a.once('close', () => resolve()));
    a.close();
    await closed;
    const b = await connect(url);
    await request(b, 'init', 'initialize');
    b.send(JSON.stringify({ method: 'initialized' }));
    const read = request(b, 'read', 'thread/read', { threadId: 'one', includeTurns: true });
    await vi.waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(2));
    resolveSubscription(dispose);
    await expect(read).resolves.toMatchObject({ result: { thread: { id: 'one' } } });
    expect(api.subscribeThreadEvents).toHaveBeenCalledTimes(1);
    expect(dispose).not.toHaveBeenCalled();
    await request(b, 'leave', 'thread/unsubscribe', { threadId: 'one' });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1));
  });

  it('requires the fixed extension origin and capability URL', async () => {
    server = new BrowserExtensionChatServer(createApi(), token, '1.0.0');
    await server.start();
    const capability = server.getCapability();

    await expect(
      connect(capability.localAppServerUrl, 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
    ).rejects.toThrow();
    await expect(
      connect(capability.localAppServerUrl.replace(token, 'b'.repeat(64))),
    ).rejects.toThrow();
  });

  it('uses the Codex app-server request and notification shape', async () => {
    const api = createApi();
    server = new BrowserExtensionChatServer(api, token, '1.0.0');
    await server.start();
    const socket = await connect(server.getCapability().localAppServerUrl);

    await expect(request(socket, '1', 'initialize')).resolves.toMatchObject({
      id: '1',
      result: { platformFamily: expect.any(String), userAgent: 'JustDo/1.0.0' },
    });
    socket.send(JSON.stringify({ method: 'initialized' }));
    await expect(request(socket, '2', 'thread/list')).resolves.toMatchObject({
      result: { data: [{ id: 'one', status: { type: 'idle' } }], nextCursor: null },
    });
    await expect(
      request(socket, '3', 'thread/read', { includeTurns: true, threadId: 'one' }),
    ).resolves.toMatchObject({
      result: {
        thread: {
          id: 'one',
          turns: [{ items: [{ text: 'Hello', type: 'agentMessage' }], status: 'completed' }],
        },
      },
    });
    await expect(
      request(socket, 'options', 'composer/options', { threadId: 'one' }),
    ).resolves.toMatchObject({
      result: {
        modelRef: 'provider/model',
        models: [{ id: 'provider/model', name: 'Model' }],
        permissionMode: 'full',
      },
    });
    await expect(
      request(socket, '4', 'turn/start', {
        attachments: [{ base64Data: 'aGVsbG8=', mimeType: 'text/plain', name: 'note.txt' }],
        input: [{ text: 'Question', type: 'text' }],
        modelRef: 'provider/model',
        permissionMode: 'auto',
        threadId: 'one',
      }),
    ).resolves.toMatchObject({
      result: { turn: { error: null, id: 'run-1', items: [], status: 'inProgress' } },
    });
    expect(api.sendMessage).toHaveBeenCalledWith({
      attachments: [{ base64Data: 'aGVsbG8=', mimeType: 'text/plain', name: 'note.txt' }],
      message: 'Question',
      modelRef: 'provider/model',
      pageContext: undefined,
      permissionMode: 'auto',
      sessionId: 'one',
    });
    await expect(
      request(socket, '5', 'turn/start', {
        input: [{ text: 'Question', type: 'text' }],
        permissionMode: 'unexpected',
        threadId: 'one',
      }),
    ).resolves.toMatchObject({ error: { message: 'Invalid permission mode.' } });
    socket.close();
  });

  it('restores a thread notification subscription when the client reads it', async () => {
    const api = createApi();
    server = new BrowserExtensionChatServer(api, token, '1.0.0');
    await server.start();
    const url = server.getCapability().localAppServerUrl;
    const reader = await connect(url);
    const sender = await connect(url);
    await request(reader, 'reader-init', 'initialize');
    reader.send(JSON.stringify({ method: 'initialized' }));
    await request(sender, 'sender-init', 'initialize');
    sender.send(JSON.stringify({ method: 'initialized' }));
    await request(reader, 'read', 'thread/read', { includeTurns: true, threadId: 'one' });

    const notification = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Timed out waiting for notification.')),
        2_000,
      );
      const onMessage = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.method !== 'turn/started') return;
        clearTimeout(timeout);
        reader.off('message', onMessage);
        resolve(message);
      };
      reader.on('message', onMessage);
    });

    await request(sender, 'turn', 'turn/start', {
      input: [{ text: 'Question', type: 'text' }],
      threadId: 'one',
    });
    await expect(notification).resolves.toMatchObject({
      method: 'turn/started',
      params: { threadId: 'one' },
    });
    reader.close();
    sender.close();
  });

  it('keeps active turn reconciliation running across an app-server restart', async () => {
    const api = createApi();
    let historyReads = 0;
    vi.mocked(api.getMessages).mockImplementation(async () => {
      historyReads += 1;
      return historyReads === 1
        ? [{ role: 'assistant', text: 'Earlier answer' }]
        : [
            { role: 'user', text: 'Question' },
            { role: 'assistant', text: 'Final answer' },
          ];
    });
    server = new BrowserExtensionChatServer(api, token, '1.0.0');
    await server.start();
    const original = await connect(server.getCapability().localAppServerUrl);
    await request(original, 'init', 'initialize');
    original.send(JSON.stringify({ method: 'initialized' }));
    await request(original, 'turn', 'turn/start', {
      input: [{ text: 'Question', type: 'text' }],
      threadId: 'one',
    });

    await server.restart();
    const reconnected = await connect(server.getCapability().localAppServerUrl);
    await request(reconnected, 'reinit', 'initialize');
    reconnected.send(JSON.stringify({ method: 'initialized' }));
    const completion = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Timed out waiting for completion.')),
        3_000,
      );
      const onMessage = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.method !== 'turn/completed') return;
        clearTimeout(timeout);
        reconnected.off('message', onMessage);
        resolve(message);
      };
      reconnected.on('message', onMessage);
    });
    await request(reconnected, 'read', 'thread/read', { includeTurns: true, threadId: 'one' });

    await expect(completion).resolves.toMatchObject({
      method: 'turn/completed',
      params: { threadId: 'one' },
    });
    reconnected.close();
  });

  it('keeps polling briefly when final history lags behind terminal status', async () => {
    const api = createApi();
    let historyReads = 0;
    vi.mocked(api.getMessages).mockImplementation(async () => {
      historyReads += 1;
      return historyReads < 6
        ? [
            { role: 'user', text: 'Question' },
            ...(historyReads > 1
              ? [{ role: 'assistant', text: '', thinking: 'Still working.' }]
              : []),
          ]
        : [
            { role: 'user', text: 'Question' },
            { role: 'assistant', text: 'Delayed answer' },
          ];
    });
    server = new BrowserExtensionChatServer(api, token, '1.0.0');
    await server.start();
    const socket = await connect(server.getCapability().localAppServerUrl);

    await request(socket, '1', 'initialize');
    socket.send(JSON.stringify({ method: 'initialized' }));
    const finalHistory = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Timed out waiting for final history.')),
        5_000,
      );
      const onMessage = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as {
          method?: string;
          params?: { thread?: { turns?: Array<{ items?: Array<{ text?: string }> }> } };
        };
        const hasAnswer = message.params?.thread?.turns?.some(turn =>
          turn.items?.some(item => item.text === 'Delayed answer'),
        );
        if (message.method !== 'thread/updated' || !hasAnswer) return;
        clearTimeout(timeout);
        socket.off('message', onMessage);
        resolve(message as Record<string, unknown>);
      };
      socket.on('message', onMessage);
    });

    await request(socket, '2', 'turn/start', {
      input: [{ text: 'Question', type: 'text' }],
      threadId: 'one',
    });

    await expect(finalHistory).resolves.toMatchObject({ method: 'thread/updated' });
    expect(historyReads).toBeGreaterThanOrEqual(6);
    socket.close();
  });

  it('forwards the real run error in the completion notification', async () => {
    const api = createApi();
    vi.mocked(api.listSessions).mockReturnValue([
      {
        createdAt: 1_000,
        cwd: 'C:\\workspace',
        id: 'one',
        permissionMode: 'full',
        status: 'error',
        title: 'One',
        updatedAt: 2_000,
      },
    ]);
    vi.mocked(api.consumeTurnError).mockReturnValue('Provider quota exceeded.');
    server = new BrowserExtensionChatServer(api, token, '1.0.0');
    await server.start();
    const socket = await connect(server.getCapability().localAppServerUrl);
    await request(socket, '1', 'initialize');
    socket.send(JSON.stringify({ method: 'initialized' }));
    const completion = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Timed out waiting for completion.')),
        3_000,
      );
      const onMessage = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.method !== 'turn/completed') return;
        clearTimeout(timeout);
        socket.off('message', onMessage);
        resolve(message);
      };
      socket.on('message', onMessage);
    });

    await request(socket, '2', 'turn/start', {
      input: [{ text: 'Question', type: 'text' }],
      threadId: 'one',
    });

    await expect(completion).resolves.toMatchObject({
      params: {
        turn: {
          error: { message: 'Provider quota exceeded.' },
          status: 'failed',
        },
      },
    });
    expect(api.consumeTurnError).toHaveBeenCalledWith('one', 'run-1');
    socket.close();
  });

  it('does not use an old assistant reply to complete a newly interrupted pending input', async () => {
    const api = createApi();
    vi.mocked(api.listSessions).mockReturnValue([
      {
        createdAt: 1_000,
        cwd: 'C:\\workspace',
        id: 'one',
        permissionMode: 'full',
        status: 'error',
        title: 'One',
        updatedAt: 2_000,
      },
    ]);
    const old = [
      { role: 'user', text: 'Old question' },
      { role: 'assistant', text: 'Old reply' },
    ];
    vi.mocked(api.getMessages)
      .mockResolvedValueOnce(old)
      .mockResolvedValue([
        ...old,
        { role: 'user', text: 'New question', pendingInput: { id: 'p', state: 'interrupted' } },
      ]);
    server = new BrowserExtensionChatServer(api, token, '1.0.0');
    await server.start();
    const socket = await connect(server.getCapability().localAppServerUrl);
    await request(socket, '1', 'initialize');
    socket.send(JSON.stringify({ method: 'initialized' }));
    const completion = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Timed out waiting for completion.')),
        10_000,
      );
      const onMessage = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.method !== 'turn/completed') return;
        clearTimeout(timeout);
        socket.off('message', onMessage);
        resolve(message);
      };
      socket.on('message', onMessage);
    });

    await request(socket, '2', 'turn/start', {
      input: [{ text: 'Question', type: 'text' }],
      threadId: 'one',
    });

    await expect(completion).resolves.toMatchObject({
      params: {
        turn: {
          error: { message: 'The agent run failed before producing a reply.' },
          status: 'failed',
        },
      },
    });
    expect(api.consumeTurnError).toHaveBeenCalledWith('one', 'run-1');
    socket.close();
  }, 12_000);

  it('does not fail a turn while Gateway still reports the runtime as active', async () => {
    const api = createApi();
    let runtimeReads = 0;
    vi.mocked(api.listSessions).mockReturnValue([
      {
        createdAt: 1_000,
        cwd: 'C:\\workspace',
        id: 'one',
        permissionMode: 'full',
        status: 'error',
        title: 'One',
        updatedAt: 2_000,
      },
    ]);
    vi.mocked(api.getThreadRuntimeStatus).mockImplementation(async () => {
      runtimeReads += 1;
      return { known: true, running: runtimeReads < 4 };
    });
    vi.mocked(api.getMessages).mockImplementation(async () =>
      runtimeReads < 4
        ? [{ role: 'user', text: 'Question' }]
        : [
            { role: 'user', text: 'Question' },
            { role: 'assistant', text: 'Recovered answer' },
          ],
    );
    server = new BrowserExtensionChatServer(api, token, '1.0.0');
    await server.start();
    const socket = await connect(server.getCapability().localAppServerUrl);
    await request(socket, '1', 'initialize');
    socket.send(JSON.stringify({ method: 'initialized' }));
    const completion = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Timed out waiting for completion.')),
        5_000,
      );
      const onMessage = (data: WebSocket.RawData) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.method !== 'turn/completed') return;
        clearTimeout(timeout);
        socket.off('message', onMessage);
        resolve(message);
      };
      socket.on('message', onMessage);
    });

    await request(socket, '2', 'turn/start', {
      input: [{ text: 'Question', type: 'text' }],
      threadId: 'one',
    });

    await expect(completion).resolves.toMatchObject({
      params: { turn: { error: null, status: 'completed' } },
    });
    expect(api.getThreadRuntimeStatus).toHaveBeenCalledWith('one', { forceRefresh: true });
    socket.close();
  });

  it('projects thinking and tool activity into thread items', async () => {
    const api = createApi();
    vi.mocked(api.getMessages).mockResolvedValue([
      { role: 'user', text: 'Inspect it' },
      { role: 'assistant', text: '', thinking: 'I should read the file.' },
      {
        role: 'tool_use',
        text: '{"path":"notes.txt"}',
        toolInput: { path: 'notes.txt' },
        toolName: 'read',
        toolUseId: 'tool-1',
      },
      {
        role: 'tool_result',
        text: 'hello',
        isError: false,
        toolName: 'read',
        toolUseId: 'tool-1',
      },
      { role: 'assistant', text: 'Done' },
    ]);
    server = new BrowserExtensionChatServer(api, token, '1.0.0');
    await server.start();
    const socket = await connect(server.getCapability().localAppServerUrl);
    await request(socket, '1', 'initialize');
    socket.send(JSON.stringify({ method: 'initialized' }));

    await expect(
      request(socket, '2', 'thread/read', { includeTurns: true, threadId: 'one' }),
    ).resolves.toMatchObject({
      result: {
        thread: {
          turns: [
            {
              items: [
                { type: 'userMessage' },
                { content: ['I should read the file.'], type: 'reasoning' },
                {
                  input: { path: 'notes.txt' },
                  output: 'hello',
                  status: 'completed',
                  toolName: 'read',
                  type: 'toolCall',
                },
                { text: 'Done', type: 'agentMessage' },
              ],
            },
          ],
        },
      },
    });
    socket.close();
  });

  it('keeps the last successful history while transient refreshes fail', async () => {
    const api = createApi();
    let reads = 0;
    vi.mocked(api.getMessages).mockImplementation(async () => {
      reads += 1;
      if (reads === 1) return [{ role: 'user', text: 'Question' }];
      if (reads < 4) throw new Error('Temporary history failure.');
      return [
        { role: 'user', text: 'Question' },
        { role: 'assistant', text: 'Recovered answer' },
      ];
    });
    server = new BrowserExtensionChatServer(api, token, '1.0.0');
    await server.start();
    const socket = await connect(server.getCapability().localAppServerUrl);
    await request(socket, '1', 'initialize');
    socket.send(JSON.stringify({ method: 'initialized' }));
    const updates: Array<Record<string, unknown>> = [];
    const recovered = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for recovery.')), 4_000);
      socket.on('message', data => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        if (message.method !== 'thread/updated') return;
        updates.push(message);
        if (JSON.stringify(message).includes('Recovered answer')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    await request(socket, '2', 'turn/start', {
      input: [{ text: 'Question', type: 'text' }],
      threadId: 'one',
    });
    await recovered;

    expect(updates).toHaveLength(1);
    expect(JSON.stringify(updates[0])).toContain('Recovered answer');
    socket.close();
  });

  it('uses delta reads during a running turn instead of rebuilding every poll', async () => {
    const api = createApi();
    vi.mocked(api.listSessions).mockReturnValue([
      {
        createdAt: 1_000,
        cwd: 'C:\\workspace',
        id: 'one',
        permissionMode: 'full',
        status: 'running',
        title: 'One',
        updatedAt: 2_000,
      },
    ]);
    vi.mocked(api.getThreadRuntimeStatus).mockResolvedValue({ known: true, running: true });
    server = new BrowserExtensionChatServer(api, token, '1.0.0');
    await server.start();
    const socket = await connect(server.getCapability().localAppServerUrl);
    await request(socket, '1', 'initialize');
    socket.send(JSON.stringify({ method: 'initialized' }));
    await request(socket, '2', 'turn/start', {
      input: [{ text: 'Question', type: 'text' }],
      threadId: 'one',
    });

    await new Promise(resolve => setTimeout(resolve, 1_200));

    const pollOptions = vi
      .mocked(api.getMessages)
      .mock.calls.slice(1)
      .map(([, options]) => options);
    expect(pollOptions.filter(options => options?.forceFullSnapshot === true)).toHaveLength(1);
    expect(pollOptions.some(options => options?.forceFullSnapshot === false)).toBe(true);
    socket.close();
  });

  it('does not send a turn when its baseline history cannot be established', async () => {
    const api = createApi();
    vi.mocked(api.getMessages).mockRejectedValue(new Error('History unavailable.'));
    server = new BrowserExtensionChatServer(api, token, '1.0.0');
    await server.start();
    const socket = await connect(server.getCapability().localAppServerUrl);
    await request(socket, '1', 'initialize');
    socket.send(JSON.stringify({ method: 'initialized' }));

    await expect(
      request(socket, '2', 'turn/start', {
        input: [{ text: 'Question', type: 'text' }],
        threadId: 'one',
      }),
    ).resolves.toMatchObject({ error: { message: 'History unavailable.' } });
    expect(api.sendMessage).not.toHaveBeenCalled();
    socket.close();
  });
});
