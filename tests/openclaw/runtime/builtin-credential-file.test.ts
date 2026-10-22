import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test, vi } from 'vitest';
vi.mock('electron', () => ({ app: { getName: () => 'JustDo', getPath: () => '', isPackaged: false } }));
import { sealBuiltinCredential,syncBuiltinCredentialFile } from '../../../src/main/openclaw/config/models/builtinCredentialFile';
import { buildBuiltinMemorySearchConfig,buildProviderSelection } from '../../../src/main/openclaw/config/openclawConfigSync';
import { buildWindowsChildProcessPreload } from '../../../src/main/openclaw/runtime/launch/electronNodeRuntime';

const dist = path.resolve('vendor/openclaw-runtime/current/dist');
test.skipIf(!fs.existsSync(dist))('native JWT references protect tokens without redacting ordinary account identity', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-native-builtin 测试 '));
  try {
    const preload = path.join(directory, 'hide-child-process-windows.cjs');
    fs.writeFileSync(preload, buildWindowsChildProcessPreload());
    const resolver = fs.readdirSync(dist).filter(name => /^resolve-.*\.m?js$/.test(name)).find(name =>
      fs.readFileSync(path.join(dist, name), 'utf8').includes(
        'export { isMissingSecretRefResolutionError, isProviderScopedSecretResolutionError, resolveSecretRefString,',
      ),
    );
    expect(resolver).toBeDefined();
    const runtimeModule = fs.readdirSync(dist).filter(name => /^runtime-.*\.m?js$/.test(name)).find(name =>
      fs.readFileSync(path.join(dist, name), 'utf8').includes('export { activateSecretsRuntimeSnapshot,'),
    );
    const redactionModule = fs.readdirSync(dist).filter(name => /^redact-.*\.m?js$/.test(name)).find(name =>
      fs.readFileSync(path.join(dist, name), 'utf8').includes('export { captureSensitiveTextRedactionSnapshot,'),
    );
    expect(runtimeModule).toBeDefined();
    expect(redactionModule).toBeDefined();
    const provider = buildProviderSelection({
      apiKey: '', baseURL: 'http://127.0.0.1:9/v1', modelId: 'fixture', apiType: 'openai', providerName: 'builtin_models',
    }).providerConfig;
    const { config } = syncBuiltinCredentialFile({
      gateway: { mode: 'local' }, plugins: { enabled: false },
      agents: { entries: { main: {} }, defaults: { systemAgent: { agentId: 'main' } } },
      models: { mode: 'replace', providers: { builtin_models: provider } },
      memory: { search: buildBuiltinMemorySearchConfig([{
        providerName: 'builtin_models', apiKey: '', baseURL: 'http://127.0.0.1:9/v1', apiType: 'openai',
        models: [{ id: 'fixture' }], embeddingModels: [{ id: 'embedding-fixture' }],
      }]) },
    }, directory, { accessToken: 'jwt-fixture-one', userAccount: 'user-fixture', expiresAt: Math.floor(Date.now() / 1000) + 300 }, process.execPath, 'a'.repeat(32));
    const rotatedSnapshot = sealBuiltinCredential(JSON.stringify({ accessToken: 'jwt-fixture-two', userAccount: 'user-fixture', expiresAt: Math.floor(Date.now() / 1000) + 300, authSessionId: 'a'.repeat(32) }));
    const url = (name: string) => JSON.stringify(pathToFileURL(path.join(dist, name)).href);
    const script = `
      import fs from 'node:fs';
      import { resolveSecretRefString } from ${url(resolver!)};
      import { validateConfigObjectRaw } from ${url('config/config.js')};
      import { setRuntimeConfigSnapshot } from ${url('plugin-sdk/runtime-config-snapshot.js')};
      import { ensureOpenClawModelsJson } from ${url('agents/models-config.runtime.js')};
      import { prepareSecretsRuntimeSnapshot } from ${url(runtimeModule!)};
      import { redactToolPayloadTextWithConfig } from ${url(redactionModule!)};
      const source = ${JSON.stringify(config)};
      const validation = validateConfigObjectRaw(source);
      if (!validation.ok) throw new Error(JSON.stringify(validation.issues));
      const key = await resolveSecretRefString(source.models.providers.builtin_models.apiKey, {config: source, env: process.env});
      if (key !== 'jwt-fixture-one') throw new Error('Resolution mismatch');
      const { config: runtime } = await prepareSecretsRuntimeSnapshot({
        config: source, env: process.env, includeAuthStoreRefs: false,
        agentDirs: [${JSON.stringify(path.join(directory, 'agent'))}],
      });
      if ('X-User-Account' in runtime.models.providers.builtin_models.headers) throw new Error('Account header still projected');
      if (runtime.models.providers.builtin_models.headers['X-ACCESS-JWT'] !== key) throw new Error('JWT header mismatch');
      const userText = '用户名是user-fixture';
      if (redactToolPayloadTextWithConfig(userText, {}) !== userText) throw new Error('Ordinary account was registered as secret');
      if (redactToolPayloadTextWithConfig(key, {}) === key) throw new Error('JWT redaction was lost');
      const embeddingKey = await resolveSecretRefString(source.memory.search.remote.apiKey, {config: source, env: process.env});
      if (embeddingKey !== key) throw new Error('Embedding authentication mismatch');
      setRuntimeConfigSnapshot(runtime, source);
      const agentDir = ${JSON.stringify(path.join(directory, 'agent'))};
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(agentDir + '/models.json', JSON.stringify({
        providers: {
          builtin_models: {
            ...runtime.models.providers.builtin_models,
            apiKey: 'secretref-managed',
            headers: { 'X-ACCESS-JWT': 'secretref-managed', 'X-User-Account': 'secretref-managed' },
          },
        },
      }));
      await ensureOpenClawModelsJson(runtime, agentDir);
      const contents = fs.readFileSync(agentDir + '/models.json', 'utf8');
      if (contents.includes(key)) throw new Error('Secret persisted in model cache');
      const marker = JSON.parse(contents).providers.builtin_models.apiKey;
      if (marker !== 'secretref-managed') throw new Error('Unexpected cache marker');
      if (contents.includes('user-fixture') || contents.includes('X-User-Account')) throw new Error('Account persisted in model cache');
      fs.writeFileSync(${JSON.stringify(path.join(directory, 'credentials', 'credentials.bin'))}, Buffer.from(${JSON.stringify(rotatedSnapshot.toString('base64'))}, 'base64'));
      const rotated = await resolveSecretRefString(source.models.providers.builtin_models.apiKey, {config: source, env: process.env});
      if (rotated !== 'jwt-fixture-two') throw new Error('JWT did not rotate');
      process.stdout.write('verified');
    `;
    const output = execFileSync(process.execPath, ['--require', preload, '--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 30_000, windowsHide: true,
      env: { ...process.env, OPENCLAW_STATE_DIR: directory, OPENCLAW_CONFIG_PATH: path.join(directory, 'openclaw.json') },
    });
    expect(output).toContain('verified');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 35_000);
