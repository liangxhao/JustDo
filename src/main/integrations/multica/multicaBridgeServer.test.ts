import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { StringDecoder } from 'string_decoder';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NormalizedAgentEvent } from '../../../shared/openclaw/agentEvent';
import {
  decodeMulticaBridgeLines,
  encodeMulticaBridgeMessage,
  MULTICA_BRIDGE_METADATA_FILE,
  MULTICA_BRIDGE_PROTOCOL_VERSION,
  MULTICA_MAX_REQUEST_BYTES,
  type MulticaBridgeMetadata,
  type MulticaBridgeResponse,
} from './multicaBridgeProtocol';
import { MulticaBridgeServer } from './multicaBridgeServer';
import { type MulticaCodexBackend, MulticaCodexSession } from './multicaCodexSession';
import type { MulticaCommandService } from './multicaCommandService';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('MulticaBridgeServer', () => {
  it('cancels execution on stdin EOF while the output consumer is paused', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-multica-bridge-'));
    temporaryDirectories.push(userDataPath);
    const thread = { id: 'thread', cwd: userDataPath, agentId: 'main' };
    let started!: () => void;
    const running = new Promise<void>(resolve => {
      started = resolve;
    });
    let signal: AbortSignal | undefined;
    const run: MulticaCodexBackend['run'] = async (_thread, _id, _text, onEvent, currentSignal) => {
      signal = currentSignal;
      const cancelled = new Promise<void>(resolve =>
        currentSignal.addEventListener('abort', () => resolve(), { once: true }),
      );
      onEvent({
        stream: 'assistant',
        data: { text: 'x'.repeat(2 * 1024 * 1024) },
      } as NormalizedAgentEvent);
      started();
      await cancelled;
      return '';
    };
    const server = new MulticaBridgeServer({
      userDataPath,
      commandService: {
        activeTaskCount: 1,
        connect: (_cwd: string, _env: Record<string, string>, send: (message: unknown) => void) =>
          new MulticaCodexSession(
            { models: () => [], start: async () => thread, resume: async () => thread, run },
            send,
          ),
      } as unknown as MulticaCommandService,
    });
    await server.start();
    const metadata = JSON.parse(
      fs.readFileSync(path.join(userDataPath, 'multica', MULTICA_BRIDGE_METADATA_FILE), 'utf8'),
    ) as MulticaBridgeMetadata;
    const socket = net.createConnection(metadata.endpoint);
    socket.pause();
    socket.on('error', () => {});
    socket.once('connect', () => {
      socket.write(
        encodeMulticaBridgeMessage({
          type: 'request',
          version: MULTICA_BRIDGE_PROTOCOL_VERSION,
          requestId: 'paused-stream',
          token: metadata.token,
          argv: ['app-server', '--listen', 'stdio://'],
          cwd: userDataPath,
          env: {},
        }),
      );
      socket.write(
        encodeMulticaBridgeMessage({
          type: 'stdin',
          data: [
            { id: 1, method: 'initialize' },
            { id: 2, method: 'thread/start', params: {} },
            {
              id: 3,
              method: 'turn/start',
              params: { threadId: thread.id, input: [{ type: 'text', text: 'Run' }] },
            },
          ]
            .map(message => `${JSON.stringify(message)}\n`)
            .join(''),
        }),
      );
    });
    try {
      await running;
      expect(signal?.aborted).toBe(false);
      socket.write(encodeMulticaBridgeMessage({ type: 'eof' }));
      await vi.waitFor(() => expect(signal?.aborted).toBe(true), { timeout: 1000 });
    } finally {
      socket.resume();
      await server.stop();
      socket.destroy();
    }
  });

  it('relays both native admission items for a large escaped input without cancelling the turn', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-multica-bridge-'));
    temporaryDirectories.push(userDataPath);
    const text = '"'.repeat(7 * 1024 * 1024) + '任务🌍';
    const thread = { id: 'thread', cwd: userDataPath, agentId: 'main' };
    const run = vi.fn<MulticaCodexBackend['run']>(async (_thread, _runId, input, onEvent) => {
      expect(input).toBe(text);
      onEvent({
        stream: 'lifecycle',
        data: { phase: 'start' },
      } as NormalizedAgentEvent);
      return 'Large input admitted';
    });
    const server = new MulticaBridgeServer({
      userDataPath,
      commandService: {
        activeTaskCount: 0,
        connect: (_cwd: string, _env: Record<string, string>, send: (message: unknown) => void) =>
          new MulticaCodexSession(
            { models: () => [], start: async () => thread, resume: async () => thread, run },
            send,
          ),
      } as unknown as MulticaCommandService,
    });
    await server.start();
    try {
      const metadata = JSON.parse(
        fs.readFileSync(path.join(userDataPath, 'multica', MULTICA_BRIDGE_METADATA_FILE), 'utf8'),
      ) as MulticaBridgeMetadata;
      type Output = {
        method?: string;
        params?: { item?: { type: string; content: Array<{ text: string }> } };
      };
      const output = await new Promise<Output[]>((resolve, reject) => {
        const socket = net.createConnection(metadata.endpoint);
        let bridgeBuffer = '';
        let codexBuffer = '';
        const received: Output[] = [];
        const decoder = new StringDecoder('utf8');
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error('Large turn did not complete.'));
        }, 15_000);
        socket.setEncoding('utf8');
        socket.once('error', reject);
        socket.once('connect', () => {
          socket.write(
            encodeMulticaBridgeMessage({
              type: 'request',
              version: MULTICA_BRIDGE_PROTOCOL_VERSION,
              requestId: 'large-stream',
              token: metadata.token,
              argv: ['app-server', '--listen', 'stdio://'],
              cwd: userDataPath,
              env: {},
            }),
          );
          const input = [
            { id: 1, method: 'initialize' },
            { id: 2, method: 'thread/start', params: {} },
            {
              id: 3,
              method: 'turn/start',
              params: { threadId: thread.id, input: [{ type: 'text', text }] },
            },
          ]
            .map(message => `${JSON.stringify(message)}\n`)
            .join('');
          for (let offset = 0; offset < input.length; offset += 4096)
            socket.write(
              encodeMulticaBridgeMessage({
                type: 'stdin',
                data: input.slice(offset, offset + 4096),
              }),
            );
        });
        socket.on('data', chunk => {
          try {
            bridgeBuffer += chunk;
            const lines = bridgeBuffer.split('\n');
            bridgeBuffer = lines.pop()!;
            for (const line of lines) {
              expect(Buffer.byteLength(line)).toBeLessThan(MULTICA_MAX_REQUEST_BYTES);
              const frame = JSON.parse(line) as MulticaBridgeResponse;
              expect(frame.type).toBe('stdout');
              if (frame.type !== 'stdout') throw new Error('Unexpected bridge output.');
              codexBuffer += decoder.write(Buffer.from(frame.data, 'base64'));
              const decoded = decodeMulticaBridgeLines(codexBuffer);
              codexBuffer = decoded.remainder;
              received.push(...(decoded.messages as Output[]));
            }
            if (received.some(message => message.method === 'turn/completed'))
              socket.end(encodeMulticaBridgeMessage({ type: 'eof' }));
          } catch (error) {
            socket.destroy();
            reject(error);
          }
        });
        socket.once('close', () => {
          clearTimeout(timer);
          resolve(received);
        });
      });
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0][4].aborted).toBe(false);
      const admissions = output.filter(message => message.params?.item?.type === 'userMessage');
      expect(admissions.map(message => message.method)).toEqual(['item/started', 'item/completed']);
      expect(admissions.map(message => message.params?.item?.content[0].text)).toEqual([
        text,
        text,
      ]);
      expect(output.at(-1)).toMatchObject({
        method: 'turn/completed',
        params: { turn: { status: 'completed' } },
      });
    } finally {
      await server.stop();
    }
  }, 20_000);

  it('closes unauthenticated connections after the handshake deadline', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-multica-bridge-'));
    temporaryDirectories.push(userDataPath);
    const server = new MulticaBridgeServer({
      userDataPath,
      commandService: { activeTaskCount: 0, execute: vi.fn() } as unknown as MulticaCommandService,
      handshakeTimeoutMs: 25,
    });
    await server.start();
    try {
      const metadata = JSON.parse(
        fs.readFileSync(path.join(userDataPath, 'multica', MULTICA_BRIDGE_METADATA_FILE), 'utf8'),
      ) as MulticaBridgeMetadata;
      const socket = net.createConnection(metadata.endpoint);
      socket.resume();
      await new Promise<void>((resolve, reject) => {
        socket.once('error', error => {
          if (!socket.destroyed) reject(error);
        });
        socket.once('close', () => resolve());
      });
      expect(socket.destroyed).toBe(true);
    } finally {
      await server.stop();
    }
  });

  it('decodes a request split inside a multibyte UTF-8 prompt', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-multica-bridge-'));
    temporaryDirectories.push(userDataPath);
    const execute = vi.fn().mockResolvedValue({ exitCode: 0 });
    const server = new MulticaBridgeServer({
      userDataPath,
      commandService: { activeTaskCount: 0, execute } as unknown as MulticaCommandService,
    });
    await server.start();
    try {
      const metadata = JSON.parse(
        fs.readFileSync(path.join(userDataPath, 'multica', MULTICA_BRIDGE_METADATA_FILE), 'utf8'),
      ) as MulticaBridgeMetadata;
      const frame = Buffer.from(
        encodeMulticaBridgeMessage({
          type: 'request',
          version: MULTICA_BRIDGE_PROTOCOL_VERSION,
          requestId: 'request-split-utf8',
          token: metadata.token,
          argv: ['debug', 'models'],
          cwd: userDataPath,
          env: { MULTICA_TASK_ID: '任务一', NODE_OPTIONS: '--inspect' },
        }),
      );
      const splitAt = frame.indexOf(Buffer.from('任')) + 1;
      expect(splitAt).toBeGreaterThan(0);
      const socket = net.createConnection(metadata.endpoint);
      socket.resume();
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.once('connect', () => {
          socket.write(frame.subarray(0, splitAt));
          socket.write(frame.subarray(splitAt));
        });
        socket.once('close', () => resolve());
      });

      expect(execute).toHaveBeenCalledWith(
        ['debug', 'models'],
        userDataPath,
        { MULTICA_TASK_ID: '任务一' },
        expect.any(AbortSignal),
      );
    } finally {
      await server.stop();
    }
  });

  it('authenticates and relays one command over the local transport', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-multica-bridge-'));
    temporaryDirectories.push(userDataPath);
    const execute = vi.fn().mockResolvedValue({
      stdout: 'openclaw v2026.9.2\n',
      exitCode: 0,
    });
    const commandService = {
      activeTaskCount: 0,
      execute,
    } as unknown as MulticaCommandService;
    const server = new MulticaBridgeServer({ userDataPath, commandService });
    await server.start();

    try {
      const metadata = JSON.parse(
        fs.readFileSync(path.join(userDataPath, 'multica', MULTICA_BRIDGE_METADATA_FILE), 'utf8'),
      ) as MulticaBridgeMetadata;
      const responses = await new Promise<MulticaBridgeResponse[]>((resolve, reject) => {
        const socket = net.createConnection(metadata.endpoint);
        let buffer = '';
        const received: MulticaBridgeResponse[] = [];
        socket.once('error', reject);
        socket.once('connect', () => {
          socket.write(
            encodeMulticaBridgeMessage({
              type: 'request',
              version: MULTICA_BRIDGE_PROTOCOL_VERSION,
              requestId: 'request-1',
              token: metadata.token,
              argv: ['--version'],
              cwd: userDataPath,
              env: {},
            }),
          );
        });
        socket.on('data', chunk => {
          buffer += chunk.toString('utf8');
          const decoded = decodeMulticaBridgeLines(buffer);
          buffer = decoded.remainder;
          received.push(...(decoded.messages as MulticaBridgeResponse[]));
        });
        socket.once('close', () => resolve(received));
      });

      expect(execute).toHaveBeenCalledWith(
        ['--version'],
        userDataPath,
        {},
        expect.any(AbortSignal),
      );
      expect(responses).toEqual([
        { type: 'stdout', data: Buffer.from('openclaw v2026.9.2\n').toString('base64') },
        { type: 'exit', code: 0 },
      ]);
    } finally {
      await server.stop();
    }
  });

  it('rejects command arguments that bypass the compatibility allowlist', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-multica-bridge-'));
    temporaryDirectories.push(userDataPath);
    const execute = vi.fn();
    const commandService = {
      activeTaskCount: 0,
      execute,
    } as unknown as MulticaCommandService;
    const server = new MulticaBridgeServer({ userDataPath, commandService });
    await server.start();

    try {
      const metadata = JSON.parse(
        fs.readFileSync(path.join(userDataPath, 'multica', MULTICA_BRIDGE_METADATA_FILE), 'utf8'),
      ) as MulticaBridgeMetadata;
      const responses = await new Promise<MulticaBridgeResponse[]>((resolve, reject) => {
        const socket = net.createConnection(metadata.endpoint);
        let buffer = '';
        const received: MulticaBridgeResponse[] = [];
        socket.once('error', reject);
        socket.once('connect', () => {
          socket.write(
            encodeMulticaBridgeMessage({
              type: 'request',
              version: MULTICA_BRIDGE_PROTOCOL_VERSION,
              requestId: 'request-2',
              token: metadata.token,
              argv: ['agent', '--json', '--session-id', 'one', '--message', 'task', '--unknown'],
              cwd: userDataPath,
              env: {},
            }),
          );
        });
        socket.on('data', chunk => {
          buffer += chunk.toString('utf8');
          const decoded = decodeMulticaBridgeLines(buffer);
          buffer = decoded.remainder;
          received.push(...(decoded.messages as MulticaBridgeResponse[]));
        });
        socket.once('close', () => resolve(received));
      });

      expect(execute).not.toHaveBeenCalled();
      expect(responses).toEqual([{ type: 'error', message: 'Use the Codex runtime in Multica.' }]);
    } finally {
      await server.stop();
    }
  });

  it('rejects a same-character-length Unicode token without throwing', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-multica-bridge-'));
    temporaryDirectories.push(userDataPath);
    const execute = vi.fn();
    const server = new MulticaBridgeServer({
      userDataPath,
      commandService: { activeTaskCount: 0, execute } as unknown as MulticaCommandService,
    });
    await server.start();

    try {
      const metadata = JSON.parse(
        fs.readFileSync(path.join(userDataPath, 'multica', MULTICA_BRIDGE_METADATA_FILE), 'utf8'),
      ) as MulticaBridgeMetadata;
      const responses = await new Promise<MulticaBridgeResponse[]>((resolve, reject) => {
        const socket = net.createConnection(metadata.endpoint);
        let buffer = '';
        const received: MulticaBridgeResponse[] = [];
        socket.once('error', reject);
        socket.once('connect', () => {
          socket.write(
            encodeMulticaBridgeMessage({
              type: 'request',
              version: MULTICA_BRIDGE_PROTOCOL_VERSION,
              requestId: 'request-unicode-token',
              token: 'é'.repeat(metadata.token.length),
              argv: ['--version'],
              cwd: userDataPath,
              env: {},
            }),
          );
        });
        socket.on('data', chunk => {
          buffer += chunk.toString('utf8');
          const decoded = decodeMulticaBridgeLines(buffer);
          buffer = decoded.remainder;
          received.push(...(decoded.messages as MulticaBridgeResponse[]));
        });
        socket.once('close', () => resolve(received));
      });

      expect(execute).not.toHaveBeenCalled();
      expect(responses[0]).toMatchObject({ type: 'error' });
    } finally {
      await server.stop();
    }
  });

  it('aborts active commands before waiting for the transport to close', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-multica-bridge-'));
    temporaryDirectories.push(userDataPath);
    let receivedSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    const execute = vi.fn(
      (_argv: string[], _cwd: string, _env: Record<string, string>, signal: AbortSignal) =>
        new Promise<{ stderr: string; exitCode: number }>(resolve => {
          receivedSignal = signal;
          markStarted?.();
          signal.addEventListener(
            'abort',
            () => resolve({ stderr: 'cancelled\n', exitCode: 130 }),
            { once: true },
          );
        }),
    );
    const server = new MulticaBridgeServer({
      userDataPath,
      commandService: { activeTaskCount: 1, execute } as unknown as MulticaCommandService,
    });
    await server.start();
    const metadata = JSON.parse(
      fs.readFileSync(path.join(userDataPath, 'multica', MULTICA_BRIDGE_METADATA_FILE), 'utf8'),
    ) as MulticaBridgeMetadata;
    const socket = net.createConnection(metadata.endpoint);
    const closed = new Promise<void>(resolve => socket.once('close', resolve));
    socket.once('connect', () => {
      socket.write(
        encodeMulticaBridgeMessage({
          type: 'request',
          version: MULTICA_BRIDGE_PROTOCOL_VERSION,
          requestId: 'request-shutdown',
          token: metadata.token,
          argv: ['debug', 'models'],
          cwd: userDataPath,
          env: {},
        }),
      );
    });

    await started;
    await server.stop();
    await closed;

    expect(receivedSignal?.aborted).toBe(true);
    await expect(execute.mock.results[0].value).resolves.toEqual({
      stderr: 'cancelled\n',
      exitCode: 130,
    });
    expect(socket.destroyed).toBe(true);
  });

  it('waits for a streaming session to settle after aborting it on shutdown', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-multica-bridge-'));
    temporaryDirectories.push(userDataPath);
    let connected!: () => void;
    const ready = new Promise<void>(resolve => {
      connected = resolve;
    });
    let finishDrain!: () => void;
    const drain = new Promise<void>(resolve => {
      finishDrain = resolve;
    });
    const close = vi.fn(() => drain);
    const server = new MulticaBridgeServer({
      userDataPath,
      commandService: {
        activeTaskCount: 1,
        connect: () => {
          connected();
          return { receive: vi.fn(), close };
        },
      } as unknown as MulticaCommandService,
    });
    await server.start();
    const metadata = JSON.parse(
      fs.readFileSync(path.join(userDataPath, 'multica', MULTICA_BRIDGE_METADATA_FILE), 'utf8'),
    ) as MulticaBridgeMetadata;
    const socket = net.createConnection(metadata.endpoint);
    socket.resume();
    const closed = new Promise<void>(resolve => socket.once('close', resolve));
    socket.once('connect', () =>
      socket.write(
        encodeMulticaBridgeMessage({
          type: 'request',
          version: MULTICA_BRIDGE_PROTOCOL_VERSION,
          requestId: 'streaming-shutdown',
          token: metadata.token,
          argv: ['app-server', '--listen', 'stdio://'],
          cwd: userDataPath,
          env: {},
        }),
      ),
    );
    await ready;
    let stopped = false;
    const stopping = server.stop().then(() => {
      stopped = true;
    });
    try {
      await closed;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(close).toHaveBeenCalledTimes(1);
      expect(stopped).toBe(false);
    } finally {
      finishDrain();
      await stopping;
    }
    expect(stopped).toBe(true);
  });
});
