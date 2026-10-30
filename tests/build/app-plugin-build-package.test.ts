import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { expect, test } from 'vitest';

import { buildSdkPackage } from '../../plugins/sdk/app-plugin-build/sdk.mjs';
import { installBrowserRuntime } from '../../plugins/sdk/app-plugin-build/testing.mjs';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const npmCli = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');

test('rejects SDK output that could delete source files, including a directory alias', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sdk-output-boundary-'));
  const source = path.join(root, 'source');
  try {
    await mkdir(source);
    await writeFile(path.join(source, 'entry.ts'), 'export const value = true;');
    await writeFile(path.join(source, 'manual.d.ts'), 'export declare const manual: true;');
    await writeFile(path.join(source, 'manual.js'), 'export const manual = true;');
    const alias = path.join(root, 'alias');
    await symlink(source, alias, 'junction');
    for (const destination of [source, root, alias])
      await expect(buildSdkPackage({ source, destination })).rejects.toThrow('must not contain its source');
    expect(await readFile(path.join(source, 'manual.js'), 'utf8')).toContain('manual = true');
    expect(await readFile(path.join(source, 'manual.d.ts'), 'utf8')).toContain('declare const manual');
  } finally {
    expect(path.dirname(root)).toBe(path.resolve(tmpdir()));
    expect(path.basename(root)).toMatch(/^sdk-output-boundary-/u);
    await rm(root, { recursive: true, force: true });
  }
});

