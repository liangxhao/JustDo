import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';

const { buildDevNativeHostConfig, resolveCompilerPath } =
  require('../../scripts/browser/prepare-browser-extension-dev-host.cjs') as {
    buildDevNativeHostConfig: (plan: { manifestPath: string }) => Record<string, unknown>;
    resolveCompilerPath: () => string | null;
  };

const compilerPath = resolveCompilerPath();
const projectRoot = path.resolve(__dirname, '../..');

describe.skipIf(process.platform !== 'win32' || !compilerPath)(
  'compiled browser native host launch policy',
  () => {
    let directory: string;
    let executablePath: string;
    let caseDirectory: string;
    let rendezvousPath: string;
    let receiptPath: string;

    beforeAll(() => {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-native-host-'));
      executablePath = path.join(directory, 'native-host-harness.exe');
      execFileSync(
        compilerPath!,
        [
          '/nologo',
          '/target:exe',
          '/main:NativeHostHarness',
          '/reference:System.Web.Extensions.dll',
          `/out:${executablePath}`,
          path.join(projectRoot, 'scripts/browser/browser-extension-native-host.cs'),
          path.join(__dirname, 'fixtures/browser-native-host-harness.cs'),
        ],
        { windowsHide: true, timeout: 20_000 },
      );
    });

    beforeEach(() => {
      caseDirectory = fs.mkdtempSync(path.join(directory, '开发 case '));
      rendezvousPath = path.join(caseDirectory, 'app-server.json');
      receiptPath = path.join(caseDirectory, 'launch-receipt.json');
    });

    afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

    const previousLaunchConfig = () => ({
      allowAppLaunch: true,
      executableArguments: ['publish', rendezvousPath, receiptPath, String(process.pid)],
      executablePath,
      rendezvousPath,
      workingDirectory: caseDirectory,
    });

    const devConfig = () =>
      buildDevNativeHostConfig({ manifestPath: path.join(caseDirectory, 'manifest.json') });

    const publish = (pid = process.pid) => {
      const rendezvous = {
        localAppServerUrl: `ws://127.0.0.1:41235/app-server?token=${'b'.repeat(64)}`,
        pid,
        protocolVersion: 2,
      };
      fs.writeFileSync(rendezvousPath, JSON.stringify(rendezvous));
      return rendezvous;
    };

    const ensure = (config: Record<string, unknown>, restart = false) => {
      const configPath = path.join(caseDirectory, 'native-host.config.json');
      fs.writeFileSync(configPath, JSON.stringify(config));
      return JSON.parse(
        execFileSync(executablePath, [configPath, restart ? 'restart' : 'ensure'], {
          encoding: 'utf8',
          timeout: 5_000,
          windowsHide: true,
        }),
      );
    };

    const exchangeNativeMessages = (
      methods: string[],
      origin = 'chrome-extension://jboajogplelmaahjbomgflnfngpolgcb/',
    ) => {
      const configPath = path.join(caseDirectory, 'native-host.config.json');
      const manifestPath = path.join(caseDirectory, 'manifest.json');
      const stagedExecutable = path.join(caseDirectory, 'native host.exe');
      fs.copyFileSync(executablePath, stagedExecutable);
      fs.writeFileSync(configPath, JSON.stringify(devConfig()), 'utf8');
      fs.writeFileSync(manifestPath, JSON.stringify({ path: stagedExecutable }), 'utf8');
      const frames = methods.map((method, id) => {
        const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params: {} }));
        const header = Buffer.alloc(4);
        header.writeUInt32LE(body.length);
        return Buffer.concat([header, body]);
      });
      const output = execFileSync(stagedExecutable, ['stdio', manifestPath, origin], {
        input: Buffer.concat(frames),
        timeout: 5_000,
        windowsHide: true,
      });
      const responses: unknown[] = [];
      let offset = 0;
      while (offset < output.length) {
        const size = output.readUInt32LE(offset);
        offset += 4;
        responses.push(JSON.parse(output.subarray(offset, offset + size).toString('utf8')));
        offset += size;
      }
      expect(offset).toBe(output.length);
      return responses;
    };

    test('runs the real stdio entry through isolated registration and Unicode discovery paths', () => {
      const rendezvous = publish();

      const responses = exchangeNativeMessages(['codexRuntime/hello', 'codexRuntime/ensure']);

      expect(responses[0]).toMatchObject({
        jsonrpc: '2.0',
        id: 0,
        result: { manifestSchemaVersion: 2, nativeHostProtocolVersion: 2 },
      });
      expect(responses[1]).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          localAppServerUrl: rendezvous.localAppServerUrl,
          runtimeConfig: { protocolVersion: 2 },
        },
      });
      expect(fs.existsSync(receiptPath)).toBe(false);
    });

    test('returns a retryable missing-app error through the real framing entry', () => {
      const responses = exchangeNativeMessages(['codexRuntime/hello', 'codexRuntime/ensure']);

      expect(responses[1]).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32603, data: { code: 'APP_NOT_RUNNING' } },
      });
      expect(fs.existsSync(rendezvousPath)).toBe(false);
      expect(fs.existsSync(receiptPath)).toBe(false);
    });

    test('rejects a foreign extension at the real process entry before discovery', () => {
      try {
        exchangeNativeMessages(['codexRuntime/hello'], 'chrome-extension://foreign/');
        throw new Error('A foreign extension must not receive a native response.');
      } catch (error) {
        expect(error).toMatchObject({ status: 1, stdout: Buffer.alloc(0) });
      }
      expect(fs.existsSync(rendezvousPath)).toBe(false);
    });

    test('refuses to launch the development app before the terminal has started it', () => {
      const response = ensure(devConfig());

      expect(response.error).toContain('Start it manually');
      expect(response.response.error).toMatchObject({
        code: -32603,
        data: { code: 'APP_NOT_RUNNING' },
      });
      expect(fs.existsSync(receiptPath)).toBe(false);
      expect(fs.existsSync(rendezvousPath)).toBe(false);
    });

    test.each([true, false, undefined, 'true'])(
      'never spawns a configured executable even with launch permission set to %s',
      allowAppLaunch => {
        const response = ensure({ ...previousLaunchConfig(), allowAppLaunch });

        expect(response.error).toContain('Start it manually');
        expect(fs.existsSync(receiptPath)).toBe(false);
      },
    );

    test('connects to the running development app without spawning a process', () => {
      const rendezvous = publish();

      const response = ensure(devConfig());

      expect(response.result).toEqual(rendezvous);
      expect(fs.existsSync(receiptPath)).toBe(false);
    });

    test('rejects a development restart without deleting the live discovery entry', () => {
      publish();
      const original = fs.readFileSync(rendezvousPath, 'utf8');

      const response = ensure({ ...previousLaunchConfig(), ...devConfig() }, true);

      expect(response.error).toContain('Restart the app manually');
      expect(fs.readFileSync(rendezvousPath, 'utf8')).toBe(original);
      expect(fs.existsSync(receiptPath)).toBe(false);
    });

    test('does not relaunch development when discovery points to a dead process', () => {
      publish(2_147_483_647);

      const response = ensure({ ...previousLaunchConfig(), ...devConfig() });

      expect(response.error).toContain('Start it manually');
      expect(fs.existsSync(receiptPath)).toBe(false);
    });

    test('connects to the running packaged app without using its previous launch config', () => {
      const rendezvous = publish();

      const response = ensure(previousLaunchConfig());

      expect(response.result).toEqual(rendezvous);
      expect(fs.existsSync(receiptPath)).toBe(false);
    });

    test('rejects packaged restart and preserves the live discovery entry', () => {
      publish();
      const original = fs.readFileSync(rendezvousPath, 'utf8');

      const response = ensure(previousLaunchConfig(), true);

      expect(response.error).toContain('Restart the app manually');
      expect(fs.readFileSync(rendezvousPath, 'utf8')).toBe(original);
      expect(fs.existsSync(receiptPath)).toBe(false);
    });

    test('rejects packaged restart when no app is running', () => {
      const response = ensure(previousLaunchConfig(), true);

      expect(response.error).toContain('Restart the app manually');
      expect(fs.existsSync(rendezvousPath)).toBe(false);
      expect(fs.existsSync(receiptPath)).toBe(false);
    });
  },
);
