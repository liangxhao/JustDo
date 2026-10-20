import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

const inside = (root, target) => {
  const relative = path.relative(root, target);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await readFile(file, 'utf8'));

export const DEVELOPMENT_APPLICATION_BODY_COMPLETE = Object.freeze({
  type: 'app-plugin-test-body-complete', version: 1,
});

/** Separate the UI validation budget from the existing owned-process shutdown policy. */
export function waitForDevelopmentApplication(child, { bodyTimeoutMs, finishShutdown }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let bodyComplete = false;
    let closed = false;
    let closedCode;
    let shutdownFinished = false;
    let bodyTimer;
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(bodyTimer);
      child.off('message', onMessage);
      child.off('close', onClose);
      child.off('error', onError);
      if (error) reject(error);
      else resolve(code);
    };
    const onClose = (code, signal) => {
      closed = true;
      closedCode = code;
      if (signal) return finish(new Error(`Application exited on signal ${signal}`));
      if (code !== 0) return finish(undefined, code);
      if (!bodyComplete) return finish(new Error('Application closed without completing its test body'));
      if (shutdownFinished) finish(undefined, code);
    };
    const onError = error => finish(error);
    const onMessage = message => {
      if (settled || bodyComplete || message?.type !== DEVELOPMENT_APPLICATION_BODY_COMPLETE.type ||
        message.version !== DEVELOPMENT_APPLICATION_BODY_COMPLETE.version) return;
      bodyComplete = true;
      clearTimeout(bodyTimer);
      Promise.resolve().then(() => finishShutdown(child)).then(() => {
        shutdownFinished = true;
        if (!closed) finish(new Error('Application cleanup returned without an actual close event'));
        else finish(undefined, closedCode);
      }, error => finish(error));
    };
    bodyTimer = setTimeout(() => finish(new Error('Application test body exceeded its deadline')), bodyTimeoutMs);
    child.on('message', onMessage);
    child.on('close', onClose);
    child.on('error', onError);
  });
}

/** Keep Native's real Git-baseline reads inside this disposable project. */
export async function prepareDevelopmentProjectBaseline({ repo, root }) {
  const realRoot = await realpath(root);
  assert.ok(inside(path.join(await realpath(repo), '.work'), realRoot));
  assert.ok(path.basename(realRoot).startsWith('app-plugin-hot-'));
  const project = path.join(realRoot, 'profile', 'project');
  assert.equal(await realpath(project), project, 'Fixture project is an exact private directory');
  try {
    await lstat(path.join(project, '.git'));
    throw new Error('Fixture project must not already have Git metadata');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await writeFile(path.join(project, 'AGENTS.md'),
    'Disposable test workspace. Keep fixture output inside this project.\n', { flag: 'wx' });
  const hooks = path.join(realRoot, 'empty-git-hooks');
  const globalConfig = path.join(realRoot, 'empty-git-config');
  await mkdir(hooks);
  await writeFile(globalConfig, '', { flag: 'wx' });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/iu.test(key)));
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = globalConfig;
  const git = args => new Promise((resolve, reject) => {
    execFile('git', ['-c', `core.hooksPath=${hooks}`, '-c', `init.templateDir=${hooks}`,
      '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture',
      '-c', 'user.email=fixture@invalid.local', ...args],
    { cwd: project, env, windowsHide: true, encoding: 'utf8', maxBuffer: 4096 }, (error, stdout) => {
      if (error) reject(new Error('Isolated fixture Git baseline failed'));
      else resolve(stdout.trim());
    });
  });
  await git(['init', '--quiet']);
  assert.equal((await lstat(path.join(project, '.git'))).isSymbolicLink(), false);
  assert.equal(await realpath(path.join(project, '.git')), path.join(project, '.git'));
  assert.equal(await realpath(await git(['rev-parse', '--show-toplevel'])), project);
  await git(['add', '--', 'AGENTS.md']);
  await git(['commit', '--quiet', '-m', 'test fixture baseline']);
  return { project, isolated: true };
}

