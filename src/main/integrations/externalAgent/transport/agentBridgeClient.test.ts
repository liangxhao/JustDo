import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { buildSync } from 'esbuild';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { version } from '../../../../../package.json';
import { AGENT_CLI_BRIDGE_SWITCH } from '../../../../shared/integrations/agentCli';
import { PRODUCT_NAME } from '../../../../shared/productMetadata';
import { isAgentBridgeHostDefinitelyStopped } from './agentBridgeClient';
import { type AgentBridgeCommandService, AgentBridgeServer } from './agentBridgeServer';

const execFileAsync = promisify(execFile);
let directory: string;
let clientScript: string;
const servers: AgentBridgeServer[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();

beforeAll(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-client-'));
  clientScript = path.join(directory, 'client.cjs');
  buildSync({
    stdin: {
      contents: [
        "import { runAgentBridgeClient } from './src/main/integrations/externalAgent/transport/agentBridgeClient.ts';",
        "import { parseAgentBridgeArgv } from './src/main/integrations/externalAgent/transport/agentBridgeProtocol.ts';",
        'const argv = parseAgentBridgeArgv(process.argv);',
        "if (argv === null) throw new Error('The fixture requires the application bridge entry.');",
        'runAgentBridgeClient(process.argv[2], argv).then(code => { process.exitCode = code; });',
      ].join('\n'),
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: clientScript,
  });
});

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null) {
      const stopped = new Promise(resolve => child.once('close', resolve));
      child.kill();
      await stopped;
    }
  }
  children.clear();
  for (const server of servers.splice(0)) await server.stop();
});

afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

async function startBridge(commandService: AgentBridgeCommandService): Promise<string> {
  const userData = fs.mkdtempSync(path.join(directory, 'profile-'));
  const server = new AgentBridgeServer({ userDataPath: userData, commandService });
  servers.push(server);
  await server.start();
  return userData;
}

function runClient(userData: string, argv: string[]) {
  return execFileAsync(
    process.execPath,
    [clientScript, userData, AGENT_CLI_BRIDGE_SWITCH, ...argv],
    {
      windowsHide: true,
      timeout: 5000,
      env: {
        ...process.env,
        MULTICA_TOKEN: 'do-not-forward',
        CUSTOM_ACCESS_TOKEN: 'do-not-forward',
      },
    },
  );
}

