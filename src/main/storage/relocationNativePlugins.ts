/** Shared code for the offline source and target Node workers. */
export const NATIVE_RELOCATION_PLUGINS = String.raw`
import { isDeepStrictEqual } from 'node:util';
const pluginPathKey = value => process.platform === 'win32' ? value.toLowerCase() : value;
const pluginSamePath = (left, right) => pluginPathKey(left) === pluginPathKey(right);
const pluginRelative = (root, file) => {
  const relative = path.relative(root, file);
  return relative && !path.isAbsolute(relative) &&
    relative.split(path.sep).every(segment => segment !== '..') ? relative : undefined;
};
const pluginStat = file => fs.lstatSync(file, { bigint: true, throwIfNoEntry: false });
const pluginPathIdentity = file => {
  try { return fs.realpathSync.native(file); }
  catch { return path.resolve(file); }
};
const pluginOwnedDirectory = (root, file) => {
  if (!pluginRelative(root, file)) return false;
  const stat = pluginStat(file);
  return Boolean(stat?.isDirectory() && !stat.isSymbolicLink() &&
    pluginSamePath(fs.realpathSync.native(file), file));
};
async function inspectManagedPluginRelocation(cfg) {
  const extensionsDir = (await native('pluginInstallPaths', 'resolveDefaultPluginExtensionsDir'))(process.env);
  const npmDir = (await native('pluginInstallPaths', 'resolveDefaultPluginNpmDir'))(process.env);
  const gitDir = (await native('pluginInstallPaths', 'resolveDefaultPluginGitDir'))(process.env);
  const extensionPath = await native('pluginInstallPaths', 'resolvePluginInstallDir');
  const listNpmRoots = await native('pluginNpmRoots', 'listManagedPluginNpmRootsSync');
  const listNpmPackages = await native('pluginPeerLinks', 'listNpmPackageDirs');
  const hostDependency = await native('pluginPeerLinks', 'resolveOpenClawHostDependency');
  const readPackage = await native('pluginPackageMetadata', 'readRootJsonObjectSync');
  const readRecords = await native('pluginRecords', 'readPersistedInstalledPluginIndexInstallRecords');
  const paths = [];
  const npmPackages = new Set();
  const ownedInstall = (file, kind) => {
    if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
    const normalized = path.resolve(file);
    return Boolean(pluginRelative(kind, normalized) && pluginOwnedDirectory(stateDir, normalized));
  };
  const hostRoot = fs.realpathSync.native(identity.runtimeRoot);
  const peers = new Map();
  function inspectPeer(packageDir, managed = false) {
    if (!pluginOwnedDirectory(stateDir, packageDir)) return;
    const modules = path.join(packageDir, 'node_modules');
    if (!pluginOwnedDirectory(stateDir, modules)) return;
    const link = path.join(modules, 'openclaw');
    const stat = pluginStat(link);
    if (!stat?.isSymbolicLink() || peers.has(pluginPathKey(link))) return;
    const target = fs.readlinkSync(link);
    const pointsAtCurrentHost = pluginSamePath(path.toNamespacedPath(path.resolve(modules, target)),
      path.toNamespacedPath(hostRoot));
    if (!pointsAtCurrentHost) {
      // Older or development deliveries can leave a different or dangling peer.
      // Only Native's reserved position in a managed package declaring the host
      // dependency may be replaced. The old link target is never opened.
      if (!managed) return;
      const metadata = readPackage({ rootDir: packageDir, relativePath: 'package.json',
        boundaryLabel: 'installed plugin package directory' });
      if (!metadata.ok || !hostDependency(metadata.value)) return;
    }
    peers.set(pluginPathKey(link), { link, target, dev: stat.dev, ino: stat.ino,
      birthtimeNs: stat.birthtimeNs });
  }
  if (pluginOwnedDirectory(stateDir, extensionsDir)) {
    for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
      current();
      if (entry.isDirectory()) inspectPeer(path.join(extensionsDir, entry.name));
    }
  }
  if (pluginOwnedDirectory(stateDir, npmDir)) {
    for (const root of listNpmRoots(npmDir)) {
      current();
      if (!pluginOwnedDirectory(stateDir, root)) continue;
      if (!pluginOwnedDirectory(stateDir, path.join(root, 'node_modules'))) continue;
      for (const packageDir of await listNpmPackages(root, {
        includeEntry: (entry, scoped) => entry.isDirectory() && (scoped || !entry.name.startsWith('.')),
      })) {
        npmPackages.add(pluginPathKey(packageDir));
        inspectPeer(packageDir, true);
      }
    }
  }
  const records = readRecords({ env: process.env, stateDir, artifactPreservingReadOnly: true });
  for (const [location, installs] of [['registry', records], ['config', cfg.plugins?.installs]]) {
    for (const [pluginId, record] of Object.entries(installs ?? {})) {
      if (!record || !['path', 'npm', 'git', 'archive', 'clawhub', 'marketplace'].includes(record.source)) continue;
      const install = typeof record.installPath === 'string' ? record.installPath : '';
      const source = typeof record.sourcePath === 'string' ? record.sourcePath : '';
      const addPath = (field, file) => paths.push({ location, pluginId, field,
        source: record.source, relative: path.relative(stateDir, path.resolve(file)) });
      let managedInstall = false;
      if (path.isAbsolute(install)) {
        let expected;
        try { expected = extensionPath(pluginId, extensionsDir); }
        catch { /* Unrecognized external install ID. */ }
        const resolved = path.resolve(install);
        managedInstall = Boolean(expected && pluginSamePath(resolved, expected) && ownedInstall(resolved, extensionsDir)) ||
          (record.source === 'npm' && npmPackages.has(pluginPathKey(resolved)) && ownedInstall(resolved, npmDir)) ||
          (record.source === 'git' && ownedInstall(resolved, gitDir));
        // Native treats a path install as managed only when its copied package and origin differ.
        if (managedInstall && record.source === 'path' && (!path.isAbsolute(source) ||
            pluginSamePath(pluginPathIdentity(source), pluginPathIdentity(install)))) managedInstall = false;
        if (managedInstall) {
          addPath('installPath', resolved);
          inspectPeer(resolved, true);
        }
      }
      if ((record.source === 'git' && ownedInstall(source, gitDir)) ||
          (managedInstall && path.isAbsolute(source) && pluginSamePath(path.resolve(source), path.resolve(install))))
        addPath('sourcePath', source);
    }
  }
  return {
    paths,
    peers: [...peers.values()].map(({ link }) => path.relative(stateDir, link)),
    assertLinks: () => {
      for (const old of peers.values()) {
        const { link } = old;
        const stat = pluginStat(link);
        // Locator publication can propagate ACL metadata and change the NTFS
        // change time without replacing or retargeting the junction.
        assert.ok(pluginOwnedDirectory(stateDir, path.dirname(link)) && stat?.isSymbolicLink() &&
          stat.dev === old.dev && stat.ino === old.ino && stat.birthtimeNs === old.birthtimeNs &&
          fs.readlinkSync(link) === old.target,
        'The source OpenClaw peer link changed.');
      }
    },
  };
}

async function prepareManagedPluginRelocation(plan, cfg) {
  const hostRoot = fs.realpathSync.native(identity.runtimeRoot);
  const linkPeer = await native('pluginPeerLinks', 'linkOpenClawPeerDependencies');
  for (const relative of plan.peers) {
    current();
    const link = path.resolve(stateDir, relative);
    const modules = path.dirname(link);
    const assertAbsent = () => {
      current();
      assert.ok(pluginOwnedDirectory(stateDir, modules) && path.basename(modules) === 'node_modules' &&
        path.basename(link) === 'openclaw' && !pluginStat(link), 'The target OpenClaw peer link is occupied.');
    };
    assertAbsent();
    const receipt = await linkPeer({ installedDir: path.dirname(modules), peerDependencies: { openclaw: '*' },
      hostRoot, logger: {}, beforePersistentApply: assertAbsent });
    assert.ok(receipt.repaired === 1 && pluginStat(link)?.isSymbolicLink() &&
      pluginSamePath(fs.realpathSync.native(link), hostRoot), 'The target OpenClaw peer link was not recreated.');
  }
  const bindings = plan.paths.filter(item => item.location === 'registry');
  const readRecords = await native('pluginRecords', 'readPersistedInstalledPluginIndexInstallRecords');
  const installRecords = readRecords({ env: process.env, stateDir, artifactPreservingReadOnly: true });
  if (!installRecords) {
    assert.equal(bindings.length, 0, 'The managed install records are missing from the target snapshot.');
    return;
  }
  for (const binding of bindings) {
    const { pluginId, source, field, relative } = binding;
    const record = Object.hasOwn(installRecords, pluginId) ? installRecords[pluginId] : undefined;
    const from = path.resolve(plan.sourceStateDir, relative);
    assert.ok(record?.source === source && typeof record[field] === 'string' && path.isAbsolute(record[field]) &&
      pluginSamePath(path.resolve(record[field]), from), 'A managed install record changed during relocation.');
    const target = path.resolve(stateDir, relative);
    assert.ok(pluginOwnedDirectory(stateDir, target), 'The managed target plugin directory is missing.');
    record[field] = target;
  }
  let changed = bindings.length > 0;
  const sourceOpenClaw = path.dirname(plan.sourceStateDir);
  for (const record of Object.values(installRecords)) {
    for (const field of ['installPath', 'sourcePath']) {
      const previous = record[field];
      if (typeof previous !== 'string' || !path.isAbsolute(previous)) continue;
      const relative = pluginRelative(sourceOpenClaw, previous);
      if (!relative) continue;
      record[field] = path.join(path.dirname(stateDir), relative);
      changed = true;
    }
  }
  if (!changed) return;
  current();
  const refresh = await native('pluginIndexWrite', 'refreshPersistedInstalledPluginIndexWithReceipt');
  const receipt = await refresh({ env: process.env, stateDir, config: cfg,
    reason: 'manual', installRecords, assertCurrent: current });
  // The native raw reader uses a null-prototype map and IPC returns a plain object.
  assert.ok(isDeepStrictEqual({ ...receipt.index.installRecords }, { ...installRecords }),
    'The target install records were not published.');
  current();
}
`;
