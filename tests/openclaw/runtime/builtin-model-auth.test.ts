import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';
import ts from 'typescript';
import { expect, test } from 'vitest';

import { MODEL_AUTH_SESSION_ENV } from '../../../plugins/extensions/runtime-services/contracts/model-auth';
import { sealBuiltinCredential, syncBuiltinCredentialFile } from '../../../src/main/openclaw/config/models/builtinCredentialFile';
import { buildWindowsChildProcessPreload } from '../../../src/main/openclaw/runtime/launch/electronNodeRuntime';

const runtime = path.resolve(
  process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR ?? 'vendor/openclaw-runtime/current',
);
const sdk = path.join(runtime, 'dist/plugin-sdk');
const available = fs.existsSync(path.join(sdk, 'secret-ref-runtime.js'));

test.skipIf(!available)('the managed model provider uses the published native SDK contract', () => {
  const options: ts.CompilerOptions = {
    noEmit: true, strict: true, skipLibCheck: true, allowJs: true, checkJs: false,
    esModuleInterop: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, types: ['node'],
    typeRoots: [path.resolve('node_modules/@types')], baseUrl: path.resolve('.'),
    paths: { 'openclaw/plugin-sdk/*': [path.join(sdk, '*')] },
  };
  const program = ts.createProgram([path.resolve('plugins/extensions/runtime-services/model-auth.ts')], options);
  const errors = ts.getPreEmitDiagnostics(program)
    .filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
    .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '));
  expect(errors).toEqual([]);
}, 30_000);

