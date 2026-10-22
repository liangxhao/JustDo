import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

vi.mock('openclaw/plugin-sdk/extension-shared', () => ({ formatPluginConfigIssue: String }));
vi.mock('openclaw/plugin-sdk/state-paths', () => ({ resolveStateDir: () => '/native-state' }));
vi.mock('openclaw/plugin-sdk/string-coerce-runtime', () => ({
  normalizeLowercaseStringOrEmpty: (value: string) => value.trim().toLowerCase(),
  isRecord: (value: unknown) =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value),
}));
vi.mock('openclaw/plugin-sdk/json-store', () => ({ readJsonFileWithFallback: vi.fn() }));

import { prepareAcpxCodexAuthConfig } from '../src/codex-auth-bridge.js';
import { resolveAcpxPluginConfig } from '../src/config.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(kind: string, extension = 'mjs') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'acp shim 中文 %ACP_SHIM_EXPANSION% & !-'));
  roots.push(root);
  vi.stubEnv('ACP_SHIM_EXPANSION', 'must not expand');
  const cli = path.join(root, 'global', 'node_modules', '.pnpm', 'fixture', 'cli.' + extension);
  const shim = path.join(root, 'claude.cmd');
  const adapter = path.join(root, 'adapter.mjs');
  await fs.mkdir(path.dirname(cli), { recursive: true });
  const main = extension === 'cjs' ? 'require.main === module' : 'import.meta.main';
  const imports =
    extension === 'cjs' ? 'const fs = require("node:fs");' : 'import fs from "node:fs";';
  await fs.writeFile(
    cli,
    '#!/usr/bin/env node\n' +
      imports +
      '\n' +
      'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input: fs.readFileSync(0, "utf8"), main: ' +
      main +
      ' }));\n' +
      'process.stderr.write("agent stderr"); process.exitCode = 7;\n',
  );
  await fs.writeFile(
    adapter,
    'import { spawnSync } from "node:child_process";\n' +
      'const child = spawnSync(process.execPath, [process.env.CLAUDE_CODE_EXECUTABLE, ...process.argv.slice(2)], { stdio: "inherit", windowsHide: true });\n' +
      'process.exit(child.status ?? 1);\n',
  );
  const relative = path.relative(root, cli).replaceAll('/', '\\');
  let fixed: string[] = [];
  if (kind === 'npm') {
    const cmdShim = require(path.resolve('node_modules/npm/node_modules/cmd-shim'));
    await cmdShim(cli, path.join(root, 'claude'));
  } else if (kind === 'pnpm') {
    fixed = ['--managed-prefix', '中文 固定 & 参数'];
    await fs.writeFile(
      shim,
      '@SETLOCAL\r\n@IF NOT DEFINED NODE_PATH (\r\n@SET "NODE_PATH=fixture"\r\n) ELSE (\r\n@SET "NODE_PATH=fixture;%NODE_PATH%"\r\n)\r\n' +
        '@"node.exe" "%~dp0\\' +
        relative +
        '" "--managed-prefix" "中文 固定 & 参数" %*\r\n',
    );
  } else if (kind === 'yarn') {
    fixed = ['--managed-prefix'];
    await fs.writeFile(
      shim,
      '@IF EXIST "%~dp0\\node.exe" (\r\n"%~dp0\\node.exe" "%~dp0\\' +
        relative +
        '" "--managed-prefix" %*\r\n) ELSE (\r\n@SETLOCAL\r\n@SET PATHEXT=%PATHEXT:;.JS;=;%\r\nnode "%~dp0\\' +
        relative +
        '" "--managed-prefix" %*\r\n)\r\n',
    );
  } else if (kind === 'custom') {
    fixed = ['--configured-prefix', ''];
    await fs.writeFile(
      shim,
      '@echo off\r\n@node "%~dp0\\' + relative + '" "--configured-prefix" "" %*\r\n',
    );
  } else if (kind === 'nested') {
    fixed = ['--inner-prefix', '--outer-prefix'];
    await fs.writeFile(
      path.join(root, 'inner.cmd'),
      '@node "%~dp0\\' + relative + '" "--inner-prefix" %*\r\n',
    );
    await fs.writeFile(shim, '@"%~dp0\\inner.cmd" "--outer-prefix" %*\r\n');
  }
  vi.stubEnv('CLAUDE_CODE_EXECUTABLE', shim);
  const prepared = await prepareAcpxCodexAuthConfig({
    stateDir: root,
    enabledAgents: new Set(['claude']),
    pluginConfig: resolveAcpxPluginConfig({ rawConfig: {}, workspaceDir: root, stateDir: root }),
    resolveInstalledClaudeAcpBinPath: async () => adapter,
  });
  return { root, cli, shim, adapter, fixed, command: prepared.agents.claude };
}

