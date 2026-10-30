// Build edited copies without application src, then load their actual Main/browser artifacts.
// The SDK/build tool and installed npm dependencies are shared; plugin sources are isolated.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { discoverAppPluginSources } from './source-discovery.mjs';

const workspace = process.cwd();
const temporary = await mkdtemp(path.join(tmpdir(), 'app-plugin-only-rewrite-'));
const isolated = path.join(temporary, 'isolated');
const sourceRoot = path.join(isolated, 'plugins/extensions');
const dependencies = path.join(isolated, 'node_modules');
const runtimeRoot = path.join(workspace, 'plugins/extensions/runtime-services');
const extensionRoot = process.env.APP_PLUGIN_PROBE_SOURCE_ROOT ?? path.join(workspace, 'plugins/extensions');
const subjects = await discoverAppPluginSources(extensionRoot);
const subjectRoots = new Map(subjects.map(source => [source.id, source.directory]));
const srcRoot = path.join(workspace, 'src');
const ids = subjects.map(source => source.id);
const captured = [];
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};
const builderUrl = pathToFileURL(
  path.join(workspace, 'scripts/plugins/build-app-plugins.mjs'),
).href;
// Observe the builder's own local metafiles without changing its options or emitted bytes.
globalThis.__appPluginRewriteAudit = captured;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== builderUrl) return result;
    const source = Buffer.from(result.source).toString('utf8');
    const marker = 'return { id: manifest.id, hash, root, packageRoot };';
    assert.ok(source.includes(marker), 'Actual builder audit anchor must remain exact');
    return {
      ...result,
      source: source.replace(
        marker,
        `globalThis.__appPluginRewriteAudit.push(native.metafile, main.metafile, browser.metafile);\n  ${marker}`,
      ),
    };
  },
});
const { buildAppPlugin } = await import('../../plugins/build-app-plugins.mjs');
hooks.deregister();
let child;
let linked = false;
try {
  const baseline = new Map();
  const runtimeDependencies = new Set();
  const siblingDependencies = new Set();
  for (const id of ids) {
    captured.length = 0;
    baseline.set(
      id,
      await buildAppPlugin(
        subjectRoots.get(id),
        path.join(temporary, 'baseline'),
      ),
    );
    assert.equal(captured.length, 3, 'Audit must observe the real native, Main and browser builds');
    for (const graph of captured)
      for (const input of Object.keys(graph.inputs)) {
        const absolute = path.resolve(input);
        assert.equal(
          inside(srcRoot, absolute),
          false,
          `Application source entered baseline: ${input}`,
        );
        if (inside(runtimeRoot, absolute))
          runtimeDependencies.add(path.relative(runtimeRoot, absolute));
        if (
          inside(extensionRoot, absolute) &&
          !ids.some(id => inside(path.join(extensionRoot, id), absolute))
        )
          siblingDependencies.add(path.relative(extensionRoot, absolute));
      }
  }
  await mkdir(sourceRoot, { recursive: true });
  for (const id of ids)
    await cp(subjectRoots.get(id), path.join(sourceRoot, id), {
      recursive: true,
      filter: file =>
        !/\.test\.[cm]?[jt]sx?$/u.test(file) && path.basename(file) !== 'node_modules',
    });
  for (const relative of siblingDependencies) {
    const destination = path.join(sourceRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(extensionRoot, relative), destination);
  }
  await symlink(path.join(workspace, 'node_modules'), dependencies, 'junction');
  linked = true;
  await assert.rejects(access(path.join(isolated, 'src')), 'Isolated author root must have no src');
  const checks = { isolatedRootHasNoApplicationSource: true, actualBuilderMetafilesObserved: true };
  for (const id of ids) {
    const source = path.join(sourceRoot, id);
    const declarationFile = path.join(source, 'app.plugin.json');
    const declaration = JSON.parse(await readFile(declarationFile, 'utf8'));
    declaration.commands.push('rewrite.check');
    await writeFile(declarationFile, JSON.stringify(declaration, null, 2) + '\n');
    const packageFile = path.join(source, 'package.json');
    const pkg = JSON.parse(await readFile(packageFile, 'utf8'));
    const originalMain = './' + pkg.app.main.replace(/^\.\//u, '');
    const originalBrowser = './' + pkg.app.browser.replace(/^\.\//u, '');
    await writeFile(path.join(source, 'probe-main.ts'),
      'import { register as original } from ' + JSON.stringify(originalMain) + ';\n' +
      'export function register(host) { const registration = original(host); return { ...registration, commands: [...registration.commands, { id: "rewrite.check", invoke: () => ({ success: true, owner: host.manifest.id, marker: "plugin-only-rewrite" }) }] }; }\n');
    await writeFile(path.join(source, 'probe-browser.tsx'),
      'import React from "react"; import { register as original } from ' + JSON.stringify(originalBrowser) + ';\n' +
      'export function register(host) { const release = original(host); host.registerTranslations({ en: { rewriteTitle: "Rewritten" }, zh: { rewriteTitle: "Rewritten" } }); host.registerView({ id: "rewrite-check", slot: "workspace.tab", labelKey: "rewriteTitle", component: () => <div>plugin-only-ui-' + id + '</div> }); return release; }\n');
    pkg.app.main = 'probe-main.ts'; pkg.app.browser = 'probe-browser.tsx';
    await writeFile(packageFile, JSON.stringify(pkg, null, 2) + '\n');
    captured.length = 0;
    const rewritten = await buildAppPlugin(source, path.join(temporary, 'rewritten'));
    assert.equal(captured.length, 3);
    for (const graph of captured)
      for (const input of Object.keys(graph.inputs)) {
        const absolute = path.resolve(input);
        assert.equal(
          inside(srcRoot, absolute),
          false,
          `Application src entered rewritten build: ${input}`,
        );
        assert.equal(
          inside(path.join(workspace, 'plugins/extensions'), absolute),
          false,
          `Original plugin source entered isolated build: ${input}`,
        );
      }
    const originalIndex = JSON.parse(
      await readFile(path.join(baseline.get(id).root, 'app.artifact.json'), 'utf8'),
    );
    const rewrittenIndex = JSON.parse(
      await readFile(path.join(rewritten.root, 'app.artifact.json'), 'utf8'),
    );
    assert.notEqual(rewritten.hash, baseline.get(id).hash);
    for (const entry of ['main', 'browser'])
      assert.notEqual(
        originalIndex.files[originalIndex.manifest.entries[entry]],
        rewrittenIndex.files[rewrittenIndex.manifest.entries[entry]],
      );
    checks[`${id}:onlyPluginEditsChangedMainAndBrowserHashes`] = true;
    checks[`${id}:isolatedActualGraphHasNoApplicationOrOriginalPluginImports`] = true;
  }
  // Rebuild from those same edited copies and exercise the real registries in Electron.
  for (const probe of ['verify-built-app-artifacts.mjs', 'verify-built-browser-artifacts.mjs']) {
    const args = [path.join(workspace, 'scripts/test/plugin-host', probe)];
    if (probe === 'verify-built-app-artifacts.mjs' && process.argv.includes('--node'))
      args.push('--node');
    child = spawn(process.execPath, args, {
      cwd: workspace,
      windowsHide: true,
      env: {
        ...process.env,
        APP_PLUGIN_PROBE_SOURCE_ROOT: sourceRoot,
        APP_PLUGIN_PROBE_REWRITE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', bytes => {
      output += bytes;
    });
    child.stderr.on('data', bytes => {
      output += bytes;
    });
    const timeout = setTimeout(() => child.kill(), 90000);
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    clearTimeout(timeout);
    assert.equal(code, 0, output);
    process.stdout.write(output);
    checks[probe] = true;
    child = undefined;
  }
  console.log(
    JSON.stringify({
      pluginSourcesCopiedToIndependentRoot: true,
      sharedHostSdkAndNpmDependencies: true,
      editedPlugins: ids,
      requiredRuntimeServicesSourceFiles: [...runtimeDependencies].sort(),
      otherRequiredSiblingSources: [...siblingDependencies]
        .filter(file => !file.startsWith('runtime-services' + path.sep))
        .sort(),
      checks,
    }),
  );
} finally {
  child?.kill();
  delete globalThis.__appPluginRewriteAudit;
  if (linked) await unlink(dependencies);
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(tmpdir()));
  assert.ok(path.basename(temporary).startsWith('app-plugin-only-rewrite-'));
  await rm(temporary, { recursive: true, force: true });
}