/** Test-only application projection; the prepared source runtime is never a write target. */
export async function projectDevelopmentRuntime({ repo, root, runtime }) {
  repo = await realpath(repo);
  root = await realpath(root);
  const sourceRuntime = await realpath(runtime);
  assert.ok(inside(path.join(repo, '.work'), root), 'Projection belongs to the probe directory');
  assert.ok(!inside(root, sourceRuntime) && !inside(sourceRuntime, root) && root !== sourceRuntime,
    'Prepared runtime and probe directories do not overlap');
  assert.ok((await lstat(path.join(sourceRuntime, 'gateway-launcher.cjs'))).isFile());
  assert.ok((await lstat(path.join(sourceRuntime, 'gateway-bundle.mjs'))).isFile());
  const appRoot = path.join(root, 'application');
  const runtimeRoot = path.join(root, 'runtime');
  const dependencyLinks = [];
  await cp(sourceRuntime, runtimeRoot, {
    recursive: true,
    dereference: true,
    filter: source => {
      if (path.basename(source) !== 'node_modules') return true;
      dependencyLinks.push({ source, target: path.join(runtimeRoot, path.relative(sourceRuntime, source)) });
      return false;
    },
  });
  const links = [];
  const link = async (source, target) => {
    await mkdir(path.dirname(target), { recursive: true });
    await symlink(await realpath(source), target, process.platform === 'win32' ? 'junction' : 'dir');
    links.push(target);
  };
  for (const dependency of dependencyLinks) await link(dependency.source, dependency.target);
  const extensions = path.join(runtimeRoot, 'dist', 'extensions');
  assert.equal((await lstat(path.join(runtimeRoot, 'dist'))).isSymbolicLink(), false);
  assert.ok(inside(runtimeRoot, await realpath(extensions)), 'Mutable extensions stay in the private runtime');

  await mkdir(appRoot, { recursive: true });
  await cp(path.join(repo, 'package.json'), path.join(appRoot, 'package.json'));
  // Main resolves this real development lease module from app.getAppPath(). It
  // accepts the private app root explicitly and does not prepare native packages.
  const leaseScript = 'scripts/openclaw/openclaw-runtime-dev-lease.cjs';
  await mkdir(path.dirname(path.join(appRoot, leaseScript)), { recursive: true });
  await cp(path.join(repo, leaseScript), path.join(appRoot, leaseScript));
  for (const name of ['resources', 'public', 'plugins']) {
    try {
      await link(path.join(repo, name), path.join(appRoot, name));
    } catch (error) {
      if (name !== 'public' || error?.code !== 'ENOENT') throw error;
    }
  }
  const catalogRoot = path.join(repo, 'build', 'app-plugins');
  const overlayCatalogRoot = path.join(appRoot, 'build', 'app-plugins');
  const catalog = await json(path.join(catalogRoot, 'catalog.json'));
  assert.ok(Array.isArray(catalog) && catalog.length > 0, 'Current app plugin catalog exists');
  const identities = new Set();
  for (const entry of catalog) {
    assert.ok(/^[a-z][a-z0-9-]{0,95}$/u.test(entry.id) && /^[a-f0-9]{64}$/u.test(entry.hash));
    assert.ok(!identities.has(entry.id), 'One current artifact per plugin');
    identities.add(entry.id);
    const sourceArtifact = path.join(catalogRoot, entry.id, entry.hash);
    const sourcePackage = path.join(catalogRoot, 'packages', entry.id, entry.hash);
    const artifact = await json(path.join(sourceArtifact, 'app.artifact.json'));
    const packagedArtifact = await json(path.join(sourcePackage, 'app', 'app.artifact.json'));
    assert.equal(artifact.hash, entry.hash);
    assert.equal(artifact.manifest.id, entry.id);
    assert.deepEqual(packagedArtifact, artifact, 'Native package carries this exact companion');
    const binding = await json(path.join(sourceArtifact, 'native.binding.json'));
    assert.equal(binding.entry, 'index.js');
    assert.equal(binding.sha256, digest(await readFile(path.join(sourcePackage, 'index.js'))));
    await cp(sourceArtifact, path.join(overlayCatalogRoot, entry.id, entry.hash), {
      recursive: true, dereference: true,
    });
    await cp(sourcePackage, path.join(overlayCatalogRoot, 'packages', entry.id, entry.hash), {
      recursive: true, dereference: true,
    });
    const target = path.join(extensions, entry.id);
    try {
      assert.equal((await lstat(target)).isSymbolicLink(), false, 'Extension target is private');
      assert.ok(inside(extensions, await realpath(target)), 'Extension replacement stays private');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    assert.ok(inside(runtimeRoot, target));
    for (let index = links.length - 1; index >= 0; index--) {
      if (!inside(target, links[index])) continue;
      await unlink(links[index]);
      links.splice(index, 1);
    }
    await rm(target, { recursive: true, force: true });
    await cp(sourcePackage, target, { recursive: true, dereference: true });
  }
  await writeFile(path.join(overlayCatalogRoot, 'catalog.json'), JSON.stringify(catalog));
  await link(runtimeRoot, path.join(appRoot, 'vendor', 'openclaw-runtime', 'current'));
  const runtimePackage = await json(path.join(runtimeRoot, 'package.json'));
  return { appRoot, runtimeRoot, sourceRuntime, runtimeVersion: runtimePackage.version, links };
}
