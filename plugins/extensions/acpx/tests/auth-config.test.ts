import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parse } from 'smol-toml';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/extension-shared', () => ({ formatPluginConfigIssue: String }));
vi.mock('openclaw/plugin-sdk/state-paths', () => ({ resolveStateDir: () => '/native-state' }));
vi.mock('openclaw/plugin-sdk/string-coerce-runtime', () => ({
  normalizeLowercaseStringOrEmpty: (value: string) => value.trim().toLowerCase(),
  isRecord: (value: unknown) => Boolean(value) && typeof value === 'object' && !Array.isArray(value),
}));

import { OPENCLAW_CODEX_CONFIG_ARG } from '../src/codex-adapter.js';
import { prepareAcpxCodexAuthConfig } from '../src/codex-auth-bridge.js';
import { resolveAcpxPluginConfig } from '../src/config.js';

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
  vi.stubEnv('CODEX_PATH', process.execPath);
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

it.each(['codex', 'claude'] as const)('rejects a missing local %s without launching its adapter', async agent => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acpx-local-agent-'));
  directories.push(root);
  const peer = path.join(root, 'adapter.mjs');
  await fs.writeFile(peer, 'console.log("adapter must not launch");');
  vi.stubEnv('CODEX_HOME', path.join(root, 'source'));
  vi.stubEnv(agent === 'codex' ? 'CODEX_PATH' : 'CLAUDE_CODE_EXECUTABLE', path.join(root, 'missing-agent'));
  const config = await prepareAcpxCodexAuthConfig({
    stateDir: root,
    enabledAgents: new Set([agent]),
    pluginConfig: resolveAcpxPluginConfig({ rawConfig: {}, workspaceDir: root, stateDir: root }),
    resolveInstalledCodexAcpBinPath: async () => peer,
    resolveInstalledClaudeAcpBinPath: async () => peer,
  });
  const [command, ...args] = config.agents[agent];
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('not installed or not available on PATH');
});

it.each(['codex', 'claude'] as const)('passes the user-installed %s path to its transport adapter', async agent => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acpx-local-agent-'));
  directories.push(root);
  const peer = path.join(root, 'adapter.mjs');
  const envKey = agent === 'codex' ? 'CODEX_PATH' : 'CLAUDE_CODE_EXECUTABLE';
  await fs.writeFile(peer, `console.log(process.env[${JSON.stringify(envKey)}]);`);
  vi.stubEnv('CODEX_HOME', path.join(root, 'source'));
  vi.stubEnv(envKey, process.execPath);
  const config = await prepareAcpxCodexAuthConfig({
    stateDir: root,
    enabledAgents: new Set([agent]),
    pluginConfig: resolveAcpxPluginConfig({ rawConfig: {}, workspaceDir: root, stateDir: root }),
    resolveInstalledCodexAcpBinPath: async () => peer,
    resolveInstalledClaudeAcpBinPath: async () => peer,
  });
  const [command, ...args] = config.agents[agent];
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe(process.execPath);
});

it.each(['codex', 'claude'] as const)('discovers local %s on PATH without an executable override', async agent => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acpx local CLI-'));
  directories.push(root);
  const peer = path.join(root, 'adapter.mjs');
  const cli = path.join(root, agent + (process.platform === 'win32' ? '.exe' : ''));
  const envKey = agent === 'codex' ? 'CODEX_PATH' : 'CLAUDE_CODE_EXECUTABLE';
  await fs.writeFile(cli, 'fixture executable', { mode: 0o755 });
  await fs.writeFile(peer, `console.log(process.env[${JSON.stringify(envKey)}]);`);
  vi.stubEnv('PATH', root);
  vi.stubEnv('CODEX_HOME', path.join(root, 'source'));
  vi.stubEnv(envKey, '');
  const config = await prepareAcpxCodexAuthConfig({
    stateDir: root,
    enabledAgents: new Set([agent]),
    pluginConfig: resolveAcpxPluginConfig({ rawConfig: {}, workspaceDir: root, stateDir: root }),
    resolveInstalledCodexAcpBinPath: async () => peer,
    resolveInstalledClaudeAcpBinPath: async () => peer,
  });
  const [command, ...args] = config.agents[agent];
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe(cli);
});