test.skipIf(!available)('a native task crosses a 30-minute JWT expiry and cannot borrow a replacement login', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-auth 测试 '));
  try {
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
    const now = Math.floor(Date.now() / 1000);
    const jwt = (id: string, expiresAt: number) => [
      Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url'),
      Buffer.from(JSON.stringify({ sub: 'fixture-account', iat: now, exp: expiresAt, jti: id })).toString('base64url'),
      'fixture-signature',
    ].join('.');
    const firstToken = jwt('first', now + 1800);
    const secondToken = jwt('second', now + 3600);
    const session = 'a'.repeat(32);
    const baseUrl = 'https://models.invalid/v1';
    const { config } = syncBuiltinCredentialFile({
      models: { providers: { builtin_models: {
        baseUrl, api: 'openai-completions',
        apiKey: { source: 'exec', provider: 'justdo_login', id: 'X-ACCESS-JWT' },
      } } },
    }, directory, { accessToken: firstToken, userAccount: 'fixture-account', expiresAt: now + 1800 }, process.execPath, session);
    const snapshot = (token: string, authSessionId: string) => sealBuiltinCredential(JSON.stringify({
      accessToken: token, userAccount: 'fixture-account', expiresAt: now + 3600, authSessionId,
    })).toString('base64');
    const credentialFile = path.join(directory, 'credentials/credentials.bin');
    const preload = path.join(directory, 'preload.cjs');
    fs.writeFileSync(preload, buildWindowsChildProcessPreload());
    const url = (file: string) => JSON.stringify(pathToFileURL(file).href);
    const script = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      import vm from 'node:vm';
      import { buildBuiltinModelAuthProvider } from ${url(providerFile)};
      import { createAiTransportHost, runWithAiTransportHost } from ${url(path.join(runtime, 'node_modules/@openclaw/ai/dist/index.mjs'))};
      import { createOpenAICompletionsTransportStreamFn } from ${url(path.join(runtime, 'node_modules/@openclaw/ai/dist/transports.mjs'))};
      const dist = ${JSON.stringify(path.join(runtime, 'dist'))};
      const chunks = fs.readdirSync(dist).filter(name => /^session-boundary-prompt-cache-key-[A-Za-z0-9_-]+\\.mjs$/.test(name));
      assert.equal(chunks.length, 1, 'target stream-resolution chunk must have one owner');
      const chunk = chunks[0];
      const source = fs.readFileSync(path.join(dist, chunk), 'utf8');
      const extract = name => {
        const declaration = (name === 'resolveEmbeddedAgentApiKey' ? 'async ' : '') + 'function ' + name + '(';
        const start = source.indexOf(declaration);
        assert.ok(start >= 0, 'native function required: ' + name);
        assert.equal(source.indexOf(declaration, start + 1), -1, 'unique native function required');
        const end = source.indexOf(String.fromCharCode(10) + '}', start);
        assert.ok(end > start, 'native function must have a complete body');
        return source.slice(start, end + 2);
      };
      const native = vm.runInNewContext(extract('resolveEmbeddedAgentApiKey') + '\\n' +
        extract('wrapEmbeddedAgentStreamApiKey') + '\\nwrapEmbeddedAgentStreamApiKey');
      const capturedConfig = ${JSON.stringify(config)};
      const first = ${JSON.stringify(firstToken)};
      const second = ${JSON.stringify(secondToken)};
      let logicalTime = ${now};
      let expected = first;
      let requests = 0;
      let wireFailure;
      const host = createAiTransportHost({ buildModelFetch: () => async (_url, init) => {
        try {
          requests++;
          const headers = new Headers(init.headers);
          assert.equal(headers.get('authorization'), 'Bearer ' + expected);
          assert.equal(headers.get('x-access-jwt'), expected);
          assert.ok(JSON.parse(Buffer.from(expected.split('.')[1], 'base64url')).exp > logicalTime);
          const event = (delta, finish_reason) => 'data: ' + JSON.stringify({
            id: 'fixture', object: 'chat.completion.chunk', created: logicalTime, model: 'fixture',
            choices: [{ index: 0, delta, finish_reason }],
          }) + '\\n\\n';
          return new Response(event({ role: 'assistant', content: 'ok' }, null) + event({}, 'stop') + 'data: [DONE]\\n\\n',
            { headers: { 'content-type': 'text/event-stream' } });
        } catch (error) { wireFailure = error; throw error; }
      } });
      const model = {
        id: 'fixture', name: 'Fixture', provider: 'builtin_models', api: 'openai-completions',
        baseUrl: ${JSON.stringify(baseUrl)}, reasoning: false, input: ['text'], contextWindow: 8192,
        maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        headers: { 'X-ACCESS-JWT': first },
      };
      const context = { messages: [{ role: 'user', content: 'fixture', timestamp: Date.now() }] };
      const transport = createOpenAICompletionsTransportStreamFn();
      const provider = buildBuiltinModelAuthProvider();
      const wrap = cfg => native(provider.wrapStreamFn({
        config: cfg, provider: 'builtin_models', modelId: 'fixture', model, streamFn: transport,
      }), { providerId: 'builtin_models', resolvedApiKey: first,
        authStorage: { getApiKey: async () => { throw new Error('The native wrapper must retain its captured key in this reproduction'); } } });
      const sameTask = wrap(capturedConfig);
      const request = async stream => {
        const events = await stream(model, context, { apiKey: first, timeoutMs: 5000 });
        let done = false;
        for await (const event of events) {
          if (event.type === 'error') throw wireFailure ?? new Error(event.error?.errorMessage ?? 'transport failed');
          if (event.type === 'done') done = true;
        }
        assert.equal(done, true);
      };
      const publish = value => fs.writeFileSync(${JSON.stringify(credentialFile)}, Buffer.from(value, 'base64'));
      await runWithAiTransportHost(host, async () => {
        await request(sameTask);
        logicalTime += 1801;
        assert.ok(JSON.parse(Buffer.from(first.split('.')[1], 'base64url')).exp < logicalTime);
        publish(${JSON.stringify(snapshot(secondToken, session))});
        expected = second;
        await request(sameTask);
        assert.equal(requests, 2, 'same admitted task sends exactly one request per invocation');
        fs.unlinkSync(${JSON.stringify(credentialFile)});
        await assert.rejects(request(sameTask), /Managed model credentials are unavailable/);
        publish(${JSON.stringify(snapshot(secondToken, 'b'.repeat(32)))});
        await assert.rejects(request(sameTask), /Managed model credentials are unavailable/);
        assert.equal(requests, 2, 'revoked task cannot send under the replacement login');
        const replacement = structuredClone(capturedConfig);
        replacement.secrets.providers.justdo_login.env[${JSON.stringify(MODEL_AUTH_SESSION_ENV)}] = 'b'.repeat(32);
        await request(wrap(replacement));
        assert.equal(requests, 3);
      });
      assert.equal(model.headers['X-ACCESS-JWT'], first, 'captured run model remains immutable');
      process.stdout.write('verified-native-rotation-and-revocation');
    `;
    const output = execFileSync(process.execPath, ['--require', preload, '--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 30_000, windowsHide: true,
      env: { ...process.env, OPENCLAW_STATE_DIR: directory, OPENCLAW_CONFIG_PATH: path.join(directory, 'openclaw.json') },
    });
    expect(output).toContain('verified-native-rotation-and-revocation');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 35_000);