it.runIf(process.platform === 'win32').each([
  ['npm', 'mjs'],
  ['pnpm', 'mjs'],
  ['yarn', 'mjs'],
  ['custom', 'cjs'],
  ['nested', 'cjs'],
])(
  'runs the %s local shim with exact argv, streams, main-module semantics and exit code',
  async (kind, extension) => {
    const prepared = await fixture(kind, extension);
    const [command, ...args] = prepared.command;
    const forwarded = [
      '',
      '  exact argv  ',
      '中文 空格 %ACP_SHIM_EXPANSION% & !',
      '" & echo INJECTED & "',
      'tail\\',
      'line\nbreak',
    ];
    const result = spawnSync(command, [...args, ...forwarded], {
      encoding: 'utf8',
      input: 'stream input 中文\n',
      timeout: 10_000,
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(7);
    expect(JSON.parse(result.stdout)).toEqual({
      args: [...prepared.fixed, ...forwarded],
      input: 'stream input 中文\n',
      main: true,
    });
    expect(result.stderr).toBe('agent stderr');
  },
);

it
  .runIf(process.platform === 'win32')
  .each([
    'dynamic',
    'business',
    'ambiguous',
    'interpreter-flags',
    'early-exit',
    'sequential',
    'label',
    'exit',
  ] as const)(
  'rejects the %s batch contract without launching its adapter or a command shell',
  async kind => {
    const prepared = await fixture('custom');
    const entry = '%~dp0\\' + path.relative(prepared.root, prepared.cli).replaceAll('/', '\\');
    const invocation = '@node "' + entry + '" %*\r\n';
    const source = {
      dynamic: '@node "%CUSTOM_CLI%" %*\r\n',
      business: '@echo side effect\r\n' + invocation,
      'interpreter-flags': '@node --no-warnings "' + entry + '" %*\r\n',
      'early-exit': '@goto skip\r\n' + invocation + ':skip\r\nexit /b\r\n',
      sequential: invocation + invocation,
      label: ':start\r\n' + invocation,
      exit: '@exit /b\r\n' + invocation,
      ambiguous: invocation + '@node "' + entry + '" "different" %*\r\n',
    }[kind];
    await fs.writeFile(prepared.shim, source);
    const [command, ...args] = prepared.command;
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('configure its actual local .js/.mjs/.cjs or .exe path');
  },
);

it.runIf(process.platform === 'win32')(
  'rejects altered npm control flow instead of recognizing isolated boilerplate lines',
  async () => {
    const prepared = await fixture('npm');
    const source = await fs.readFile(prepared.shim, 'utf8');
    await fs.writeFile(prepared.shim, source.replace('GOTO start', 'GOTO find_dp0'));
    const [command, ...args] = prepared.command;
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('configure its actual local .js/.mjs/.cjs or .exe path');
  },
);

it.runIf(process.platform === 'win32')(
  'keeps a fixed-argument CLI in the process directly stopped by the SDK',
  async () => {
    const prepared = await fixture('pnpm');
    await fs.writeFile(prepared.adapter, 'console.log(process.env.CLAUDE_CODE_EXECUTABLE);');
    const [command, ...args] = prepared.command;
    const wrapper = spawnSync(command, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10_000,
    });
    expect(wrapper.status).toBe(0);
    const bridge = wrapper.stdout.trim();
    await fs.writeFile(
      prepared.cli,
      'process.stdout.write(JSON.stringify({ pid: process.pid, args: process.argv.slice(2), main: import.meta.main }) + "\\n");\nsetInterval(() => {}, 1_000);\n',
    );
    const child = spawn(process.execPath, [bridge, 'forwarded'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    try {
      const ready = await new Promise<{ pid: number; args: string[]; main: boolean }>(
        (resolve, reject) => {
          let output = '';
          const timer = setTimeout(() => reject(new Error('CLI did not start')), 5_000);
          child.once('error', reject);
          child.stdout.on('data', chunk => {
            output += chunk.toString();
            if (output.includes('\n')) {
              clearTimeout(timer);
              resolve(JSON.parse(output.split('\n')[0]));
            }
          });
        },
      );
      expect(ready).toEqual({ pid: child.pid, args: [...prepared.fixed, 'forwarded'], main: true });
      const stopped = once(child, 'exit');
      child.kill('SIGTERM');
      await stopped;
      expect(() => process.kill(ready.pid, 0)).toThrow();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  },
);
