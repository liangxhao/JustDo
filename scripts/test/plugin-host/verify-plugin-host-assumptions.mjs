// Architecture probes only: no application/Gateway state or production loader is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MessageChannel } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';

import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const temporary = await mkdtemp(path.join(tmpdir(), 'app-plugin-probe-'));
const report = { node: process.versions.node, checks: {} };

const writeModule = async (directory, generation) => {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'child.mjs'), `export const child = ${generation};`);
  await writeFile(
    path.join(directory, 'main.mjs'),
    `import { child } from './child.mjs'; export const root = ${generation}; export { child };`,
  );
};

try {
  const mutable = path.join(temporary, '中文 path');
  await writeModule(mutable, 1);
  const url = pathToFileURL(path.join(mutable, 'main.mjs')).href;
  const first = await import(url);
  await writeModule(mutable, 2);
  const same = await import(url);
  assert.equal(first, same);
  assert.equal(same.root, 1);
  const query = await import(`${url}?generation=2`);
  assert.equal(query.root, 2);
  assert.equal(query.child, 1);
  const immutable = path.join(temporary, 'generation-2');
  await writeModule(immutable, 2);
  const complete = await import(pathToFileURL(path.join(immutable, 'main.mjs')).href);
  assert.equal(complete.root, 2);
  assert.equal(complete.child, 2);
  report.checks.esm = {
    sameUrlRetainsOldModule: true,
    rootQueryMixesOldChild: true,
    versionedDirectoryConsistent: true,
    chineseAndSpacePath: true,
  };

  const { port1, port2 } = new MessageChannel();
  try {
    assert.throws(() => port1.postMessage({ transaction: () => undefined }), {
      name: 'DataCloneError',
    });
    report.checks.worker = { liveFunctionPortCannotBeCloned: true };
  } finally {
    port1.close();
    port2.close();
  }

  const database = new DatabaseSync(':memory:');
  try {
    database.exec(
      'CREATE TABLE sessions (id TEXT PRIMARY KEY); CREATE TABLE team (id TEXT PRIMARY KEY);',
    );
    const readCount = table => database.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
    database.exec('BEGIN');
    try {
      database.exec("INSERT INTO sessions VALUES ('atomic'); INSERT INTO team VALUES ('atomic');");
      throw new Error('synthetic failure');
    } catch {
      database.exec('ROLLBACK');
    }
    assert.equal(readCount('sessions'), 0);
    assert.equal(readCount('team'), 0);
    database.exec("INSERT INTO sessions VALUES ('split');");
    database.exec('BEGIN');
    database.exec("INSERT INTO team VALUES ('split');");
    database.exec('ROLLBACK');
    assert.equal(readCount('sessions'), 1);
    assert.equal(readCount('team'), 0);
    report.checks.database = { sharedTransactionRollsBackBoth: true, splitCallsLeaveOrphan: true };
  } finally {
    database.close();
  }

  const assets = path.join(temporary, 'renderer');
  const assetDirectory = path.join(assets, 'assets');
  await mkdir(assetDirectory, { recursive: true });
  const bundle = async (source, outfile, external = []) => {
    await build({
      stdin: { contents: source, resolveDir: repository, sourcefile: 'fixture.js' },
      outfile: path.join(assetDirectory, outfile),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      external,
      // react-dom 18 uses CommonJS require; external alone leaves a browser require.
      plugins: external.includes('react')
        ? [
            {
              name: 'shared-react-commonjs-bridge',
              setup(builder) {
                builder.onResolve({ filter: /^react$/ }, args =>
                  args.kind === 'require-call'
                    ? { path: 'react', namespace: 'shared-react' }
                    : { path: 'react', external: true },
                );
                builder.onLoad({ filter: /^react$/, namespace: 'shared-react' }, () => ({
                  contents: "import React from 'react'; module.exports = React;",
                  loader: 'js',
                }));
              },
            },
          ]
        : [],
      define: { 'process.env.NODE_ENV': '"production"' },
      logLevel: 'silent',
    });
  };
  await bundle(
    "import React from 'react'; export default React; export const useState = React.useState;",
    'react.mjs',
  );
  await bundle("export { createRoot } from 'react-dom/client';", 'react-dom.mjs', ['react']);
  const component = `import React from 'react'; export const instance = React;
    export default function PluginView() { const [value] = React.useState('plugin-hook-ok');
      return React.createElement('span', null, value); }`;
  await bundle(component, 'plugin-shared.mjs', ['react']);
  await bundle(component, 'plugin-duplicate.mjs');
  await bundle(
    `
    import React from 'react';
    import { createRoot } from './react-dom.mjs';
    const violations = [];
    document.addEventListener('securitypolicyviolation', event => violations.push(event.violatedDirective));
    const shared = await import('./plugin-shared.mjs');
    const duplicate = await import('./plugin-duplicate.mjs');
    class Boundary extends React.Component {
      state = { failed: false };
      static getDerivedStateFromError() { return { failed: true }; }
      componentDidCatch(error) { window.duplicateError = String(error); }
      render() { return this.state.failed ? null : this.props.children; }
    }
    createRoot(document.getElementById('shared')).render(React.createElement(shared.default));
    createRoot(document.getElementById('duplicate')).render(
      React.createElement(Boundary, null, React.createElement(duplicate.default)));
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && (!window.duplicateError || !document.getElementById('shared').textContent)) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    window.probe.finish({
      sharedReactIdentity: shared.instance === React,
      sharedHooksRendered: document.getElementById('shared').textContent === 'plugin-hook-ok',
      duplicateReactIdentity: duplicate.instance !== React,
      duplicateHooksRejected: /useState|Invalid hook call|Minified React error/.test(window.duplicateError ?? ''),
      cspViolations: violations,
      rendererNodeUnavailable: typeof globalThis.process === 'undefined' && typeof globalThis.require === 'undefined',
    });`,
    'entry.mjs',
    ['react', './react-dom.mjs', './plugin-shared.mjs', './plugin-duplicate.mjs'],
  );
  await writeFile(path.join(assetDirectory, 'change.mjs'), 'export const value = 1;');
  await writeFile(
    path.join(assets, 'index.html'),
    `<!doctype html>
    <script type="importmap">{"imports":{"react":"/assets/react.mjs"}}</script>
    <div id="shared"></div><div id="duplicate"></div><script type="module" src="/assets/entry.mjs"></script>`,
  );
  const hostModule = path.join(temporary, 'renderer-host.cjs');
  await build({
    entryPoints: [
      path.join(repository, 'src/main/core/window/renderer/applicationRendererHost.ts'),
    ],
    outfile: hostModule,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  const preload = path.join(temporary, 'preload.cjs');
  await writeFile(
    preload,
    `const { contextBridge, ipcRenderer } = require('electron');
    contextBridge.exposeInMainWorld('probe', { finish: value => ipcRenderer.send('probe:result', value) });`,
  );
  const resultPath = path.join(temporary, 'result.json');
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  await new Promise((resolve, reject) => {
    const child = spawn(
      require('electron'),
      [
        path.join(repository, 'scripts/test/plugin-host/electron-probe.cjs'),
        temporary,
        assets,
        hostModule,
        preload,
        resultPath,
      ],
      { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', chunk => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-4000);
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 45000);
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', code => {
      clearTimeout(timeout);
      if (timedOut) reject(new Error(`Electron probe timeout: ${stderr}`));
      else if (code === 0) resolve();
      else reject(new Error(`Electron probe failed (${code}): ${stderr}`));
    });
  });
  report.electron = JSON.parse(await readFile(resultPath, 'utf8'));
  console.log(JSON.stringify(report, null, 2));
} finally {
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(tmpdir()));
  assert.ok(path.basename(temporary).startsWith('app-plugin-probe-'));
  await rm(temporary, { recursive: true, force: true });
}
