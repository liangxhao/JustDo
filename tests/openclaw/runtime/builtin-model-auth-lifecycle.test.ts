import { type ChildProcess,fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';
import { expect, test, vi } from 'vitest';

import {
  publishBuiltinCredentialFile,
  revokeBuiltinCredentialFile,
  syncBuiltinCredentialFile,
} from '../../../src/main/openclaw/config/models/builtinCredentialFile';
import { buildWindowsChildProcessPreload } from '../../../src/main/openclaw/runtime/launch/electronNodeRuntime';
import { BuiltinModelAuthCoordinator } from '../../../src/main/providers/builtinModelAuthCoordinator';
import {
  clearActiveBuiltinModelCredential,
  getActiveBuiltinModelCredential,
  getActiveBuiltinModelCredentialSessionId,
} from '../../../src/main/providers/builtinModelCredential';
import { BuiltinModelCredentialMonitor } from '../../../src/main/providers/builtinModelCredentialMonitor';
import { BuiltinModelTokenExchange } from '../../../src/main/providers/builtinModelTokenExchange';

const runtime = path.resolve(
  process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR ?? 'vendor/openclaw-runtime/current',
);
const sdk = path.join(runtime, 'dist/plugin-sdk');
const available = fs.existsSync(path.join(sdk, 'secret-ref-runtime.js'));
const nowSeconds = 2_000_000_000;

test.skipIf(!available)('model requests keep renewing through a delayed config ACK and reject a late ACK after logout', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-auth-lifecycle 测试 '));
  const clockFile = path.join(directory, 'clock.json');
  let child: ChildProcess | undefined;
  let monitor: BuiltinModelCredentialMonitor | undefined;
  let acknowledgeRotation: (() => void) | undefined;
  vi.useFakeTimers();
  vi.setSystemTime(nowSeconds * 1_000);
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({
    Ethernet: [{
      address: '192.0.2.1', netmask: '255.255.255.0', family: 'IPv4',
      mac: '02:ab:cd:ef:12:34', internal: false, cidr: '192.0.2.1/24',
    }],
  });
  clearActiveBuiltinModelCredential();
  try {
    // The Main clock and the actual exec resolver must agree about expiration.
    // Only the fixture adds this preload to the captured exec environment.
    const clockPreload = path.join(directory, 'clock.cjs');
    fs.writeFileSync(clockPreload, [
      "const fs = require('node:fs');",
      "Date.now = () => JSON.parse(fs.readFileSync(process.env.MODEL_AUTH_TEST_CLOCK_PATH, 'utf8'));",
    ].join('\n'));
    const publishClock = () => fs.writeFileSync(clockFile, JSON.stringify(Date.now()));
    publishClock();
    const loginFile = path.join(directory, 'user_info.json');
    fs.writeFileSync(loginFile, JSON.stringify({ mtoken: 'fixture-login', 'X-User-Account': 'fixture-account' }));
    let exchanges = 0;
    const exchange = new BuiltinModelTokenExchange({
      userInfoPath: loginFile,
      getConfig: () => ({
        tokenExchangeUrl: 'https://issuer.invalid/exchange', maxJwtLifetimeSeconds: 60,
        developmentAuthMode: 'jwt', developmentApiKey: '',
      }),
      onInvalidated: () => revokeBuiltinCredentialFile(directory),
      fetch: async () => {
        const issuedAt = Math.floor(Date.now() / 1_000);
        const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
        const accessToken = [encode({ alg: 'RS256' }), encode({
          sub: 'fixture-account', iss: 'https://issuer.invalid', aud: 'justdo-litellm',
          iat: issuedAt, exp: issuedAt + 60, jti: `fixture-${++exchanges}`,
        }), 'fixture-signature'].join('.');
        return new Response(JSON.stringify({ access_token: accessToken, token_type: 'Bearer', expires_in: 60 }));
      },
    });
    const initial = await exchange.refresh();
    expect(initial).not.toBeNull();
    const sessionId = getActiveBuiltinModelCredentialSessionId();
    expect(sessionId).toBeTypeOf('string');
    const baseUrl = 'https://models.invalid/v1';
    const { config } = syncBuiltinCredentialFile({ models: { providers: { builtin_models: {
      baseUrl, api: 'openai-completions',
      apiKey: { source: 'exec', provider: 'justdo_login', id: 'X-ACCESS-JWT' },
    } } } }, directory, initial, {
      executable: process.execPath, sha256: createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),
    }, sessionId);
    const execProvider = (config.secrets as {
      providers: { justdo_login: { env: Record<string, string> } };
    }).providers.justdo_login;
    execProvider.env.NODE_OPTIONS = `--require="${clockPreload.replace(/\\/g, '/')}"`;
    execProvider.env.MODEL_AUTH_TEST_CLOCK_PATH = clockFile;
    const configFile = path.join(directory, 'config.json');
    fs.writeFileSync(configFile, JSON.stringify(config));
    const delayedAck = new Promise<void>(resolve => { acknowledgeRotation = resolve; });
    const rotate = vi.fn(async () => {
      // Ordinary config preparation also publishes the current credential before
      // awaiting Gateway acknowledgement. Hold that acknowledgement indefinitely.
      syncBuiltinCredentialFile(config, directory, getActiveBuiltinModelCredential(), {
        executable: process.execPath, sha256: createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),
      });
      await delayedAck;
    });
    const login = vi.fn(async () => undefined);
    const backgroundError = vi.fn();
    const monitorError = vi.fn();
    const coordinator = new BuiltinModelAuthCoordinator({
      exchange: () => exchange.refresh(),
      getActive: getActiveBuiltinModelCredential,
      getAuthSessionId: getActiveBuiltinModelCredentialSessionId,
      publishCredential: (credential, authSessionId) => {
        publishBuiltinCredentialFile(directory, credential, authSessionId);
      },
      login, rotate,
      invalidate: () => exchange.suspend(),
      logout: async () => undefined,
      onBackgroundError: backgroundError,
    });
    coordinator.initialize(initial);
    monitor = new BuiltinModelCredentialMonitor({
      userInfoPath: loginFile,
      refresh: () => coordinator.refreshInBackground(),
      watchFile: vi.fn(), unwatchFile: vi.fn(), onError: monitorError,
    });
    monitor.start(initial);

    const providerFile = path.join(directory, 'provider.mjs');
    await build({
      entryPoints: [path.resolve('plugins/extensions/runtime-services/model-auth.ts')],
      outfile: providerFile, bundle: true, format: 'esm', platform: 'node', target: 'node24',
      plugins: [{ name: 'actual-native-sdk', setup(builder) {
        builder.onResolve({ filter: /^openclaw\/plugin-sdk\// }, args => ({
          path: pathToFileURL(path.join(sdk, `${args.path.split('/').at(-1)}.js`)).href,
          external: true,
        }));
      } }],
    });
    const url = (file: string) => JSON.stringify(pathToFileURL(file).href);
    const runnerFile = path.join(directory, 'runner.mjs');
    fs.writeFileSync(runnerFile, `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { buildBuiltinModelAuthProvider } from ${url(providerFile)};
      import { createAiTransportHost, runWithAiTransportHost } from ${url(path.join(runtime, 'node_modules/@openclaw/ai/dist/index.mjs'))};
      import { createOpenAICompletionsTransportStreamFn } from ${url(path.join(runtime, 'node_modules/@openclaw/ai/dist/transports.mjs'))};
      const captured = JSON.parse(fs.readFileSync(${JSON.stringify(configFile)}, 'utf8'));
      const first = ${JSON.stringify(initial!.accessToken)};
      const model = {
        id: 'fixture', name: 'Fixture', provider: 'builtin_models', api: 'openai-completions',
        baseUrl: ${JSON.stringify(baseUrl)}, reasoning: false, input: ['text'], contextWindow: 8192,
        maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        headers: { 'X-ACCESS-JWT': first },
      };
      let requests = 0;
      let expectedTokenId;
      const host = createAiTransportHost({ buildModelFetch: () => async (_url, init) => {
        requests++;
        const headers = new Headers(init.headers);
        const token = headers.get('x-access-jwt');
        assert.equal(headers.get('authorization'), 'Bearer ' + token);
        const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
        assert.equal(claims.jti, expectedTokenId);
        assert.ok(claims.exp > Date.now() / 1000);
        const event = (delta, finish_reason) => 'data: ' + JSON.stringify({
          id: 'fixture', object: 'chat.completion.chunk', created: Date.now() / 1000, model: 'fixture',
          choices: [{ index: 0, delta, finish_reason }],
        }) + '\\n\\n';
        return new Response(event({ role: 'assistant', content: 'ok' }, null) + event({}, 'stop') + 'data: [DONE]\\n\\n',
          { headers: { 'content-type': 'text/event-stream' } });
      } });
      // Capture one task/config once; every later call still supplies its original key.
      const task = buildBuiltinModelAuthProvider().wrapStreamFn({
        config: captured, provider: 'builtin_models', modelId: 'fixture', model,
        streamFn: createOpenAICompletionsTransportStreamFn(),
      });
      process.on('message', async message => {
        expectedTokenId = message.tokenId;
        try {
          await runWithAiTransportHost(host, async () => {
            const events = await task(model, { messages: [{ role: 'user', content: 'fixture', timestamp: Date.now() }] },
              { apiKey: first, timeoutMs: 5000 });
            let done = false;
            for await (const event of events) {
              if (event.type === 'error') throw new Error('fixture transport failed');
              if (event.type === 'done') done = true;
            }
            assert.equal(done, true);
          });
          process.send({ ok: true, requests });
        } catch (error) {
          process.send({ ok: false, requests, unavailable: error.message === 'Managed model credentials are unavailable.' });
        }
      });
      process.send({ ready: true });
    `);
    const preloadFile = path.join(directory, 'preload.cjs');
    fs.writeFileSync(preloadFile, `${buildWindowsChildProcessPreload()}\nrequire(${JSON.stringify(clockPreload)});\n`);
    child = fork(runnerFile, [], {
      execArgv: ['--require', preloadFile], silent: true, windowsHide: true,
      env: { ...process.env, MODEL_AUTH_TEST_CLOCK_PATH: clockFile,
        OPENCLAW_STATE_DIR: directory, OPENCLAW_CONFIG_PATH: configFile },
    });
    expect((await once(child, 'message'))[0]).toEqual({ ready: true });
    const request = async (tokenId: string) => {
      const response = once(child!, 'message');
      child!.send({ tokenId });
      return (await response)[0] as { ok: boolean; requests: number; unavailable?: boolean };
    };
    const advance = async (milliseconds: number) => {
      await vi.advanceTimersByTimeAsync(milliseconds);
      publishClock();
    };

    expect(await request('fixture-1')).toEqual({ ok: true, requests: 1 });
    await advance(30_000);
    expect(exchanges).toBe(2);
    expect(rotate).toHaveBeenCalledTimes(1);
    expect(await request('fixture-2')).toEqual({ ok: true, requests: 2 });
    const firstRenewal = getActiveBuiltinModelCredential();
    await advance(75_000);
    expect(initial!.expiresAt).toBeLessThan(Date.now() / 1_000);
    expect(firstRenewal!.expiresAt).toBeLessThan(Date.now() / 1_000);
    expect(await request('fixture-4')).toEqual({ ok: true, requests: 3 });
    expect(exchanges).toBe(4);
    expect(rotate).toHaveBeenCalledTimes(1);
    expect(login).not.toHaveBeenCalled();
    expect(getActiveBuiltinModelCredentialSessionId()).toBe(sessionId);

    monitor.stop();
    await coordinator.logout();
    expect(await request('fixture-4')).toEqual({ ok: false, requests: 3, unavailable: true });
    acknowledgeRotation!();
    await vi.advanceTimersByTimeAsync(0);
    expect(fs.existsSync(path.join(directory, 'credentials/credentials.json'))).toBe(false);
    expect(await request('fixture-4')).toEqual({ ok: false, requests: 3, unavailable: true });
    expect(backgroundError).not.toHaveBeenCalled();
    expect(monitorError).not.toHaveBeenCalled();
  } finally {
    monitor?.stop();
    acknowledgeRotation?.();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    clearActiveBuiltinModelCredential();
    vi.restoreAllMocks();
    vi.useRealTimers();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 45_000);
