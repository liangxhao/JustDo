import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { AgentBridgeServer } from '../../src/main/integrations/externalAgent/transport/agentBridgeServer';

const require = createRequire(import.meta.url);
const {
  createAgentCliLauncher,
  findCSharpCompiler,
} = require('../../scripts/external-agent/create-agent-cli-launcher.cjs');
const execFileAsync = promisify(execFile);

describe.skipIf(process.platform !== 'win32' || !findCSharpCompiler())(
  'native agent CLI stdio launcher',
  () => {
    let directory: string;
    let executable: string;
    let server: net.Server | undefined;
    const sockets = new Set<net.Socket>();
    const children = new Set<ChildProcessWithoutNullStreams>();

    beforeAll(() => {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-native-中文 $&-'));
      executable = path.join(directory, 'test-cli.exe');
      createAgentCliLauncher(executable, {
        userDataPath: directory,
        productName: 'Test',
        version: '1.2.3',
      });
    });
    afterEach(async () => {
      for (const child of children) {
        if (child.exitCode === null) {
          const exited = new Promise(resolve => child.once('close', resolve));
          child.kill();
          await exited;
        }
      }
      children.clear();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
      server = undefined;
      fs.rmSync(path.join(directory, 'external-agent', 'bridge.json'), { force: true });
    });
    afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

    async function bridge(onFrame: (frame: Record<string, unknown>, socket: net.Socket) => void) {
      const endpoint = `\\\\.\\pipe\\external-agent-${randomBytes(10).toString('hex')}`;
      const token = randomBytes(32).toString('hex');
      server = net.createServer(socket => {
        sockets.add(socket);
        let buffer = '';
        socket.setEncoding('utf8');
        socket.on('data', chunk => {
          buffer += chunk;
          for (;;) {
            const end = buffer.indexOf('\n');
            if (end < 0) break;
            const frame = JSON.parse(buffer.slice(0, end));
            buffer = buffer.slice(end + 1);
            if (frame.type === 'request') expect(frame.token).toBe(token);
            onFrame(frame, socket);
          }
        });
        socket.on('error', () => {});
      });
      await new Promise<void>(resolve => server!.listen(endpoint, resolve));
      fs.mkdirSync(path.join(directory, 'external-agent'), { recursive: true });
      fs.writeFileSync(
        path.join(directory, 'external-agent', 'bridge.json'),
        JSON.stringify({ version: 4, pid: process.pid, endpoint, token }),
      );
    }

    it.each(['codex', 'acp'] as const)(
      'streams %s initialize before stdin EOF and preserves split UTF-8 without launching Electron',
      async protocol => {
        let input = '';
        let handshake: Record<string, unknown> | undefined;
        let receivedPrefix!: () => void;
        const prefixReceived = new Promise<void>(resolve => {
          receivedPrefix = resolve;
        });
        await bridge((frame, socket) => {
          if (frame.type === 'request') handshake = frame;
          if (frame.type === 'stdin') {
            input += frame.data;
            if (input.length === 4094) receivedPrefix();
            if (input.includes('\n')) {
              const request = JSON.parse(input);
              const reply = JSON.stringify({ id: request.id, result: request.params });
              socket.write(
                JSON.stringify({
                  type: 'stdout',
                  data: Buffer.from(reply + '\n').toString('base64'),
                }) + '\n',
              );
            }
          }
          if (frame.type === 'eof') socket.end();
        });
        const argv = protocol === 'codex' ? ['app-server', '--listen', 'stdio://'] : ['acp'];
        const child = spawn(executable, argv, {
          windowsHide: true,
          env: {
            ...process.env,
            NODE_OPTIONS: '--invalid-node-option',
            JUSTDO_TEST_SECRET: 'blocked',
            CODEX_HOME: directory,
            MULTICA_TOKEN: 'must-not-forward',
            CUSTOM_ACCESS_TOKEN: 'must-not-forward',
          },
        });
        children.add(child);
        let output = '';
        let errors = '';
        child.stderr.on('data', data => {
          errors += data;
        });
        const reply = new Promise<void>((resolve, reject) => {
          child.stdout.on('data', data => {
            output += data;
            if (output.includes('\n')) resolve();
          });
          child.once('exit', code => reject(new Error(`Exited ${code}: ${errors}`)));
        });
        const prefix = '{"id":1,"method":"initialize","params":{"name":"';
        const padding = 'x'.repeat(4094 - Buffer.byteLength(prefix));
        const name = padding + '🌟中文';
        const request = Buffer.from(prefix + name + '"}}\n');
        // Wait until the first 4096 bytes have been consumed, with only half
        // of the emoji received. The second write cannot coalesce with the first.
        child.stdin.write(request.subarray(0, 4096));
        await prefixReceived;
        child.stdin.write(request.subarray(4096));
        await reply;
        expect(JSON.parse(output)).toEqual({ id: 1, result: { name } });
        expect(child.exitCode).toBeNull();
        expect(handshake?.argv).toEqual(argv);
        if (protocol === 'codex') expect(handshake?.env).toEqual({ CODEX_HOME: directory });
        else expect(handshake?.env).toEqual({});
        expect(handshake?.env).not.toHaveProperty('NODE_OPTIONS');
        expect(handshake?.env).not.toHaveProperty('JUSTDO_TEST_SECRET');
        const exited = new Promise(resolve => child.once('close', resolve));
        child.stdin.end();
        expect(await exited).toBe(0);
      },
    );

    it('returns the application model catalog and exact exit code over the authenticated bridge', async () => {
      await bridge((frame, socket) => {
        expect(frame.argv).toEqual(['debug', 'models']);
        const output =
          JSON.stringify({ models: [{ slug: 'main', display_name: 'Local assistant' }] }) + '\n';
        socket.end(
          JSON.stringify({ type: 'stdout', data: Buffer.from(output).toString('base64') }) +
            '\n' +
            JSON.stringify({ type: 'exit', code: 0 }) +
            '\n',
        );
      });
      const result = await execFileAsync(executable, ['debug', 'models'], { windowsHide: true });
      expect(JSON.parse(result.stdout).models).toEqual([
        { slug: 'main', display_name: 'Local assistant' },
      ]);
      expect(result.stderr).toBe('');
    });

    it('starts app-server without task credentials or CODEX_HOME', async () => {
      await bridge((frame, socket) => {
        expect(frame.argv).toEqual(['app-server', '--listen', 'stdio://']);
        expect(frame.env).toEqual({});
        socket.end(`${JSON.stringify({ type: 'exit', code: 0 })}\n`);
      });
      const env = { ...process.env };
      delete env.CODEX_HOME;
      const result = await execFileAsync(executable, ['app-server', '--listen', 'stdio://'], {
        windowsHide: true,
        env,
      });
      expect(result).toMatchObject({ stdout: '', stderr: '' });
    });

    it('prints embedded help and version without reading bridge metadata', async () => {
      const version = await execFileAsync(executable, ['--version'], { windowsHide: true });
      expect(version).toMatchObject({ stdout: 'Test 1.2.3\n', stderr: '' });
      const shortVersion = await execFileAsync(executable, ['-V'], { windowsHide: true });
      expect(shortVersion.stdout).toBe(version.stdout);
      const help = await execFileAsync(executable, ['--help'], { windowsHide: true });
      expect(help.stdout).toContain('test-cli');
      expect(help.stdout).toContain('models list [--json]');
      expect(help.stdout).toContain('--stream-json');
      expect(help.stderr).toBe('');
    });

    it('fails clearly for missing bridge metadata and rejects unsupported commands', async () => {
      await expect(
        execFileAsync(executable, ['debug', 'models'], { windowsHide: true }),
      ).rejects.toMatchObject({ code: 69, stderr: expect.stringMatching(/not running|未运行/) });
      await expect(
        execFileAsync(executable, ['agent'], { windowsHide: true }),
      ).rejects.toMatchObject({ code: 64, stderr: expect.stringContaining('--help') });
      await expect(
        execFileAsync(executable, ['models', 'list', '--json'], { windowsHide: true }),
      ).rejects.toMatchObject({
        code: 69,
        stderr: '',
        stdout: expect.stringContaining('HOST_UNAVAILABLE'),
      });
      await expect(
        execFileAsync(executable, ['unsupported', '--json'], { windowsHide: true }),
      ).rejects.toMatchObject({
        code: 64,
        stderr: '',
        stdout: expect.stringContaining('INVALID_ARGUMENTS'),
      });
    });

    it('reports a confirmed exited discovery PID as unavailable without connecting or deleting metadata', async () => {
      const exited = spawn(process.execPath, ['-e', ''], { windowsHide: true });
      children.add(exited);
      await new Promise<void>((resolve, reject) => {
        exited.once('error', reject);
        exited.once('close', () => resolve());
      });
      expect(exited.exitCode).toBe(0);
      expect(() => process.kill(exited.pid!, 0)).toThrow();
      const received = vi.fn();
      await bridge(received);
      const metadataPath = path.join(directory, 'external-agent', 'bridge.json');
      const metadata = JSON.stringify({
        ...JSON.parse(fs.readFileSync(metadataPath, 'utf8')),
        pid: exited.pid,
      });
      fs.writeFileSync(metadataPath, metadata);

      const failure = await execFileAsync(executable, ['status', '--json'], {
        windowsHide: true,
      }).catch(error => error);

      expect(failure).toMatchObject({ code: 69, stderr: '' });
      expect(JSON.parse(failure.stdout)).toMatchObject({
        type: 'error',
        error: { code: 'HOST_UNAVAILABLE', message: expect.stringMatching(/not running|未运行/) },
      });
      expect(received).not.toHaveBeenCalled();
      expect(sockets.size).toBe(0);
      expect(fs.readFileSync(metadataPath, 'utf8')).toBe(metadata);
    });

    it('preserves a nonzero bridge exit code and its stderr', async () => {
      await bridge((_frame, socket) =>
        socket.end(
          JSON.stringify({
            type: 'stderr',
            data: Buffer.from('The runtime is unavailable.\n').toString('base64'),
          }) +
            '\n' +
            JSON.stringify({ type: 'exit', code: 78 }) +
            '\n',
        ),
      );
      await expect(
        execFileAsync(executable, ['debug', 'models'], { windowsHide: true }),
      ).rejects.toMatchObject({ code: 78, stderr: 'The runtime is unavailable.\n' });
    });

    it.each(['--json', '--stream-json', 'text'])(
      'preserves authenticated invalid-argument errors from the real bridge in %s mode',
      async format => {
        const execute = vi.fn();
        const realBridge = new AgentBridgeServer({
          userDataPath: directory,
          commandService: { activeTaskCount: 0, execute, connect: vi.fn() },
        });
        await realBridge.start();
        try {
          const argv = ['exec', ...(format === 'text' ? [] : [format]), '--bad', 'x'];
          const result = await execFileAsync(executable, argv, { windowsHide: true }).catch(
            error => error,
          );
          expect(result.code).toBe(64);
          expect(execute).not.toHaveBeenCalled();
          if (format === 'text') {
            expect(result.stdout).toBe('');
            expect(result.stderr).toContain('--help');
          } else {
            expect(result.stderr).toBe('');
            expect(result.stdout.trim().split('\n')).toHaveLength(1);
            expect(JSON.parse(result.stdout)).toEqual({
              type: 'error',
              error: { code: 'INVALID_ARGUMENTS', message: expect.any(String) },
            });
          }
        } finally {
          await realBridge.stop();
        }
      },
    );

    it('fails on an unexpected remote disconnect instead of reporting successful completion', async () => {
      await bridge((_frame, socket) => socket.end());
      await expect(
        execFileAsync(executable, ['app-server', '--listen', 'stdio://'], { windowsHide: true }),
      ).rejects.toMatchObject({ code: 70 });
    });

    it.each([
      ['status', '--json'],
      ['models', 'list', '--json'],
      ['exec', '--cwd', '../项目 目录', '--stream-json', '--prompt', 'Inspect\nthen summarize'],
    ])(
      'forwards general command arguments and output without task environment: %j',
      async (...argv) => {
        const output = [
          {
            type: 'event',
            sessionId: 'session-1',
            runId: 'run-1',
            event: { stream: 'assistant', data: { delta: '中文🌟' } },
          },
          {
            type: 'result',
            sessionId: 'session-1',
            runId: 'run-1',
            status: 'completed',
            text: '中文🌟',
          },
        ]
          .map(frame => JSON.stringify(frame) + '\n')
          .join('');
        await bridge((frame, socket) => {
          expect(frame.argv).toEqual(argv);
          expect(frame.env).toEqual({});
          socket.end(
            JSON.stringify({ type: 'stdout', data: Buffer.from(output).toString('base64') }) +
              '\n' +
              JSON.stringify({ type: 'exit', code: 0 }) +
              '\n',
          );
        });

        const result = await execFileAsync(executable, argv, {
          windowsHide: true,
          env: {
            ...process.env,
            MULTICA_TOKEN: 'must-not-forward',
            CUSTOM_ACCESS_TOKEN: 'must-not-forward',
          },
        });
        expect(result.stdout).toBe(output);
        expect(result.stderr).toBe('');
      },
    );

    it('uses a single machine error frame when the general bridge disconnects', async () => {
      await bridge((_frame, socket) => socket.end());
      let failure: unknown;
      try {
        await execFileAsync(executable, ['exec', '--json', 'prompt'], { windowsHide: true });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: 70, stderr: '' });
      const stdout = (failure as { stdout: string }).stdout;
      expect(stdout.trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(stdout)).toMatchObject({ type: 'error', error: { code: 'BRIDGE_ERROR' } });
    });

    it('does not include malformed discovery credentials in local errors', async () => {
      fs.mkdirSync(path.join(directory, 'external-agent'), { recursive: true });
      fs.writeFileSync(
        path.join(directory, 'external-agent', 'bridge.json'),
        'sensitive-discovery-token',
      );
      await expect(
        execFileAsync(executable, ['status', '--json'], { windowsHide: true }),
      ).rejects.toMatchObject({
        code: 70,
        stderr: '',
        stdout: expect.not.stringContaining('sensitive-discovery-token'),
      });
    });
  },
);
