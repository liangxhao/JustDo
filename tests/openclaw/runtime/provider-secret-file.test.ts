import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test, vi } from 'vitest';
vi.mock('electron', () => ({ app: { getName: () => 'JustDo', getPath: () => '', isPackaged: false } }));
import { buildWindowsChildProcessPreload } from '../../../src/main/openclaw/runtime/electronNodeRuntime';

import {
  managedProviderSecretRef,
  syncProviderSecretFile,
} from '../../../src/main/openclaw/config/providerSecretFile';

const dist = path.resolve('vendor/openclaw-runtime/current/dist');

test.skipIf(!fs.existsSync(dist))('the bundled OpenClaw resolves managed file credentials without provider environment variables', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-native-provider-secret-'));
  try {
    const preload = path.join(directory, 'hide-child-process-windows.cjs');
    fs.writeFileSync(preload, buildWindowsChildProcessPreload());
    const resolver = fs.readdirSync(dist).filter(name => /^resolve-.*\.js$/.test(name)).find(name =>
      fs.readFileSync(path.join(dist, name), 'utf8').includes(
        'export { isMissingSecretRefResolutionError, isProviderScopedSecretResolutionError, resolveSecretRefString,',
      ),
    );
    expect(resolver).toBeDefined();
    const { config } = syncProviderSecretFile({
      models: { providers: { acme: { apiKey: managedProviderSecretRef('acme') } } },
    }, directory, { acme: 'native-fixture-key' });
    const script = `
      import { resolveSecretRefString } from ${JSON.stringify(pathToFileURL(path.join(dist, resolver!)).href)};
      const config = ${JSON.stringify(config)};
      const value = await resolveSecretRefString(config.models.providers.acme.apiKey, { config, env: {} });
      if (value !== 'native-fixture-key') throw new Error('Native secret resolution mismatch');
      process.stdout.write('resolved');
    `;
    expect(execFileSync(process.execPath, ['--require', preload, '--input-type=module', '-e', script], {
      encoding: 'utf8', timeout: 20_000,
    })).toBe('resolved');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 25_000);
