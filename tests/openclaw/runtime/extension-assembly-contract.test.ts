import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { buildAppPlugin } from '../../../scripts/plugins/build-app-plugins.mjs';

import { verifyCollaborationExtensionAssembly } from './extension-assembly-contract.mjs';

const runtime = process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR;
if (process.env.OPENCLAW_REQUIRE_MANAGEMENT_CONTRACTS === '1' && !runtime)
  throw new Error('The collaboration assembly controls require the selected frozen runtime.');
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const outputRecords = (runtimeRoot: string) => {
  const files: Array<{ path: string; sha256: string }> = [];
  const visit = (directory: string) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      if (fs.lstatSync(file).isDirectory()) visit(file);
      else files.push({ path: path.relative(runtimeRoot, file).replaceAll('\\', '/'), sha256: hash(fs.readFileSync(file)) });
    }
  };
  visit(path.join(runtimeRoot, 'dist/extensions'));
  return files;
};

test.skipIf(!runtime)('assembly rejects output drift, unrecorded files and incomplete source receipts', () => {
  const admitted = verifyCollaborationExtensionAssembly(runtime!);
  const fixtureParent = fs.realpathSync(os.tmpdir());
  const fixture = fs.mkdtempSync(path.join(fixtureParent, 'extension-assembly-'));
  const receiptFile = path.join(fixture, 'extension-assembly-receipt.json');
  try {
    // Only the helper's source/output binding is under test. These synthetic
    // core bytes are deliberately not a valid frozen Gateway admission.
    const manifest = fs.readFileSync(path.join(runtime!, 'runtime-patch-manifest.json'));
    const core = JSON.parse(manifest.toString());
    fs.writeFileSync(path.join(fixture, 'runtime-patch-manifest.json'), manifest);
    for (const file of ['gateway-bundle.mjs', 'gateway.asar'])
      fs.writeFileSync(path.join(fixture, file), 'synthetic core fixture');
    for (const entry of admitted.entries) {
      const destination = path.join(fixture, entry.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.cpSync(path.join(runtime!, 'dist/extensions', entry.id), path.dirname(destination), { recursive: true });
    }
    expect(verifyCollaborationExtensionAssembly(fixture).assemblySha256).toBe(admitted.assemblySha256);
    const receipt = {
      formatVersion: 1,
      core: {
        manifestSha256: hash(manifest), buildRecipeSha256: core.buildRecipeSha256,
        patchSetSha256: core.patchSetSha256,
        gatewayBundleSha256: hash('synthetic core fixture'), gatewayAsarSha256: hash('synthetic core fixture'),
      },
      sources: admitted.sources,
      outputs: outputRecords(fixture),
      tools: [{ path: 'package.json', sha256: hash(fs.readFileSync('package.json')) }],
      extensions: Object.fromEntries(admitted.entries.map(({ id, path: entry, sha256 }: { id: string; path: string; sha256: string }) =>
        [id, { entry, sha256 }])),
    };
    const writeReceipt = (value: unknown) => fs.writeFileSync(receiptFile, JSON.stringify(value));
    writeReceipt(receipt);
    expect(verifyCollaborationExtensionAssembly(fixture).receiptSha256).toBeTruthy();

    const extra = path.join(fixture, 'dist/extensions/unrecorded.js');
    fs.writeFileSync(extra, 'unrecorded');
    expect(() => verifyCollaborationExtensionAssembly(fixture)).toThrow(/complete extension output inventory/);
    fs.unlinkSync(extra);
    writeReceipt({ ...receipt, sources: receipt.sources.slice(1) });
    expect(() => verifyCollaborationExtensionAssembly(fixture)).toThrow(/complete current production source closure/);
    writeReceipt({ ...receipt, core: { ...receipt.core, manifestSha256: 'wrong' } });
    expect(() => verifyCollaborationExtensionAssembly(fixture)).toThrow();
    writeReceipt(receipt);
    fs.appendFileSync(path.join(fixture, admitted.entries[0].path), '\n// changed output');
    expect(() => verifyCollaborationExtensionAssembly(fixture)).toThrow(/does not match the production source closure/);
  } finally {
    expect(path.dirname(fs.realpathSync(fixture))).toBe(fixtureParent);
    expect(path.basename(fixture)).toMatch(/^extension-assembly-.+/);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}, 30_000);


test('verifies independent app packages without the retired bundle flag and rejects native, companion and receipt drift', async () => {
  const buildRoot = path.resolve('build');
  fs.mkdirSync(buildRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(buildRoot, 'assembly-contract-'));
  const sourceRoot = path.join(root, 'sources');
  const source = path.join(sourceRoot, 'fixture-extension');
  const selectedRuntime = path.join(root, 'runtime');
  fs.mkdirSync(source, { recursive: true });
  fs.mkdirSync(selectedRuntime, { recursive: true });
  const write = (name: string, value: unknown) => fs.writeFileSync(path.join(source, name), JSON.stringify(value));
  write('package.json', {
    name: 'fixture-extension', version: '1.0.0', type: 'module', license: 'MIT',
    openclaw: { extensions: ['./index.ts'] }, app: { main: './host.ts', browser: './browser.ts' },
  });
  write('app.plugin.json', {
    manifestVersion: 1, apiVersion: 1, id: 'fixture-extension', nativePluginId: 'fixture-extension',
    version: '1.0.0', entries: { main: 'main.mjs', browser: 'browser.mjs' },
    capabilities: [], commands: [], slots: [],
  });
  write('openclaw.plugin.json', { id: 'fixture-extension', configSchema: { type: 'object', properties: {} } });
  fs.writeFileSync(path.join(source, 'index.ts'), "export default { id: 'fixture-extension', register() {} };\n");
  fs.writeFileSync(path.join(source, 'host.ts'), 'export const register = () => ({ commands: [] });\n');
  fs.writeFileSync(path.join(source, 'browser.ts'), 'export const register = () => () => undefined;\n');
  fs.copyFileSync(path.resolve('LICENSE'), path.join(source, 'LICENSE'));
  try {
    const built = await buildAppPlugin(source, path.join(root, 'artifacts'));
    const installed = path.join(selectedRuntime, 'dist/extensions/fixture-extension');
    fs.cpSync(built.packageRoot, installed, { recursive: true });
    fs.writeFileSync(path.join(selectedRuntime, 'runtime-patch-manifest.json'), JSON.stringify({
      buildRecipeSha256: 'a'.repeat(64), patchSetSha256: 'b'.repeat(64),
    }));
    for (const file of ['gateway-bundle.mjs', 'gateway.asar'])
      fs.writeFileSync(path.join(selectedRuntime, file), 'synthetic frozen core identity');
    const verify = () => verifyCollaborationExtensionAssembly(selectedRuntime, { sourceRoot });
    const admitted = verify();
    expect(admitted.entries.map(({ id }: { id: string }) => id)).toEqual(['fixture-extension']);
    expect(admitted.sources.some(({ path: file }: { path: string }) => file.endsWith('/native.ts'))).toBe(true);
    const outputs = outputRecords(selectedRuntime);
    const core = JSON.parse(fs.readFileSync(path.join(selectedRuntime, 'runtime-patch-manifest.json'), 'utf8'));
    const receipt = {
      formatVersion: 1,
      core: {
        manifestSha256: hash(fs.readFileSync(path.join(selectedRuntime, 'runtime-patch-manifest.json'))),
        ...core,
        gatewayBundleSha256: hash('synthetic frozen core identity'), gatewayAsarSha256: hash('synthetic frozen core identity'),
      },
      sources: admitted.sources,
      outputs,
      tools: [{ path: 'package.json', sha256: hash(fs.readFileSync('package.json')) }],
      extensions: Object.fromEntries(admitted.entries.map(({ id, path: entry, sha256 }: { id: string; path: string; sha256: string }) => [id, { entry, sha256 }])),
    };
    const receiptFile = path.join(selectedRuntime, 'extension-assembly-receipt.json');
    const record = (value: unknown) => fs.writeFileSync(receiptFile, JSON.stringify(value));
    record(receipt);
    expect(verify().receiptSha256).toBeTruthy();
    const unrecorded = path.join(installed, 'unrecorded.js');
    fs.writeFileSync(unrecorded, 'unexpected');
    expect(verify).toThrow(/complete extension output inventory/);
    fs.unlinkSync(unrecorded);
    record({ ...receipt, sources: receipt.sources.slice(1) });
    expect(verify).toThrow(/complete current production source closure/);
    record(receipt);
    const browser = path.join(installed, 'app/browser.mjs');
    const browserBytes = fs.readFileSync(browser);
    fs.appendFileSync(browser, '\n// mutated companion');
    expect(verify).toThrow(/Assembly bytes changed/);
    fs.writeFileSync(browser, browserBytes);
    const bindingFile = path.join(installed, 'app/native.binding.json');
    const artifactFile = path.join(installed, 'app/app.artifact.json');
    const bindingBytes = fs.readFileSync(bindingFile);
    const artifactBytes = fs.readFileSync(artifactFile);
    const artifact = JSON.parse(artifactBytes.toString('utf8'));
    const forgedBinding = JSON.stringify({ ...JSON.parse(bindingBytes.toString('utf8')), sha256: '0'.repeat(64) });
    artifact.files['native.binding.json'] = hash(forgedBinding);
    artifact.hash = hash(JSON.stringify({ manifest: artifact.manifest, files: artifact.files }));
    fs.writeFileSync(bindingFile, forgedBinding);
    fs.writeFileSync(artifactFile, JSON.stringify(artifact));
    expect(verify).toThrow();
    fs.writeFileSync(bindingFile, bindingBytes);
    fs.writeFileSync(artifactFile, artifactBytes);
    const installedPackage = path.join(installed, 'package.json');
    const packageBytes = fs.readFileSync(installedPackage);
    fs.writeFileSync(installedPackage, JSON.stringify({ ...JSON.parse(packageBytes.toString('utf8')), scripts: { postinstall: 'unexpected' } }));
    expect(verify).toThrow(/Install packages must not retain source declaration scripts/);
    fs.writeFileSync(installedPackage, packageBytes);
    const nativeFile = path.join(installed, 'index.js');
    const nativeBytes = fs.readFileSync(nativeFile);
    fs.appendFileSync(nativeFile, '\n// mutated native');
    expect(verify).toThrow(/does not match the production source closure/);
    fs.writeFileSync(nativeFile, nativeBytes);
    expect(() => verifyCollaborationExtensionAssembly(selectedRuntime, { sourceRoot, extensionIds: ['absent'] })).toThrow(/explicitly selected extension source is missing/);
    expect(verify().assemblySha256).toBe(admitted.assemblySha256);
  } finally {
    const relative = path.relative(buildRoot, root);
    expect(relative && !relative.startsWith('..') && !path.isAbsolute(relative)).toBeTruthy();
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