describe('application stdio bridge client', () => {
  it('provides help and the installed version without a running desktop instance', async () => {
    const missing = path.join(directory, 'missing-profile');
    expect(await runClient(missing, ['--version'])).toMatchObject({
      stdout: `${PRODUCT_NAME} ${version}\n`,
      stderr: '',
    });
    const help = await runClient(missing, ['--help']);
    expect(help.stdout).toContain(`${PRODUCT_NAME.toLowerCase()}-cli`);
    expect(help.stdout).toContain('models list [--json]');
    expect(help.stderr).toBe('');
  });

  it('reports missing hosts and invalid CLI syntax as machine-readable local errors', async () => {
    const missing = path.join(directory, 'missing-profile');
    await expect(runClient(missing, ['status', '--json'])).rejects.toMatchObject({
      code: 69,
      stderr: '',
      stdout: expect.stringContaining('HOST_UNAVAILABLE'),
    });
    await expect(
      runClient(missing, ['exec', '--json', '--stream-json', 'prompt']),
    ).rejects.toMatchObject({
      code: 64,
      stderr: '',
      stdout: expect.stringContaining('INVALID_ARGUMENTS'),
    });
  });

  it('reports stale discovery for an exited host as unavailable without deleting it or connecting', async () => {
    const exited = spawn(process.execPath, ['-e', ''], { windowsHide: true });
    children.add(exited);
    await new Promise<void>((resolve, reject) => {
      exited.once('error', reject);
      exited.once('close', () => resolve());
    });
    expect(exited.exitCode).toBe(0);
    expect(isAgentBridgeHostDefinitelyStopped(exited.pid!)).toBe(true);
    const execute = vi.fn<AgentBridgeCommandService['execute']>(async () => ({ exitCode: 0 }));
    const profile = await startBridge({ activeTaskCount: 0, execute, connect: vi.fn() });
    const metadataPath = path.join(profile, 'external-agent', 'bridge.json');
    const metadata = JSON.stringify({
      ...JSON.parse(fs.readFileSync(metadataPath, 'utf8')),
      pid: exited.pid,
    });
    fs.writeFileSync(metadataPath, metadata);

    const failure = await runClient(profile, ['status', '--json']).catch(error => error);

    expect(failure).toMatchObject({ code: 69, stderr: '' });
    expect(JSON.parse(failure.stdout)).toMatchObject({
      type: 'error',
      error: { code: 'HOST_UNAVAILABLE', message: expect.stringMatching(/not running|未运行/) },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(fs.readFileSync(metadataPath, 'utf8')).toBe(metadata);
  });

  it.each(['EPERM', 'EACCES', undefined])(
    'keeps host availability uncertain when a process probe fails with %s',
    code => {
      const probe = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('Process state unavailable.'), { code });
      });
      try {
        expect(isAgentBridgeHostDefinitelyStopped(123)).toBe(false);
      } finally {
        probe.mockRestore();
      }
    },
  );

  it.each(['--json', '--stream-json'])(
    'preserves invalid arguments through the application entry and returns one %s error frame',
    async format => {
      const missing = path.join(directory, 'missing-profile');
      const result = await runClient(missing, ['exec', format, '--bad', 'x']).catch(error => error);
      expect(result.code).toBe(64);
      expect(result.stderr).toBe('');
      expect(result.stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toEqual({
        type: 'error',
        error: { code: 'INVALID_ARGUMENTS', message: expect.any(String) },
      });
    },
  );

  it('does not expose malformed discovery credentials in errors', async () => {
    const profile = path.join(directory, 'bad-profile');
    fs.mkdirSync(path.join(profile, 'external-agent'), { recursive: true });
    fs.writeFileSync(
      path.join(profile, 'external-agent', 'bridge.json'),
      'sensitive-discovery-token',
    );
    await expect(runClient(profile, ['status', '--json'])).rejects.toMatchObject({
      code: 70,
      stderr: '',
      stdout: expect.not.stringContaining('sensitive-discovery-token'),
    });
  });

  it('uses generic discovery and relays streamed output without environment credentials', async () => {
    const execute = vi.fn<AgentBridgeCommandService['execute']>(
      async (_argv, _cwd, _env, _signal, emit) => {
        emit?.('stdout', '{"type":"event","text":"中文🌟"}\n');
        return { stdout: '{"type":"result","text":"done"}\n', exitCode: 0 };
      },
    );
    const profile = await startBridge({ activeTaskCount: 0, execute, connect: vi.fn() });
    expect(fs.readdirSync(profile)).toEqual(['external-agent']);
    const argv = ['exec', '--stream-json', '--prompt', 'Inspect\nthen summarize'];

    const result = await runClient(profile, argv);

    expect(result.stdout).toBe(
      '{"type":"event","text":"中文🌟"}\n{"type":"result","text":"done"}\n',
    );
    expect(result.stderr).toBe('');
    expect(execute).toHaveBeenCalledWith(
      argv,
      process.cwd(),
      {},
      expect.any(AbortSignal),
      expect.any(Function),
    );
  });

  it('uses generic discovery for Codex models without forwarding ambient environment', async () => {
    const execute = vi.fn<AgentBridgeCommandService['execute']>(async () => ({
      stdout: '{"models":[]}\n',
      exitCode: 0,
    }));
    const profile = await startBridge({ activeTaskCount: 0, execute, connect: vi.fn() });
    expect(fs.readdirSync(profile)).toEqual(['external-agent']);

    expect((await runClient(profile, ['debug', 'models'])).stdout).toBe('{"models":[]}\n');
    expect(execute.mock.calls[0][2]).toEqual({});
  });

  it('keeps ACP stdin interactive until EOF and forwards cancellation while a prompt is pending', async () => {
    let promptStarted!: () => void;
    const started = new Promise<void>(resolve => {
      promptStarted = resolve;
    });
    let finishPrompt!: () => void;
    const pending = new Promise<void>(resolve => {
      finishPrompt = resolve;
    });
    const received: unknown[] = [];
    const connect = vi.fn<AgentBridgeCommandService['connect']>((_cwd, _env, send) => ({
      receive: async raw => {
        received.push(raw);
        const request = raw as { id?: number; method?: string };
        if (request.method === 'initialize')
          send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1 } });
        if (request.method === 'session/prompt') {
          promptStarted();
          await pending;
          send({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'cancelled' } });
        }
        if (request.method === 'session/cancel') finishPrompt();
      },
      close: async () => {
        finishPrompt();
      },
    }));
    const profile = await startBridge({ activeTaskCount: 1, execute: vi.fn(), connect });
    const child = spawn(process.execPath, [clientScript, profile, AGENT_CLI_BRIDGE_SWITCH, 'acp'], {
      windowsHide: true,
    });
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    const exited = new Promise<number | null>(resolve => child.once('close', resolve));
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } })}\n`,
    );
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 'session-1', prompt: [{ type: 'text', text: '中文🌟' }] } })}\n`,
    );
    try {
      await started;
      const cancel = {
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId: 'session-1' },
      };
      child.stdin.write(`${JSON.stringify(cancel)}\n`);
      await vi.waitFor(() => expect(stdout).toContain('cancelled'), { timeout: 1000 });
      expect(received).toContainEqual(cancel);
      expect(child.exitCode).toBeNull();
      expect(connect.mock.calls[0][1]).toEqual({});
      expect(stderr).toBe('');
      child.stdin.end();
      expect(await exited).toBe(0);
    } finally {
      finishPrompt();
    }
  });
});
