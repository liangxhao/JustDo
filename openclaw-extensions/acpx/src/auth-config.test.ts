import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parse } from 'smol-toml';
import { afterEach, expect, it, vi } from 'vitest';

import { OPENCLAW_CODEX_CONFIG_ARG } from './codex-adapter.js';
import { prepareAcpxCodexAuthConfig } from './codex-auth-bridge.js';
import { resolveAcpxPluginConfig } from './config.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })),
  );
});

it('preserves isolated TOML settings and merges generated config without changing argv', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acpx-auth-config-'));
  directories.push(root);
  const sourceHome = path.join(root, 'source');
  const stateDir = path.join(root, 'state');
  const cwd = path.join(root, '中文 project');
  const peer = path.join(root, 'fixture adapter.mjs');
  await fs.mkdir(sourceHome);
  await fs.mkdir(cwd);
  await fs.writeFile(
    path.join(sourceHome, 'config.toml'),
    [
      'model = "fixture-model"',
      'model_provider = "fixture-provider"',
      'model_reasoning_effort = "high"',
      'large_setting = "' + 'value'.repeat(5_000) + '"',
      '[model_providers.fixture-provider]',
      'name = "Fixture"',
      'base_url = "http://127.0.0.1:1/unused"',
      'env_key_instructions = "' + 'value'.repeat(5_000) + '"',
    ].join('\n'),
  );
  await fs.writeFile(
    peer,
    'console.log(JSON.stringify({ config: JSON.parse(process.env.CODEX_CONFIG), args: process.argv.slice(2) }));',
  );
  vi.stubEnv('CODEX_HOME', sourceHome);
  vi.stubEnv('CODEX_API_KEY', '');
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('CODEX_CONFIG', JSON.stringify({ model: 'before', nested: { inherited: true } }));
  const config = await prepareAcpxCodexAuthConfig({
    stateDir,
    enabledAgents: new Set(['codex']),
    pluginConfig: resolveAcpxPluginConfig({ rawConfig: {}, workspaceDir: cwd, stateDir }),
    resolveInstalledCodexAcpBinPath: async () => peer,
  });
  const isolated = parse(
    await fs.readFile(path.join(stateDir, 'acpx/codex-home/config.toml'), 'utf8'),
  );
  expect(isolated).toMatchObject({
    model: 'fixture-model',
    model_provider: 'fixture-provider',
    model_reasoning_effort: 'high',
  });
  expect(isolated.large_setting).toBeUndefined();
  expect(isolated.model_providers).toMatchObject({
    'fixture-provider': { env_key_instructions: 'value'.repeat(5_000) },
  });
  expect(isolated.projects).toEqual(expect.objectContaining({ [cwd]: { trust_level: 'trusted' } }));
  const [executable, ...argv] = config.agents.codex;
  const result = spawnSync(
    executable,
    [
      ...argv,
      OPENCLAW_CODEX_CONFIG_ARG,
      JSON.stringify({ model: 'after', nested: { generated: true } }),
      '',
      '  exact argv  ',
    ],
    { encoding: 'utf8', timeout: 10_000, windowsHide: true },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    config: { model: 'after', nested: { inherited: true, generated: true } },
    args: ['', '  exact argv  '],
  });
});
