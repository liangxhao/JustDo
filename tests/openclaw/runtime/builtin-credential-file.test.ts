import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test, vi } from 'vitest';
vi.mock('electron', () => ({ app: { getName: () => 'JustDo', getPath: () => '', isPackaged: false } }));
import { buildWindowsChildProcessPreload } from '../../../src/main/openclaw/runtime/electronNodeRuntime';

import { BUILTIN_CREDENTIAL_MARKER } from '../../../src/main/cowork/builtinModelProviderConfig';
import { syncBuiltinCredentialFile } from '../../../src/main/openclaw/config/builtinCredentialFile';

const dist = path.resolve('vendor/openclaw-runtime/current/dist');
test.skipIf(!fs.existsSync(dist))('native exec resolution and models cache never persist the resolved builtin key', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-native-builtin 测试 '));
  try {
    const preload = path.join(directory, 'hide-child-process-windows.cjs');
    fs.writeFileSync(preload, buildWindowsChildProcessPreload());
    const resolver = fs.readdirSync(dist).filter(name => /^resolve-.*\.js$/.test(name)).find(name =>
      fs.readFileSync(path.join(dist, name), 'utf8').includes(
        'export { isMissingSecretRefResolutionError, isProviderScopedSecretResolutionError, resolveSecretRefString,',
      ),
    );
    expect(resolver).toBeDefined();
    const { config } = syncBuiltinCredentialFile({
      gateway: { mode: 'local' }, plugins: { enabled: false },
      agents: { entries: { main: {} }, defaults: { systemAgent: { agentId: 'main' } } },
      models: { providers: { builtin_models: {
        baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', apiKey: BUILTIN_CREDENTIAL_MARKER,
        models: [{ id: 'fixture', name: 'Fixture', contextWindow: 8192, maxTokens: 1024 }],
      } } },
    }, directory, () => 'native-builtin-fixture');
    const url = (name: string) => JSON.stringify(pathToFileURL(path.join(dist, name)).href);
    const script = `
      import fs from 'node:fs';
      import { resolveSecretRefString } from ${url(resolver!)};
      import { validateConfigObjectRaw } from ${url('config/config.js')};
      import { setRuntimeConfigSnapshot } from ${url('plugin-sdk/runtime-config-snapshot.js')};
      import { ensureOpenClawModelsJson } from ${url('agents/models-config.runtime.js')};
      const source = ${JSON.stringify(config)};
      const validation = validateConfigObjectRaw(source);
      if (!validation.ok) throw new Error(JSON.stringify(validation.issues));
      const invalid = structuredClone(source);
      invalid.secrets.providers['justdo-builtin'].passEnv = ['SystemRoot'];
      if (validateConfigObjectRaw(invalid).ok) throw new Error('Invalid mixed-case passEnv was accepted');
      const key = await resolveSecretRefString(source.models.providers.builtin_models.apiKey, {config: source, env: process.env});
      if (key !== 'native-builtin-fixture') throw new Error('Resolution mismatch');
      const runtime = structuredClone(source);
      runtime.models.providers.builtin_models.apiKey = key;
      setRuntimeConfigSnapshot(runtime, source);
      const agentDir = ${JSON.stringify(path.join(directory, 'agent'))};
      await ensureOpenClawModelsJson(runtime, agentDir);
      const contents = fs.readFileSync(agentDir + '/models.json', 'utf8');
      if (contents.includes(key)) throw new Error('Secret persisted in model cache');
      const marker = JSON.parse(contents).providers.builtin_models.apiKey;
      if (marker !== 'secretref-managed') throw new Error('Unexpected cache marker');
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
