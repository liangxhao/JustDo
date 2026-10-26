import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from 'vitest';

const { readOpenClawSourceLock, verifyOpenClawPatchManifest } =
  require('../../../scripts/openclaw/verify-openclaw-runtime-patches.cjs');
const { verifyBundledDependencies } = require('../../../scripts/openclaw/openclaw-bundled-dependencies.cjs');
const root = path.resolve(__dirname, '../../..');
const runtime = process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR;
if (process.env.OPENCLAW_REQUIRE_BUNDLED_DEPENDENCIES === '1' && !runtime)
  throw new Error('The bundled dependency contract requires the explicit frozen runtime.');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).openclaw.version;
const sourceLock = readOpenClawSourceLock(root, version);
const hash = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// These come from the exact target upstream's package-bundled-mcp contract,
// independently of the artifact under test and its generated proof.
const patchedChromeFiles: Record<string, string> = {
  'build/src/TextSnapshot.js': '299833ad0e4cfc171a417afaec41df594e4862fe53a7ada6ba160409f979788b',
  'build/src/McpPage.js': '47aa13c6b28cc11e1b0883532edea97cfde7563d78d143035850852d09809975',
  'build/src/OPENCLAW_PATCH_NOTICE.md': '4bf44b52a80b5860b2160bc83407a5f0dd09f1801c85d0a2b6e4fec26bd7045d',
  LICENSE: '58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd',
  'build/src/third_party/THIRD_PARTY_NOTICES': '6ae0ce181dbc9ba4217b6aad679d7503ed3ab56c45e6f3647e9ab753aa97b67b',
};

test.skipIf(!runtime)('the frozen native Browser resolves the complete patched bundled Chrome CLI', () => {
  const selected = fs.realpathSync(runtime!);
  const manifest = verifyOpenClawPatchManifest(selected, { repoRoot: root });
  const proof = verifyBundledDependencies(selected, { sourceLock });
  expect(proof.dependencies.map((dependency: { name: string }) => dependency.name)).toEqual(['chrome-devtools-mcp']);
  const dependency = proof.dependencies[0];
  expect(dependency.version).toBe('1.10.1');
  expect(dependency.path).toBe('node_modules/chrome-devtools-mcp');
  expect(dependency.files).toHaveLength(360);
  expect(dependency.baseOrigin.inBundle).toBe(true);
  for (const [relative, expected] of Object.entries(patchedChromeFiles)) {
    expect(hash(path.join(selected, dependency.path, relative)), relative).toBe(expected);
    expect(dependency.files.find((file: { path: string }) => file.path === relative)?.sha256).toBe(expected);
  }

  const dist = path.join(selected, 'dist');
  const candidates = fs.readdirSync(dist).filter(file => /^chrome-mcp-options-.+\.mjs$/u.test(file) &&
    fs.readFileSync(path.join(dist, file), 'utf8').includes('function normalizeChromeMcpOptions('));
  expect(candidates).toHaveLength(1);
  const optionsFile = path.join(dist, candidates[0]);
  const alias = fs.readFileSync(optionsFile, 'utf8').match(/\bnormalizeChromeMcpOptions as ([\w$]+)\b/u)?.[1];
  expect(alias).toBeTruthy();
  const executable = path.join(selected, 'node-runtime', process.platform === 'win32' ? 'node.exe' : 'bin/node');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-browser-contract-'));
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !/^OPENCLAW_/iu.test(name) && !/^(?:NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE)$/iu.test(name)));
    const appData = path.join(profile, 'app-data'), localAppData = path.join(profile, 'local-app-data');
    fs.mkdirSync(appData); fs.mkdirSync(localAppData);
    const scoped = { ...env, HOME: profile, USERPROFILE: profile, APPDATA: appData, LOCALAPPDATA: localAppData, OPENCLAW_HOME: profile,
      OPENCLAW_STATE_DIR: profile, OPENCLAW_CONFIG_PATH: path.join(profile, 'openclaw.json'),
      CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1', CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1' };
    const script = `
      import assert from 'node:assert/strict';
      import { ${alias} as normalize } from ${JSON.stringify(pathToFileURL(optionsFile).href)};
      const actual = normalize();
      assert.equal(actual.command, process.execPath);
      assert.equal(actual.env.CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS, '1');
      console.log(JSON.stringify({ command: actual.command, cli: actual.args[0] }));`;
    const resolved = JSON.parse(execFileSync(executable, ['--input-type=module', '-e', script], {
      cwd: selected, env: scoped, encoding: 'utf8', windowsHide: true, timeout: 15_000,
    }));
    const expectedCli = path.join(selected, dependency.path, 'build/src/bin/chrome-devtools-mcp.js');
    expect(fs.realpathSync(resolved.cli)).toBe(fs.realpathSync(expectedCli));
    expect(execFileSync(executable, [resolved.cli, '--version'], {
      cwd: selected, env: scoped, encoding: 'utf8', windowsHide: true, timeout: 15_000,
    }).trim()).toBe('1.10.1');
    expect(verifyOpenClawPatchManifest(selected, { repoRoot: root })).toEqual(manifest);
    expect(verifyBundledDependencies(selected, { sourceLock })).toEqual(proof);
  } finally {
    expect(path.dirname(profile)).toBe(os.tmpdir());
    expect(path.basename(profile)).toMatch(/^bundled-browser-contract-/u);
    fs.rmSync(profile, { recursive: true, force: true });
  }
}, 60_000);

test.skipIf(!runtime)('the real bundled proof rejects stock Chrome bytes without touching the frozen runtime', () => {
  const selected = fs.realpathSync(runtime!);
  const proof = verifyBundledDependencies(selected, { sourceLock });
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-chrome-tamper-'));
  try {
    for (const relative of ['package.json', 'npm-shrinkwrap.json', 'runtime-bundled-dependencies.json'])
      fs.copyFileSync(path.join(selected, relative), path.join(fixture, relative));
    const dependency = proof.dependencies[0];
    fs.cpSync(path.join(selected, dependency.path), path.join(fixture, dependency.path), { recursive: true });
    expect(() => verifyBundledDependencies(fixture, { sourceLock })).not.toThrow();
    // Remove the frame-qualified caller exactly as in the stock registry build;
    // retain the independently recorded whole-tree proof so this cannot re-sign.
    const page = path.join(fixture, dependency.path, 'build/src/McpPage.js');
    const original = fs.readFileSync(page, 'utf8');
    const call = 'resolveCdpElementId(backendNodeId, elementHandle.frame)';
    expect(original.split(call)).toHaveLength(2);
    fs.writeFileSync(page, original.replace(call, 'resolveCdpElementId(backendNodeId)'));
    expect(() => verifyBundledDependencies(fixture, { sourceLock })).toThrow(/bundled|tree|mismatch|changed/i);
    expect(verifyBundledDependencies(selected, { sourceLock })).toEqual(proof);
  } finally {
    expect(path.dirname(fixture)).toBe(os.tmpdir());
    expect(path.basename(fixture)).toMatch(/^bundled-chrome-tamper-/u);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
