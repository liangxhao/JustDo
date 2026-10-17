import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

test('native staging rejects a widened surface carrying an earlier UI review token', async () => {
  assert.equal(process.versions.electron, undefined, 'Run this isolated native probe with Node.js.');
  const runtimeRoot = fs.realpathSync(path.resolve('vendor/openclaw-runtime/current'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-consent-native-'));
  const environment = { ...process.env };
  try {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('OPENCLAW_')) delete process.env[name];
    }
    process.env.OPENCLAW_HOME = root;
    process.env.OPENCLAW_STATE_DIR = path.join(root, 'state');
    process.env.OPENCLAW_CONFIG_PATH = path.join(root, 'openclaw.json');
    fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, '{}');
    const staged = path.join(root, 'package');
    fs.mkdirSync(staged);
    const pluginId = 'source-consent-fixture';
    fs.writeFileSync(path.join(staged, 'package.json'), JSON.stringify({
      name: pluginId,
      openclaw: { extensions: ['./index.js'] },
    }));
    fs.writeFileSync(path.join(staged, 'index.js'), 'throw new Error("Consent must not execute plugin code");');
    const manifestPath = path.join(staged, 'openclaw.plugin.json');
    const manifest = { id: pluginId, configSchema: { type: 'object' }, contracts: { tools: ['read'] } };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const load = async (prefix, name) => {
      const directory = path.join(runtimeRoot, 'dist');
      for (const file of fs.readdirSync(directory).filter(file => file.startsWith(prefix) && file.endsWith('.mjs'))) {
        const module = await import(pathToFileURL(path.join(directory, file)).href);
        const fn = Object.values(module).find(value => typeof value === 'function' && value.name === name);
        if (fn) return fn;
      }
      throw new Error(`Native capability export is missing: ${name}`);
    };
    const inspect = await load('capability-artifact-', 'inspectPluginCapabilityArtifact');
    const buildReview = await load('capability-summary-', 'buildPluginCapabilityConsentReview');
    const createConsent = await load('capability-consent-', 'createManagedPluginArtifactConsentHandler');
    const config = { plugins: { allow: [pluginId] } };
    const review = () => {
      const artifact = inspect(staged, process.env, { config });
      return buildReview({ pluginId, manifest: artifact.manifest, record: { source: 'path' }, config, declared: artifact.declared });
    };
    const approve = token => createConsent({
      config,
      env: process.env,
      source: 'path',
      previousRecords: {},
      acknowledgeCapabilities: { reviewToken: token },
      // This is the current Gateway's automatic-consent fallback. A supplied UI
      // acknowledgment must take precedence, including when it becomes stale.
      onCapabilityConsent: async current => ({ reviewToken: current.reviewToken }),
    });
    const artifact = { pluginId, stagedArtifactDir: staged, mode: 'install' };
    const oldReview = review();
    const disposable = path.join(root, 'another-disposable-source');
    fs.cpSync(staged, disposable, { recursive: true });
    const copiedArtifact = inspect(disposable, process.env, { config });
    const copiedReview = buildReview({
      pluginId,
      manifest: copiedArtifact.manifest,
      record: { source: 'path', spec: disposable },
      config,
      declared: copiedArtifact.declared,
    });
    assert.equal(copiedReview.reviewToken, oldReview.reviewToken);
    const unchanged = approve(oldReview.reviewToken);
    await unchanged.onBeforePluginArtifactCommit(artifact);
    assert.deepEqual(unchanged.applyAcceptedSurface(pluginId, { source: 'path' }).acceptedSurface.tools, ['read']);

    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, contracts: { tools: ['read', 'write'] } }));
    const changedReview = review();
    assert.notEqual(changedReview.reviewToken, oldReview.reviewToken);
    await assert.rejects(approve(oldReview.reviewToken).onBeforePluginArtifactCommit(artifact), error => {
      assert.equal(error.capabilityConsent?.reviewToken, changedReview.reviewToken);
      return true;
    });

    const confirmed = approve(changedReview.reviewToken);
    await confirmed.onBeforePluginArtifactCommit(artifact);
    assert.deepEqual(confirmed.applyAcceptedSurface(pluginId, { source: 'path' }).acceptedSurface.tools, ['read', 'write']);
  } finally {
    for (const name of Object.keys(process.env)) {
      if (!(name in environment)) delete process.env[name];
    }
    Object.assign(process.env, environment);
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('plugin-consent-native-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
