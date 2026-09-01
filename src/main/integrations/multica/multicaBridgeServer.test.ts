import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { PRODUCT_NAME } from '../../../shared/productMetadata';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import {
  decodeBridgeLines,
  encodeBridgeMessage,
  MULTICA_BRIDGE_METADATA_FILE,
  MULTICA_BRIDGE_PROTOCOL_VERSION,
  type MulticaBridgeMetadata,
  type MulticaBridgeRequest,
  type MulticaBridgeResponse,
} from './multicaBridgeProtocol';
import {
  classifyMulticaRunStatus,
  createMulticaWorkspaceConfig,
  MulticaBridgeServer,
  normalizeMulticaVersionProbeOutput,
} from './multicaBridgeServer';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

const createDirectory = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'JustDo Multica 中文 '));
  temporaryDirectories.push(directory);
  return directory;
};

const exchange = (
  endpoint: string,
  request: MulticaBridgeRequest,
): Promise<MulticaBridgeResponse[]> =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const responses: MulticaBridgeResponse[] = [];
    let buffer = '';
    socket.once('connect', () => socket.write(encodeBridgeMessage(request)));
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const decoded = decodeBridgeLines(buffer);
      buffer = decoded.remainder;
      responses.push(...(decoded.messages as MulticaBridgeResponse[]));
    });
    socket.once('error', reject);
    socket.once('close', () => resolve(responses));
  });