test('installs packed tools and SDK without a host checkout, and checks the real native and browser roots', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'app-plugin-independent-build-'));
  const put = async (name: string, value: unknown) => {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
  };
  const npm = (...args: string[]) => run(process.execPath, [npmCli, ...args], { cwd: root, maxBuffer: 1024 * 1024 });
  try {
    await put('sdk/retired.js', 'export const obsolete = true;');
    await put('sdk/retired.d.ts', 'export declare const obsolete: true;');
    const sdk = await buildSdkPackage({ source: path.resolve('plugins/sdk/app-plugin-sdk'), destination: path.join(root, 'sdk'), licenseFile: path.resolve('LICENSE') });
    await expect(access(path.join(sdk, 'retired.js'))).rejects.toThrow();
    await expect(access(path.join(sdk, 'retired.d.ts'))).rejects.toThrow();
    await mkdir(path.join(root, 'tarballs'));
    const pack = async (source: string) => {
      const result = await npm('pack', source, '--pack-destination', path.join(root, 'tarballs'), '--json');
      return path.join(root, 'tarballs', JSON.parse(result.stdout)[0].filename);
    };
    const sdkTarball = await pack(sdk);
    const toolTarball = await pack(path.resolve('plugins/sdk/app-plugin-build'));
    await put('package.json', {
      name: 'independent-plugin-build-fixture', private: true, type: 'module',
      dependencies: {
        '@app-plugin/sdk': 'file:' + sdkTarball,
        '@app-plugin/build': 'file:' + toolTarball,
        '@types/node': require('@types/node/package.json').version,
        react: '18.3.1', 'react-dom': '18.3.1', '@heroicons/react': '2.2.0',
      },
    });
    await npm('install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund');
    for (const name of ['sdk', 'build'])
      expect((await lstat(path.join(root, 'node_modules/@app-plugin', name))).isSymbolicLink()).toBe(false);
    const pkg = 'plugins/extensions/example/';
    await put(pkg + 'package.json', {
      name: 'example', version: '1.0.0', type: 'module', license: 'MIT',
      dependencies: { '@app-plugin/sdk': '^1.0.0', react: '^18.3.1', '@heroicons/react': '2.2.0' },
      openclaw: { extensions: ['./index.ts'] },
      app: { main: 'main.ts', browser: 'browser.tsx', presentation: 'presentation.ts' },
    });
    await put(pkg + 'LICENSE', 'MIT fixture license');
    await put(pkg + 'app.plugin.json', {
      manifestVersion: 1, apiVersion: 1, id: 'example', nativePluginId: 'example', version: '1.0.0',
      entries: { main: 'main.mjs', browser: 'browser.mjs', presentation: 'presentation.mjs' },
      capabilities: [], commands: [], slots: [],
    });
    await put(pkg + 'openclaw.plugin.json', { id: 'example', configSchema: { type: 'object', properties: {} } });
    const native = "import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/core'; export default { id:'example', register(api: OpenClawPluginApi){return api.id;} };\n";
    await put(pkg + 'index.ts', native);
    await put(pkg + 'main.ts', "import {APP_PLUGIN_API_VERSION} from '@app-plugin/sdk/contracts'; export const register=()=>({commands:[],version:APP_PLUGIN_API_VERSION});\n");
    await put(pkg + 'browser.tsx', "import React from 'react'; import {BeakerIcon} from '@heroicons/react/24/outline'; import {runtime} from '@app-plugin/sdk/browser-runtime'; export const view=<div className='shadow-card bg-primary animate-fade-in'><BeakerIcon/></div>; export const register=()=>React===runtime.React;\n");
    await put(pkg + 'presentation.ts', "export const presentation={messageText:({text}:{text:string})=>text};\n");
    // A public SDK fixture supplies declarations only. This test does not execute Gateway.
    await put('node_modules/openclaw/package.json', { name: 'openclaw', type: 'module', exports: { './plugin-sdk/core': { types: './core.d.ts', default: './core.js' } } });
    await put('node_modules/openclaw/core.d.ts', 'export interface OpenClawPluginApi { id: string; }\n');
    const cli = path.join(root, 'node_modules/@app-plugin/build/cli.mjs');
    const check = () => run(process.execPath, [cli, 'check', '--source', pkg], { cwd: root });
    await check();
    // CLI source resolution must not depend on the caller's working directory.
    await run(process.execPath, [cli, 'check', '--source', path.join(root, pkg)], { cwd: tmpdir() });
    await put(pkg + 'index.ts', native + 'export const invalid: string = 17;\n');
    await expect(check()).rejects.toThrow('not assignable to type');
    await put(pkg + 'index.ts', native);
    const built = await run(process.execPath, [cli, 'build', '--source', pkg, '--out', 'output'], { cwd: root });
    const [{ id, hash }] = JSON.parse(built.stdout);
    expect(id).toBe('example');
    const artifactRoot = path.join(root, 'output', id, hash);
    const packageRoot = path.join(root, 'output/packages', id, hash);
    const artifact = JSON.parse(await readFile(path.join(artifactRoot, 'app.artifact.json'), 'utf8'));
    expect(createHash('sha256').update(JSON.stringify({ manifest: artifact.manifest, files: artifact.files })).digest('hex')).toBe(hash);
    const binding = JSON.parse(await readFile(path.join(artifactRoot, 'native.binding.json'), 'utf8'));
    expect(binding.sha256).toBe(createHash('sha256').update(await readFile(path.join(packageRoot, 'index.js'))).digest('hex'));
    expect(await readFile(path.join(artifactRoot, 'browser.css'), 'utf8')).toContain(':where([data-ui-style-scope="example"])');
    expect(await readFile(path.join(packageRoot, 'LICENSE'), 'utf8')).toBe('MIT fixture license');
    const notices = JSON.parse(await readFile(path.join(packageRoot, 'THIRD_PARTY_NOTICES.json'), 'utf8'));
    expect(notices.dependencies.some((entry: {name: string}) => entry.name === '@app-plugin/sdk')).toBe(true);
    expect(notices.dependencies.find((entry: {name: string}) => entry.name === '@heroicons/react')).toMatchObject({
      name: '@heroicons/react', version: '2.2.0', files: [expect.stringContaining('LICENSE')],
    });
    const runtime = { React: require('react'), services: {}, jsx: () => null, jsxs: () => null };
    const release = installBrowserRuntime(runtime);
    try {
      const browser = await import(/* @vite-ignore */ pathToFileURL(path.join(artifactRoot, 'browser.mjs')).href);
      expect(browser.register()).toBe(true);
    } finally { release(); }
    await put('plugins/extensions/shared.ts', 'export const escaped=true;\n');
    await put(pkg + 'main.ts', "export {escaped} from '../shared';\n");
    await expect(run(process.execPath, [cli, 'build', '--source', pkg, '--out', 'rejected'], { cwd: root })).rejects.toThrow('outside its package');
    await mkdir(path.join(root, 'empty'));
    await run(process.execPath, [cli, 'build', '--source-root', 'empty', '--out', 'empty-output'], { cwd: root });
    expect(JSON.parse(await readFile(path.join(root, 'empty-output/catalog.json'), 'utf8'))).toEqual([]);
    await mkdir(path.join(root, 'empty/broken'));
    await put('empty/broken/package.json', { app: { main: 'main.ts', browser: 'browser.tsx' } });
    await expect(run(process.execPath, [cli, 'build', '--source-root', 'empty', '--out', 'empty-output'], { cwd: root })).rejects.toThrow('app.plugin.json');
  } finally {
    expect(path.dirname(root)).toBe(path.resolve(tmpdir()));
    expect(path.basename(root)).toMatch(/^app-plugin-independent-build-/u);
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test('browser runtime fixtures preserve the prior runtime across out-of-order cleanup', () => {
  const key = Symbol.for('app-plugin.browser-runtime.v1');
  const before = Object.getOwnPropertyDescriptor(globalThis, key);
  const first = { React: {}, services: {} };
  const second = { React: {}, services: {} };
  const releaseFirst = installBrowserRuntime(first);
  const releaseSecond = installBrowserRuntime(second);
  releaseFirst();
  expect(Reflect.get(globalThis, key)).toBe(second);
  releaseSecond();
  expect(Object.getOwnPropertyDescriptor(globalThis, key)).toEqual(before);
});
