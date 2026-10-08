import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  createMulticaAgentLauncher,
  findCSharpCompiler,
} = require('../../scripts/multica/create-multica-agent-launcher.cjs');
const execFileAsync = promisify(execFile);

describe.skipIf(process.platform !== 'win32' || !findCSharpCompiler())(
  'native Multica stdio launcher',
  () => {
    let directory: string;
    let executable: string;
    let server: net.Server | undefined;
    const sockets = new Set<net.Socket>();
    const children = new Set<ChildProcessWithoutNullStreams>();

    beforeAll(() => {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'multica-native-'));
      executable = path.join(directory, 'Test-agent.exe');
      createMulticaAgentLauncher(executable, { userDataPath: directory });
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
      fs.rmSync(path.join(directory, 'multica', 'bridge.json'), { force: true });
    });
    afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

    async function bridge(onFrame: (frame: Record<string, unknown>, socket: net.Socket) => void) {
      const endpoint = `\\\\.\\pipe\\justdo-multica-${randomBytes(10).toString('hex')}`;
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
      fs.mkdirSync(path.join(directory, 'multica'), { recursive: true });
      fs.writeFileSync(
        path.join(directory, 'multica', 'bridge.json'),
        JSON.stringify({ version: 4, pid: process.pid, endpoint, token }),
      );
    }

    it('streams initialize before stdin EOF and preserves split UTF-8 without launching Electron', async () => {
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
      const child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
        windowsHide: true,
        env: {
          ...process.env,
          NODE_OPTIONS: '--invalid-node-option',
          JUSTDO_TEST_SECRET: 'blocked',
          CODEX_HOME: directory,
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
      expect(handshake?.argv).toEqual(['app-server', '--listen', 'stdio://']);
      expect(handshake?.env).toMatchObject({ CODEX_HOME: directory });
      expect(handshake?.env).not.toHaveProperty('NODE_OPTIONS');
      expect(handshake?.env).not.toHaveProperty('JUSTDO_TEST_SECRET');
      const exited = new Promise(resolve => child.once('close', resolve));
      child.stdin.end();
      expect(await exited).toBe(0);
    });

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

    it('fails clearly for missing bridge metadata and rejects unsupported commands', async () => {
      await expect(
        execFileAsync(executable, ['--version'], { windowsHide: true }),
      ).rejects.toMatchObject({ code: 69, stderr: expect.stringContaining('not running') });
      await expect(
        execFileAsync(executable, ['agent'], { windowsHide: true }),
      ).rejects.toMatchObject({ code: 64, stderr: expect.stringContaining('Codex') });
    });

    it('preserves a nonzero bridge exit code and its stderr', async () => {
      await bridge((_frame, socket) =>
        socket.end(
          JSON.stringify({
            type: 'stderr',
            data: Buffer.from('Integration is disabled.\n').toString('base64'),
          }) +
            '\n' +
            JSON.stringify({ type: 'exit', code: 78 }) +
            '\n',
        ),
      );
      await expect(
        execFileAsync(executable, ['--version'], { windowsHide: true }),
      ).rejects.toMatchObject({ code: 78, stderr: 'Integration is disabled.\n' });
    });

    it('fails on an unexpected remote disconnect instead of reporting successful completion', async () => {
      await bridge((_frame, socket) => socket.end());
      await expect(
        execFileAsync(executable, ['app-server', '--listen', 'stdio://'], { windowsHide: true }),
      ).rejects.toMatchObject({ code: 70 });
    });
  },
);