describe('MulticaBridgeServer', () => {
  test('normalizes version output without exposing the Electron Node version', () => {
    expect(
      normalizeMulticaVersionProbeOutput(
        '[openclaw-launcher] compile-cache dir=.compile-cache/v24.18.1-x64\nOpenClaw 2026.7.1-2\n',
      ),
    ).toBe(`${PRODUCT_NAME} 2026.7.1-2\n`);
    expect(normalizeMulticaVersionProbeOutput('v24.18.1')).toBeNull();
  });

  test('distinguishes completed, failed, timed-out, and cancelled external runs', () => {
    expect(
      classifyMulticaRunStatus({
        code: 0,
        signal: null,
        timedOut: false,
        stderr: '',
        resolved: true,
      }),
    ).toBe('completed');
    expect(
      classifyMulticaRunStatus({
        code: 1,
        signal: null,
        timedOut: false,
        stderr: 'agent timed out',
        resolved: false,
      }),
    ).toBe('timeout');
    expect(
      classifyMulticaRunStatus({
        code: null,
        signal: 'SIGTERM',
        timedOut: false,
        stderr: '',
        resolved: false,
      }),
    ).toBe('cancelled');
    expect(
      classifyMulticaRunStatus({
        code: 1,
        signal: null,
        timedOut: false,
        stderr: '',
        resolved: false,
      }),
    ).toBe('error');
    expect(
      classifyMulticaRunStatus({
        code: 0,
        signal: null,
        timedOut: false,
        stderr: 'config timeoutSeconds=180; request completed',
        resolved: true,
      }),
    ).toBe('completed');
  });

  test('creates an isolated evaluation config pinned to the Skill-Up workspace', () => {
    const userDataPath = createDirectory();
    const workspace = path.join(userDataPath, 'skill-up workspace');
    fs.mkdirSync(workspace);
    const sourceConfigPath = path.join(userDataPath, 'source.json');
    fs.writeFileSync(
      sourceConfigPath,
      JSON.stringify({
        agents: {
          defaults: { model: { primary: 'litellm/test-model' } },
          list: [{ id: 'main', default: true, model: { primary: 'litellm/test-model' } }],
        },
      }),
    );

    const generated = createMulticaWorkspaceConfig({
      sourceConfigPath,
      cwd: workspace,
      argv: ['agent', '--agent', 'main', '--local'],
      userDataPath,
    });
    expect(generated).not.toBeNull();
    const config = JSON.parse(fs.readFileSync(generated!.configPath, 'utf8'));
    expect(config.agents.defaults.workspace).toBe(workspace);
    expect(config.agents.list[0].workspace).toBe(workspace);
    expect(config.agents.defaults.model.primary).toBe('litellm/test-model');
    generated!.dispose();
    expect(fs.existsSync(generated!.configPath)).toBe(false);
  });

  test('authenticates the pipe and preserves streamed output and exit codes', async () => {
    const userDataPath = createDirectory();
    const cliScript = path.join(userDataPath, 'fake openclaw 中文.js');
    fs.writeFileSync(
      cliScript,
      [
        "process.stdout.write(Buffer.from('stdout 中文'));",
        "process.stderr.write(Buffer.from('stderr 中文'));",
        'process.exitCode = 7;',
      ].join('\n'),
    );
    const server = new MulticaBridgeServer({
      userDataPath,
      getEngineManager: () =>
        ({
          buildCliEnvironment: async () => ({
            openclawEntry: cliScript,
            env: { ...process.env, JUSTDO_ELECTRON_PATH: process.execPath },
          }),
        }) as unknown as OpenClawEngineManager,
      getCoworkStore: () => {
        throw new Error('not used');
      },
      getDatabase: () => {
        throw new Error('not used');
      },
      onSessionsChanged: vi.fn(),
    });

    await server.start();
    try {
      const metadata = JSON.parse(
        fs.readFileSync(path.join(userDataPath, 'multica', MULTICA_BRIDGE_METADATA_FILE), 'utf8'),
      ) as MulticaBridgeMetadata;
      const baseRequest: MulticaBridgeRequest = {
        type: 'request',
        version: MULTICA_BRIDGE_PROTOCOL_VERSION,
        requestId: 'test-request',
        token: metadata.token,
        argv: ['config', 'file'],
        cwd: userDataPath,
        env: {
          OPENCLAW_CONFIG_PATH: path.join(userDataPath, '配置 文件.json'),
          OPENCLAW_GATEWAY_TOKEN: 'must-not-cross',
        },
      };

      const rejected = await exchange(metadata.endpoint, { ...baseRequest, token: 'wrong-token' });
      expect(rejected).toEqual([{ type: 'error', message: 'Bridge request was rejected.' }]);

      const accepted = await exchange(metadata.endpoint, baseRequest);
      expect(
        accepted
          .filter(response => response.type === 'stdout')
          .map(response => Buffer.from(response.data, 'base64').toString('utf8'))
          .join(''),
      ).toBe('stdout 中文');
      expect(
        accepted
          .filter(response => response.type === 'stderr')
          .map(response => Buffer.from(response.data, 'base64').toString('utf8'))
          .join(''),
      ).toBe('stderr 中文');
      expect(accepted.at(-1)).toEqual({ type: 'exit', code: 7 });
    } finally {
      await server.stop();
    }
  });

  test('returns only the bundled runtime version for version probes', async () => {
    const userDataPath = createDirectory();
    const buildCliEnvironment = vi.fn();
    const server = new MulticaBridgeServer({
      userDataPath,
      getEngineManager: () =>
        ({
          getStatus: () => ({
            phase: 'ready',
            version: 'v2026.7.1-2',
            canRetry: false,
          }),
          buildCliEnvironment,
        }) as unknown as OpenClawEngineManager,
      getCoworkStore: () => {
        throw new Error('not used');
      },
      getDatabase: () => {
        throw new Error('not used');
      },
      onSessionsChanged: vi.fn(),
    });

    await server.start();
    try {
      const metadata = JSON.parse(
        fs.readFileSync(path.join(userDataPath, 'multica', MULTICA_BRIDGE_METADATA_FILE), 'utf8'),
      ) as MulticaBridgeMetadata;
      const responses = await exchange(metadata.endpoint, {
        type: 'request',
        version: MULTICA_BRIDGE_PROTOCOL_VERSION,
        requestId: 'version-request',
        token: metadata.token,
        argv: ['--version'],
        cwd: userDataPath,
        env: {},
      });
      const stdout = responses
        .filter(response => response.type === 'stdout')
        .map(response => Buffer.from(response.data, 'base64').toString('utf8'))
        .join('');

      expect(stdout).toBe(`${PRODUCT_NAME} 2026.7.1-2\n`);
      expect(responses.some(response => response.type === 'stderr')).toBe(false);
      expect(responses.at(-1)).toEqual({ type: 'exit', code: 0 });
      expect(buildCliEnvironment).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  test('projects configured models without exposing internal agents', async () => {
    const userDataPath = createDirectory();
    const cliScript = path.join(userDataPath, 'models.js');
    fs.writeFileSync(
      cliScript,
      [
        "if (process.argv.slice(2).join(' ') !== 'config get models.providers --json') process.exit(9);",
        "process.stdout.write(JSON.stringify({ custom0: { models: [{ id: 'first-model' }, { id: 'second-model' }] } }));",
      ].join('\n'),
    );
    const server = new MulticaBridgeServer({
      userDataPath,
      getEngineManager: () =>
        ({
          buildCliEnvironment: async () => ({
            openclawEntry: cliScript,
            env: { ...process.env, JUSTDO_ELECTRON_PATH: process.execPath },
          }),
        }) as unknown as OpenClawEngineManager,
      getCoworkStore: () => {
        throw new Error('not used');
      },
      getDatabase: () => {
        throw new Error('not used');
      },
      onSessionsChanged: vi.fn(),
    });

    await server.start();
    try {
      const metadata = JSON.parse(
        fs.readFileSync(path.join(userDataPath, 'multica', MULTICA_BRIDGE_METADATA_FILE), 'utf8'),
      ) as MulticaBridgeMetadata;
      const responses = await exchange(metadata.endpoint, {
        type: 'request',
        version: MULTICA_BRIDGE_PROTOCOL_VERSION,
        requestId: 'models-request',
        token: metadata.token,
        argv: ['agents', 'list', '--json'],
        cwd: userDataPath,
        env: {},
      });
      const stdout = responses
        .filter(response => response.type === 'stdout')
        .map(response => Buffer.from(response.data, 'base64').toString('utf8'))
        .join('');
      const entries = JSON.parse(stdout) as Array<{ id: string; name: string; model: string }>;

      expect(entries.map(entry => entry.name)).toEqual(['first-model', 'second-model']);
      expect(entries.map(entry => entry.model)).toEqual([
        'custom0/first-model',
        'custom0/second-model',
      ]);
      expect(stdout).not.toMatch(/main|justdo|scheduler/i);
      expect(responses.at(-1)).toEqual({ type: 'exit', code: 0 });
    } finally {
      await server.stop();
    }
  });

  test('cancels the OpenClaw child when the relay client disconnects', async () => {
    const userDataPath = createDirectory();
    const cliScript = path.join(userDataPath, 'long-running.js');
    fs.writeFileSync(
      cliScript,
      "process.stdout.write('ready'); setInterval(() => undefined, 1000);",
    );
    const server = new MulticaBridgeServer({
      userDataPath,
      getEngineManager: () =>
        ({
          buildCliEnvironment: async () => ({
            openclawEntry: cliScript,
            env: { ...process.env, JUSTDO_ELECTRON_PATH: process.execPath },
          }),
        }) as unknown as OpenClawEngineManager,
      getCoworkStore: () => {
        throw new Error('not used');
      },
      getDatabase: () => {
        throw new Error('not used');
      },
      onSessionsChanged: vi.fn(),
    });

    await server.start();
    try {
      const metadata = JSON.parse(
        fs.readFileSync(path.join(userDataPath, 'multica', MULTICA_BRIDGE_METADATA_FILE), 'utf8'),
      ) as MulticaBridgeMetadata;
      const socket = net.createConnection(metadata.endpoint);
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => {
          socket.write(
            encodeBridgeMessage({
              type: 'request',
              version: MULTICA_BRIDGE_PROTOCOL_VERSION,
              requestId: 'cancel-request',
              token: metadata.token,
              argv: ['config', 'file'],
              cwd: userDataPath,
              env: {},
            }),
          );
        });
        socket.once('data', () => resolve());
        socket.once('error', reject);
      });
      expect((server as unknown as { children: Set<unknown> }).children.size).toBe(1);
      socket.destroy();
      await vi.waitFor(
        () => {
          expect((server as unknown as { children: Set<unknown> }).children.size).toBe(0);
        },
        { timeout: 5_000 },
      );
    } finally {
      await server.stop();
    }
  });
});
