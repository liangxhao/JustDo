import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveNativeSmokeTarget } from './native-smoke-target.mjs';

const require = createRequire(import.meta.url);
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const { runtimeRoot } = resolveNativeSmokeTarget();

test('actual fs-safe 0.25 plugin install recovers one Windows no-DELETE publication refusal', {
  skip: process.platform !== 'win32',
}, async () => {
  const artifacts = path.join(repository, '.agent-tasks/runtime/plugin-publication-lock');
  fs.mkdirSync(artifacts, { recursive: true });
  const root = fs.mkdtempSync(path.join(artifacts, 'native-中文 空格-'));
  const state = path.join(root, 'state');
  const source = path.join(root, 'source');
  const target = path.join(state, 'extensions/import-probe-update');
  const previous = { ...process.env };
  try {
    for (const key of Object.keys(process.env))
      if (key.toUpperCase().startsWith('OPENCLAW_')) delete process.env[key];
    Object.assign(process.env, {
      OPENCLAW_HOME: root, OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: path.join(root, 'openclaw.json'),
      PLUGIN_COPY_OBSERVER_RUN: root,
    });
    fs.mkdirSync(state);
    fs.mkdirSync(source);
    fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify({
      agents: { entries: { main: {} }, defaults: { embeddedAgent: { cyberFailover: { mode: 'off' } } } },
      plugins: { enabled: false },
    }));
    const contents = 'export const version = 2;\n';
    fs.writeFileSync(path.join(source, 'index.mjs'), contents);
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({
      name: 'import-probe-update', version: '1.1.0', type: 'module',
      openclaw: { extensions: ['./index.mjs'] },
    }));
    assert.equal(JSON.parse(fs.readFileSync(path.join(runtimeRoot,
      'node_modules/@openclaw/fs-safe/package.json'), 'utf8')).version, '0.25.0');
    const preload = path.join(repository, 'tests/electron/plugin-marketplace/publication-lock-preload.cjs');
    require(preload).install({
      helperScript: path.join(repository, 'tests/electron/plugin-marketplace/hold-publication-file.ps1'),
      holdMs: 800, scenario: 'recovered',
    });
    const dist = path.join(runtimeRoot, 'dist');
    const owners = fs.readdirSync(dist).filter(name => /^npm-managed-root-[A-Za-z0-9_-]+\.mjs$/.test(name));
    assert.equal(owners.length, 1);
    const module = await import(pathToFileURL(path.join(dist, owners[0])).href);
    const functions = Object.values(module).filter(value =>
      typeof value === 'function' && value.name === 'installPluginDirectoryIntoExtensions');
    assert.equal(functions.length, 1);
    const result = await functions[0]({
      sourceDir: source, targetDir: target, mode: 'install', hasDeps: false,
      pluginId: 'import-probe-update', manifestName: 'import-probe-update', version: '1.1.0',
      extensions: ['./index.mjs'], copyErrorPrefix: 'Fixture plugin installation failed',
      timeoutMs: 30_000, workTimeoutMs: 30_000,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(fs.readFileSync(path.join(target, 'index.mjs'), 'utf8'), contents);
    assert.equal(fs.readFileSync(path.join(source, 'index.mjs'), 'utf8'), contents);
    const traces = () => fs.readdirSync(root).filter(name => /^controlled-publication-lock-.*\.json$/.test(name))
      .flatMap(name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')).probes);
    const deadline = Date.now() + 10_000;
    while (!traces()[0]?.helperExit && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 20));
    const probes = traces();
    assert.equal(probes.length, 1, 'one actual copied stage was locked');
    const probe = probes[0];
    assert.equal(probe.helperReady.success, true);
    assert.equal(probe.helperReady.shareMode, 3);
    assert.equal(probe.helperReady.sharesDelete, false);
    assert.equal(probe.helperClosed.released, true);
    assert.equal(probe.helperClosed.timedOut, false);
    assert.equal(probe.helperExit.code, 0);
    assert.ok(probe.attempts.length > 1);
    assert.equal(probe.attempts[0].error.code, 'EPERM');
    assert.equal(probe.attempts.at(-1).success, true);
    assert.ok(probe.attempts.slice(0, -1).every(attempt => attempt.success === false));
    assert.ok(probe.attempts.every(attempt =>
      attempt.sourceIdentity.dev === probe.sourceIdentity.dev && attempt.sourceIdentity.ino === probe.sourceIdentity.ino));
    assert.equal(probe.attempts.at(-1).targetAfter.ino, probe.sourceIdentity.ino);
    assert.equal(probe.attempts.at(-1).targetAfter.dev, probe.sourceIdentity.dev);
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({
      passed: true, result, probe,
      gatewayBundleSha256: createHash('sha256').update(fs.readFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'))).digest('hex'),
    }, null, 2));
    console.log(`PUBLICATION_LOCK_EVIDENCE=${path.join(root, 'result.json')}`);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
