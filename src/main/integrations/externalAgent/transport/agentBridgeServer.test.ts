import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { StringDecoder } from 'string_decoder';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AGENT_CLI_BRIDGE_DIRECTORY,
  AgentCliExitCode,
  agentCliInvalidArgumentsMessage,
  usesAgentCliMachineOutput,
} from '../../../../shared/integrations/agentCli';
import type { NormalizedAgentEvent } from '../../../../shared/openclaw/agentEvent';
import { AgentCommandService } from '../agentCommandService';
import type { CodexAppServerBackend } from '../codexAppServerBackend';
import { CodexAppServerSession } from '../codexAppServerSession';
import type { ExternalAgentBackendFactory } from '../externalAgentBackend';
import {
  type ExternalAgentBackend,
  ExternalAgentCancelledError,
  ExternalAgentStreamError,
} from '../externalAgentTypes';
import {
  AGENT_BRIDGE_MAX_REQUEST_BYTES,
  AGENT_BRIDGE_METADATA_FILE,
  AGENT_BRIDGE_PROTOCOL_VERSION,
  type AgentBridgeMetadata,
  type AgentBridgeResponse,
  decodeAgentBridgeLines,
  encodeAgentBridgeMessage,
} from './agentBridgeProtocol';
import { type AgentBridgeCommandService, AgentBridgeServer } from './agentBridgeServer';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('AgentBridgeServer', () => {
  it('closes the real ACP transport and releases its connection slot when its owning service closes the session', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-shutdown-'));
    temporaryDirectories.push(userDataPath);
    const thread = { id: 'external-session', agentId: 'main', cwd: userDataPath };
    let nativeSignal: AbortSignal | undefined;
    let settleNative!: () => void;
    const nativeSettlement = new Promise<void>(resolve => {
      settleNative = resolve;
    });
    const backend: ExternalAgentBackend = {
      models: () => [{ id: 'provider/model', name: 'Model', isDefault: true }],
      start: async () => thread,
      resume: async () => thread,
      run: async (_thread, _id, _text, _event, signal) => {
        nativeSignal = signal;
        await nativeSettlement;
        throw new ExternalAgentCancelledError('Native cancellation confirmed.');
      },
    };
    const commandService = new AgentCommandService({
      backend: {
        activeTaskCount: 0,
        connect: () => backend,
      } as unknown as ExternalAgentBackendFactory,
      createResources: () => ({ prepare: async () => () => {}, close: async () => {} }),
      getStatus: () => ({
        supported: true,
        command: 'agent',
        launcherReady: true,
        bridgeRunning: true,
        activeTaskCount: 0,
        gatewayPhase: 'ready',
      }),
    });
    const server = new AgentBridgeServer({ userDataPath, commandService, maxConnections: 1 });
    await server.start();
    const metadata = JSON.parse(
      fs.readFileSync(path.join(userDataPath, AGENT_CLI_BRIDGE_DIRECTORY, 'bridge.json'), 'utf8'),
    ) as AgentBridgeMetadata;
    const socket = net.createConnection(metadata.endpoint);
    const frames: AgentBridgeResponse[] = [];
    const replies: Array<{ id?: number }> = [];
    let buffer = '';
    let stdout = '';
    socket.on('error', () => {});
    socket.on('data', chunk => {
      const decoded = decodeAgentBridgeLines(buffer + chunk.toString('utf8'));
      buffer = decoded.remainder;
      for (const frame of decoded.messages as AgentBridgeResponse[]) {
        frames.push(frame);
        if (frame.type !== 'stdout') continue;
        const messages = decodeAgentBridgeLines(
          stdout + Buffer.from(frame.data, 'base64').toString(),
        );
        stdout = messages.remainder;
        replies.push(...(messages.messages as Array<{ id?: number }>));
      }
    });
    const send = (id: number, method: string, params: unknown) =>
      socket.write(
        encodeAgentBridgeMessage({
          type: 'stdin',
          data: `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
        }),
      );
    try {
      await new Promise<void>(resolve => socket.once('connect', resolve));
      socket.write(
        encodeAgentBridgeMessage({
          type: 'request',
          version: AGENT_BRIDGE_PROTOCOL_VERSION,
          requestId: 'shutdown',
          token: metadata.token,
          argv: ['acp'],
          cwd: userDataPath,
          env: {},
        }),
      );
      send(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
      await vi.waitFor(() => expect(replies.some(reply => reply.id === 1)).toBe(true));
      send(2, 'session/new', { cwd: userDataPath, mcpServers: [] });
      await vi.waitFor(() => expect(replies.some(reply => reply.id === 2)).toBe(true));
      send(3, 'session/prompt', { sessionId: thread.id, prompt: [{ type: 'text', text: 'work' }] });
      await vi.waitFor(() => expect(nativeSignal).toBeDefined());
      commandService.stopExternal();
      await vi.waitFor(() => expect(socket.destroyed).toBe(true));
      expect(nativeSignal!.aborted).toBe(true);
      expect(frames).toContainEqual({ type: 'exit', code: AgentCliExitCode.BridgeError });
      const status = await commandFrames(metadata, ['status', '--json'], userDataPath);
      expect(status).toContainEqual({ type: 'exit', code: AgentCliExitCode.Success });
      let stopped = false;
      const stopping = server.stop().then(() => {
        stopped = true;
      });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(stopped).toBe(false);
      settleNative();
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      settleNative();
      socket.destroy();
      await server.stop();
    }
  });

  it('cancels execution on stdin EOF while the output consumer is paused', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'external-agent-bridge-'));
    temporaryDirectories.push(userDataPath);
    const thread = { id: 'thread', cwd: userDataPath, agentId: 'main' };
    let started!: () => void;
    const running = new Promise<void>(resolve => {
      started = resolve;
    });
    let signal: AbortSignal | undefined;
    const run: CodexAppServerBackend['run'] = async (
      _thread,
      _id,
      _text,
      onEvent,
      currentSignal,
    ) => {
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
    const server = new AgentBridgeServer({
      userDataPath,
      commandService: {
        activeTaskCount: 1,
        connect: (_cwd: string, _env: Record<string, string>, send: (message: unknown) => void) =>
          new CodexAppServerSession(
            { models: () => [], start: async () => thread, resume: async () => thread, run },
            send,
          ),
      } as unknown as AgentBridgeCommandService,
    });
    await server.start();
    const metadata = JSON.parse(
      fs.readFileSync(
        path.join(userDataPath, 'external-agent', AGENT_BRIDGE_METADATA_FILE),
        'utf8',
      ),
    ) as AgentBridgeMetadata;
    const socket = net.createConnection(metadata.endpoint);
    socket.pause();
    socket.on('error', () => {});
    socket.once('connect', () => {
      socket.write(
        encodeAgentBridgeMessage({
          type: 'request',
          version: AGENT_BRIDGE_PROTOCOL_VERSION,
          requestId: 'paused-stream',
          token: metadata.token,
          argv: ['app-server', '--listen', 'stdio://'],
          cwd: userDataPath,
          env: {},
        }),
      );
      socket.write(
        encodeAgentBridgeMessage({
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
      socket.write(encodeAgentBridgeMessage({ type: 'eof' }));
      await vi.waitFor(() => expect(signal?.aborted).toBe(true), { timeout: 1000 });
    } finally {
      socket.resume();
      await server.stop();
      socket.destroy();
    }
  });

  it('relays both native admission items for a large escaped input without cancelling the turn', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'external-agent-bridge-'));
    temporaryDirectories.push(userDataPath);
    const text = '"'.repeat(7 * 1024 * 1024) + '任务🌍';
    const thread = { id: 'thread', cwd: userDataPath, agentId: 'main' };
    const run = vi.fn<CodexAppServerBackend['run']>(async (_thread, _runId, input, onEvent) => {
      expect(input).toBe(text);
      onEvent({
        stream: 'lifecycle',
        data: { phase: 'start' },
      } as NormalizedAgentEvent);
      return 'Large input admitted';
    });
    const server = new AgentBridgeServer({
      userDataPath,
      commandService: {
        activeTaskCount: 0,
        connect: (_cwd: string, _env: Record<string, string>, send: (message: unknown) => void) =>
          new CodexAppServerSession(
            { models: () => [], start: async () => thread, resume: async () => thread, run },
            send,
          ),
      } as unknown as AgentBridgeCommandService,
    });
    await server.start();
    try {
      const metadata = JSON.parse(
        fs.readFileSync(
          path.join(userDataPath, 'external-agent', AGENT_BRIDGE_METADATA_FILE),
          'utf8',
        ),
      ) as AgentBridgeMetadata;
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
            encodeAgentBridgeMessage({
              type: 'request',
              version: AGENT_BRIDGE_PROTOCOL_VERSION,
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
              encodeAgentBridgeMessage({
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
              expect(Buffer.byteLength(line)).toBeLessThan(AGENT_BRIDGE_MAX_REQUEST_BYTES);
              const frame = JSON.parse(line) as AgentBridgeResponse;
              expect(frame.type).toBe('stdout');
              if (frame.type !== 'stdout') throw new Error('Unexpected bridge output.');
              codexBuffer += decoder.write(Buffer.from(frame.data, 'base64'));
              const decoded = decodeAgentBridgeLines(codexBuffer);
              codexBuffer = decoded.remainder;
              received.push(...(decoded.messages as Output[]));
            }
            if (received.some(message => message.method === 'turn/completed'))
              socket.end(encodeAgentBridgeMessage({ type: 'eof' }));
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
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'external-agent-bridge-'));
    temporaryDirectories.push(userDataPath);
    const server = new AgentBridgeServer({
      userDataPath,
      commandService: {
        activeTaskCount: 0,
        execute: vi.fn(),
      } as unknown as AgentBridgeCommandService,
      handshakeTimeoutMs: 25,
    });
    await server.start();
    try {
      const metadata = JSON.parse(
        fs.readFileSync(
          path.join(userDataPath, 'external-agent', AGENT_BRIDGE_METADATA_FILE),
          'utf8',
        ),
      ) as AgentBridgeMetadata;
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
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'external-agent-bridge-'));
    temporaryDirectories.push(userDataPath);
    const execute = vi.fn().mockResolvedValue({ exitCode: 0 });
    const server = new AgentBridgeServer({
      userDataPath,
      commandService: { activeTaskCount: 0, execute } as unknown as AgentBridgeCommandService,
    });
    await server.start();
    try {
      const metadata = JSON.parse(
        fs.readFileSync(
          path.join(userDataPath, 'external-agent', AGENT_BRIDGE_METADATA_FILE),
          'utf8',
        ),
      ) as AgentBridgeMetadata;
      const frame = Buffer.from(
        encodeAgentBridgeMessage({
          type: 'request',
          version: AGENT_BRIDGE_PROTOCOL_VERSION,
          requestId: 'request-split-utf8',
          token: metadata.token,
          argv: ['debug', 'models'],
          cwd: userDataPath,
          env: { CUSTOM_ACCESS_TOKEN: '任务一', NODE_OPTIONS: '--inspect' },
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
        {},
        expect.any(AbortSignal),
        expect.any(Function),
      );
    } finally {
      await server.stop();
    }
  });

  it('authenticates and relays one command over the local transport', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'external-agent-bridge-'));
    temporaryDirectories.push(userDataPath);
    const execute = vi.fn().mockResolvedValue({
      stdout: 'openclaw v2026.9.2\n',
      exitCode: 0,
    });
    const commandService = {
      activeTaskCount: 0,
      execute,
    } as unknown as AgentBridgeCommandService;
    const server = new AgentBridgeServer({ userDataPath, commandService });
    await server.start();

    try {
      const metadata = JSON.parse(
        fs.readFileSync(
          path.join(userDataPath, 'external-agent', AGENT_BRIDGE_METADATA_FILE),
          'utf8',
        ),
      ) as AgentBridgeMetadata;
      const responses = await new Promise<AgentBridgeResponse[]>((resolve, reject) => {
        const socket = net.createConnection(metadata.endpoint);
        let buffer = '';
        const received: AgentBridgeResponse[] = [];
        socket.once('error', reject);
        socket.once('connect', () => {
          socket.write(
            encodeAgentBridgeMessage({
              type: 'request',
              version: AGENT_BRIDGE_PROTOCOL_VERSION,
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
          const decoded = decodeAgentBridgeLines(buffer);
          buffer = decoded.remainder;
          received.push(...(decoded.messages as AgentBridgeResponse[]));
        });
        socket.once('close', () => resolve(received));
      });

      expect(execute).toHaveBeenCalledWith(
        ['--version'],
        userDataPath,
        {},
        expect.any(AbortSignal),
        expect.any(Function),
      );
      expect(responses).toEqual([
        { type: 'stdout', data: Buffer.from('openclaw v2026.9.2\n').toString('base64') },
        { type: 'exit', code: 0 },
      ]);
    } finally {
      await server.stop();
    }
  });

  it.each([
    ['agent', '--json', '--session-id', 'one', '--message', 'task', '--unknown'],
    ['exec', '--json', '--bad', 'x'],
    ['exec', '--stream-json', '--bad', 'x'],
    ['exec', '--bad', 'x'],
    ['debug', 'models', '--unknown'],
    ['app-server', '--listen', 'ws://127.0.0.1'],
  ])('rejects unsupported arguments before execution: %j', async (...argv) => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'external-agent-bridge-'));
    temporaryDirectories.push(userDataPath);
    const execute = vi.fn();
    const commandService = {
      activeTaskCount: 0,
      execute,
    } as unknown as AgentBridgeCommandService;
    const server = new AgentBridgeServer({ userDataPath, commandService });
    await server.start();

    try {
      const metadata = JSON.parse(
        fs.readFileSync(
          path.join(userDataPath, 'external-agent', AGENT_BRIDGE_METADATA_FILE),
          'utf8',
        ),
      ) as AgentBridgeMetadata;
      const responses = await new Promise<AgentBridgeResponse[]>((resolve, reject) => {
        const socket = net.createConnection(metadata.endpoint);
        let buffer = '';
        const received: AgentBridgeResponse[] = [];
        socket.once('error', reject);
        socket.once('connect', () => {
          socket.write(
            encodeAgentBridgeMessage({
              type: 'request',
              version: AGENT_BRIDGE_PROTOCOL_VERSION,
              requestId: 'request-2',
              token: metadata.token,
              argv,
              cwd: userDataPath,
              env: {},
            }),
          );
        });
        socket.on('data', chunk => {
          buffer += chunk.toString('utf8');
          const decoded = decodeAgentBridgeLines(buffer);
          buffer = decoded.remainder;
          received.push(...(decoded.messages as AgentBridgeResponse[]));
        });
        socket.once('close', () => resolve(received));
      });

      expect(execute).not.toHaveBeenCalled();
      const machine = usesAgentCliMachineOutput(argv);
      const message = agentCliInvalidArgumentsMessage(
        Intl.DateTimeFormat().resolvedOptions().locale.startsWith('zh') ? 'zh' : 'en',
      );
      expect(responses).toEqual([
        {
          type: machine ? 'stdout' : 'stderr',
          data: Buffer.from(
            `${machine ? JSON.stringify({ type: 'error', error: { code: 'INVALID_ARGUMENTS', message } }) : message}\n`,
          ).toString('base64'),
        },
        { type: 'exit', code: 64 },
      ]);
    } finally {
      await server.stop();
    }
  });

  it('rejects a same-character-length Unicode token without throwing', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'external-agent-bridge-'));
    temporaryDirectories.push(userDataPath);
    const execute = vi.fn();
    const server = new AgentBridgeServer({
      userDataPath,
      commandService: { activeTaskCount: 0, execute } as unknown as AgentBridgeCommandService,
    });
    await server.start();

    try {
      const metadata = JSON.parse(
        fs.readFileSync(
          path.join(userDataPath, 'external-agent', AGENT_BRIDGE_METADATA_FILE),
          'utf8',
        ),
      ) as AgentBridgeMetadata;
      const responses = await new Promise<AgentBridgeResponse[]>((resolve, reject) => {
        const socket = net.createConnection(metadata.endpoint);
        let buffer = '';
        const received: AgentBridgeResponse[] = [];
        socket.once('error', reject);
        socket.once('connect', () => {
          socket.write(
            encodeAgentBridgeMessage({
              type: 'request',
              version: AGENT_BRIDGE_PROTOCOL_VERSION,
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
          const decoded = decodeAgentBridgeLines(buffer);
          buffer = decoded.remainder;
          received.push(...(decoded.messages as AgentBridgeResponse[]));
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
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'external-agent-bridge-'));
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
    const server = new AgentBridgeServer({
      userDataPath,
      commandService: { activeTaskCount: 1, execute } as unknown as AgentBridgeCommandService,
    });
    await server.start();
    const metadata = JSON.parse(
      fs.readFileSync(
        path.join(userDataPath, 'external-agent', AGENT_BRIDGE_METADATA_FILE),
        'utf8',
      ),
    ) as AgentBridgeMetadata;
    const socket = net.createConnection(metadata.endpoint);
    const closed = new Promise<void>(resolve => socket.once('close', resolve));
    socket.once('connect', () => {
      socket.write(
        encodeAgentBridgeMessage({
          type: 'request',
          version: AGENT_BRIDGE_PROTOCOL_VERSION,
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
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'external-agent-bridge-'));
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
    const server = new AgentBridgeServer({
      userDataPath,
      commandService: {
        activeTaskCount: 1,
        connect: () => {
          connected();
          return { receive: vi.fn(), close };
        },
      } as unknown as AgentBridgeCommandService,
    });
    await server.start();
    const metadata = JSON.parse(
      fs.readFileSync(
        path.join(userDataPath, 'external-agent', AGENT_BRIDGE_METADATA_FILE),
        'utf8',
      ),
    ) as AgentBridgeMetadata;
    const socket = net.createConnection(metadata.endpoint);
    socket.resume();
    const closed = new Promise<void>(resolve => socket.once('close', resolve));
    socket.once('connect', () =>
      socket.write(
        encodeAgentBridgeMessage({
          type: 'request',
          version: AGENT_BRIDGE_PROTOCOL_VERSION,
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

  it('publishes one generic discovery file and removes it on shutdown', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-discovery-'));
    temporaryDirectories.push(userDataPath);
    const server = new AgentBridgeServer({
      userDataPath,
      commandService: { activeTaskCount: 0, execute: vi.fn(), connect: vi.fn() },
    });
    await server.start();
    const target = path.join(userDataPath, AGENT_CLI_BRIDGE_DIRECTORY, 'bridge.json');
    try {
      expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toMatchObject({
        version: AGENT_BRIDGE_PROTOCOL_VERSION,
        pid: process.pid,
      });
      expect(fs.readdirSync(userDataPath)).toEqual([AGENT_CLI_BRIDGE_DIRECTORY]);
    } finally {
      await server.stop();
    }
    expect(fs.existsSync(target)).toBe(false);
  });

  it('cleans incomplete discovery when publication fails', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-discovery-'));
    temporaryDirectories.push(userDataPath);
    const server = new AgentBridgeServer({
      userDataPath,
      commandService: { activeTaskCount: 0, execute: vi.fn(), connect: vi.fn() },
    });
    const failure = vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw new Error('Discovery write failed.');
    });
    try {
      await expect(server.start()).rejects.toThrow('Discovery write failed.');
      expect(fs.readdirSync(path.join(userDataPath, AGENT_CLI_BRIDGE_DIRECTORY))).toEqual([]);
      expect(server.running).toBe(false);
    } finally {
      failure.mockRestore();
      await server.stop();
    }
  });

  it.each([undefined, 'client marker directory'])(
    'allows an app-server client with optional CODEX_HOME=%s and strips other context',
    async home => {
      const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-codex-context-'));
      temporaryDirectories.push(userDataPath);
      const connect = vi.fn<AgentBridgeCommandService['connect']>(() => ({
        receive: async () => {},
        close: async () => {},
      }));
      const server = new AgentBridgeServer({
        userDataPath,
        commandService: { activeTaskCount: 0, execute: vi.fn(), connect },
      });
      await server.start();
      try {
        const metadata = JSON.parse(
          fs.readFileSync(
            path.join(userDataPath, AGENT_CLI_BRIDGE_DIRECTORY, 'bridge.json'),
            'utf8',
          ),
        ) as AgentBridgeMetadata;
        await new Promise<void>((resolve, reject) => {
          const socket = net.createConnection(metadata.endpoint);
          socket.resume();
          socket.once('error', reject);
          socket.once('close', () => resolve());
          socket.once('connect', () => {
            socket.write(
              encodeAgentBridgeMessage({
                type: 'request',
                version: AGENT_BRIDGE_PROTOCOL_VERSION,
                requestId: 'codex-context',
                token: metadata.token,
                argv: ['app-server', '--listen', 'stdio://'],
                cwd: userDataPath,
                env: {
                  ...(home ? { CODEX_HOME: home } : {}),
                  MULTICA_TOKEN: 'must-not-forward',
                  CUSTOM_ACCESS_TOKEN: 'must-not-forward',
                },
              }),
            );
            socket.write(encodeAgentBridgeMessage({ type: 'eof' }));
          });
        });
        expect(connect).toHaveBeenCalledWith(
          userDataPath,
          home ? { CODEX_HOME: home } : {},
          expect.any(Function),
          ['app-server', '--listen', 'stdio://'],
        );
      } finally {
        await server.stop();
      }
    },
  );

  it('streams generic command output in order and discards all inherited task environment', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-command-'));
    temporaryDirectories.push(userDataPath);
    const execute = vi.fn<AgentBridgeCommandService['execute']>(
      async (_argv, _cwd, _env, _signal, emit) => {
        emit?.('stdout', 'event 中文🌟\n');
        return { stdout: 'final result\n', exitCode: 0 };
      },
    );
    const server = new AgentBridgeServer({
      userDataPath,
      commandService: { activeTaskCount: 0, execute, connect: vi.fn() },
    });
    await server.start();
    const argv = ['exec', '--stream-json', '--prompt', 'Inspect\nthen summarize'];
    try {
      const metadata = JSON.parse(
        fs.readFileSync(path.join(userDataPath, AGENT_CLI_BRIDGE_DIRECTORY, 'bridge.json'), 'utf8'),
      ) as AgentBridgeMetadata;
      const frames = await commandFrames(metadata, argv, userDataPath, {
        MULTICA_TOKEN: 'do-not-forward',
        CUSTOM_ACCESS_TOKEN: 'do-not-forward',
      });
      expect(execute).toHaveBeenCalledWith(
        argv,
        userDataPath,
        {},
        expect.any(AbortSignal),
        expect.any(Function),
      );
      const output = frames
        .flatMap(frame =>
          frame.type === 'stdout' ? [Buffer.from(frame.data, 'base64').toString('utf8')] : [],
        )
        .join('');
      expect(output).toBe('event 中文🌟\nfinal result\n');
      expect(frames.at(-1)).toEqual({ type: 'exit', code: 0 });
    } finally {
      await server.stop();
    }
  });

  it('delivers ACP permission replies and cancel while a prompt and output drain remain pending', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-acp-'));
    temporaryDirectories.push(userDataPath);
    let finishPrompt!: () => void;
    const pending = new Promise<void>(resolve => {
      finishPrompt = resolve;
    });
    const received: unknown[] = [];
    const connect = vi.fn<AgentBridgeCommandService['connect']>((_cwd, _env, send) => ({
      receive: async raw => {
        received.push(raw);
        if ((raw as { method?: string }).method === 'session/prompt') {
          send({
            jsonrpc: '2.0',
            method: 'session/update',
            params: { text: 'x'.repeat(2 * 1024 * 1024) },
          });
          await pending;
        }
      },
      close: async () => {
        finishPrompt();
      },
    }));
    const server = new AgentBridgeServer({
      userDataPath,
      commandService: { activeTaskCount: 1, execute: vi.fn(), connect },
    });
    await server.start();
    const metadata = JSON.parse(
      fs.readFileSync(path.join(userDataPath, AGENT_CLI_BRIDGE_DIRECTORY, 'bridge.json'), 'utf8'),
    ) as AgentBridgeMetadata;
    const socket = net.createConnection(metadata.endpoint);
    socket.pause();
    socket.on('error', () => {});
    try {
      await new Promise<void>(resolve => socket.once('connect', resolve));
      socket.write(
        encodeAgentBridgeMessage({
          type: 'request',
          version: 4,
          requestId: 'acp',
          token: metadata.token,
          argv: ['acp'],
          cwd: userDataPath,
          env: { MULTICA_TOKEN: 'do-not-forward' },
        }),
      );
      socket.write(
        encodeAgentBridgeMessage({
          type: 'stdin',
          data: `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { sessionId: 'session-1' } })}\n`,
        }),
      );
      await vi.waitFor(() => expect(received).toHaveLength(1));
      const permissionReply = {
        jsonrpc: '2.0',
        id: 'permission-1',
        result: { outcome: { outcome: 'selected', optionId: 'allow-once' } },
      };
      const cancel = {
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId: 'session-1' },
      };
      socket.write(
        encodeAgentBridgeMessage({
          type: 'stdin',
          data: `${JSON.stringify(permissionReply)}\n${JSON.stringify(cancel)}\n`,
        }),
      );
      await vi.waitFor(() => expect(received).toContainEqual(cancel), { timeout: 1000 });
      expect(received).toContainEqual(permissionReply);
      expect(connect).toHaveBeenCalledWith(userDataPath, {}, expect.any(Function), ['acp']);
    } finally {
      finishPrompt();
      socket.resume();
      socket.destroy();
      await server.stop();
    }
  });

  it.each(['overflow', 'invalid-input'] as const)(
    'distinguishes ACP %s from human cancellation',
    async failure => {
      const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-stream-error-'));
      temporaryDirectories.push(userDataPath);
      const close = vi.fn(async (_reason?: Error) => {});
      let writeError: unknown;
      const connect: AgentBridgeCommandService['connect'] = (_cwd, _env, send) => ({
        receive: async () => {
          try {
            send({
              jsonrpc: '2.0',
              method: 'session/update',
              params: { text: 'x'.repeat(2 * 1024 * 1024) },
            });
          } catch (error) {
            writeError = error;
          }
        },
        close,
      });
      const server = new AgentBridgeServer({
        userDataPath,
        maxPendingOutputBytes: 128 * 1024,
        commandService: { activeTaskCount: 1, execute: vi.fn(), connect },
      });
      await server.start();
      const metadata = JSON.parse(
        fs.readFileSync(path.join(userDataPath, AGENT_CLI_BRIDGE_DIRECTORY, 'bridge.json'), 'utf8'),
      ) as AgentBridgeMetadata;
      const socket = net.createConnection(metadata.endpoint);
      socket.pause();
      socket.on('error', () => {});
      try {
        await new Promise<void>(resolve => socket.once('connect', resolve));
        socket.write(
          encodeAgentBridgeMessage({
            type: 'request',
            version: 4,
            requestId: 'stream-error',
            token: metadata.token,
            argv: ['acp'],
            cwd: userDataPath,
            env: {},
          }),
        );
        socket.write(
          encodeAgentBridgeMessage({
            type: 'stdin',
            data:
              failure === 'overflow'
                ? `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/prompt' })}\n`
                : 'invalid protocol JSON\n',
          }),
        );
        await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
        expect(close.mock.calls[0][0]).toBeInstanceOf(ExternalAgentStreamError);
        if (failure === 'overflow') expect(writeError).toBe(close.mock.calls[0][0]);
      } finally {
        socket.resume();
        socket.destroy();
        await server.stop();
      }
    },
  );

  it('aborts a generic exec overflow with the stream failure reason', async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-stream-error-'));
    temporaryDirectories.push(userDataPath);
    let reason: unknown;
    const execute: AgentBridgeCommandService['execute'] = async (
      _argv,
      _cwd,
      _env,
      signal,
      emit,
    ) => {
      try {
        emit?.('stdout', 'x'.repeat(2 * 1024 * 1024));
      } finally {
        reason = signal.reason;
      }
      return { exitCode: 0 };
    };
    const server = new AgentBridgeServer({
      userDataPath,
      maxPendingOutputBytes: 128 * 1024,
      commandService: { activeTaskCount: 1, execute, connect: vi.fn() },
    });
    await server.start();
    const metadata = JSON.parse(
      fs.readFileSync(path.join(userDataPath, AGENT_CLI_BRIDGE_DIRECTORY, 'bridge.json'), 'utf8'),
    ) as AgentBridgeMetadata;
    const socket = net.createConnection(metadata.endpoint);
    socket.pause();
    socket.on('error', () => {});
    try {
      await new Promise<void>(resolve => socket.once('connect', resolve));
      socket.write(
        encodeAgentBridgeMessage({
          type: 'request',
          version: 4,
          requestId: 'exec-stream-error',
          token: metadata.token,
          argv: ['exec', '--stream-json', 'prompt'],
          cwd: userDataPath,
          env: {},
        }),
      );
      await vi.waitFor(() => expect(reason).toBeInstanceOf(ExternalAgentStreamError));
    } finally {
      socket.resume();
      socket.destroy();
      await server.stop();
    }
  });
});

async function commandFrames(
  metadata: AgentBridgeMetadata,
  argv: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<AgentBridgeResponse[]> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(metadata.endpoint);
    let buffer = '';
    const responses: AgentBridgeResponse[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Bridge command timed out.'));
    }, 5000);
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.once('connect', () =>
      socket.write(
        encodeAgentBridgeMessage({
          type: 'request',
          version: 4,
          requestId: 'generic-command',
          token: metadata.token,
          argv,
          cwd,
          env,
        }),
      ),
    );
    socket.on('data', data => {
      buffer += data;
      const decoded = decodeAgentBridgeLines(buffer);
      buffer = decoded.remainder;
      responses.push(...(decoded.messages as AgentBridgeResponse[]));
    });
    socket.once('close', () => {
      clearTimeout(timer);
      resolve(responses);
    });
  });
}
