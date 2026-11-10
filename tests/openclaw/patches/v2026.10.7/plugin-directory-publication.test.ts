import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { createPluginDirectoryPublicationRecovery } = require('../../../../src/main/openclaw/runtime/native-support/plugin-directory-publication.mjs');
const patch = require('../../../../scripts/patches/v2026.10.7/033-windows-plugin-directory-publication.cjs');
const artifacts = path.resolve('.agent-tasks/plugin-publication-tests');
const roots: string[] = [];
const pristine = process.env.PLUGIN_PUBLICATION_PRISTINE;
const archive = path.resolve('cache/openclaw/openclaw-2026.10.7.tgz');
const runtime = path.resolve(process.env.PLUGIN_PUBLICATION_RUNTIME ?? 'vendor/openclaw-runtime/current');
const required = process.env.PLUGIN_PUBLICATION_REQUIRE_NATIVE === '1';
const nativeAvailable = Boolean(pristine || required || fs.existsSync(archive) &&
  fs.existsSync(path.join(runtime, 'node_modules/@openclaw/fs-safe/package.json')));
const nativeSources = new Map<string, string>();
const sourceTargets = require('../../../../scripts/patches/v2026.10.7/pristine-targets.json').targets as Array<{ file: string; sha256: string }>;
let archiveVerified = false;

function nativeSource(relative: string): string {
  if (nativeSources.has(relative)) return nativeSources.get(relative)!;
  let source: string;
  if (pristine) {
    expect(JSON.parse(fs.readFileSync(path.join(pristine, 'package.json'), 'utf8')).version).toBe('2026.10.7');
    source = fs.readFileSync(path.join(pristine, relative), 'utf8');
  }
  else if (relative.startsWith('node_modules/')) {
    const metadata = JSON.parse(fs.readFileSync(path.join(runtime, 'node_modules/@openclaw/fs-safe/package.json'), 'utf8'));
    expect(metadata.version).toBe('0.26.0');
    source = fs.readFileSync(path.join(runtime, relative), 'utf8');
    if (relative !== 'node_modules/@openclaw/fs-safe/package.json' && source.includes(patch.__testing.CONTRACT)) {
      const kind = relative === patch.__testing.TARGETS.move ? 'move' : 'guard';
      for (const [before, after] of patch.__testing.CHANGES[kind]) source = source.split(after).join(before);
      source = source.replace(`// ${patch.__testing.CONTRACT}\n`, '');
    }
  } else {
    if (!archiveVerified) {
      const lock = require('../../../../scripts/patches/v2026.10.7/source-lock.json');
      expect(createHash('sha256').update(fs.readFileSync(archive)).digest('hex')).toBe(lock.tarballSha256);
      archiveVerified = true;
    }
    source = execFileSync('tar', ['-xOf', archive, `package/${relative}`], {
      encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    });
  }
  const target = sourceTargets.find(target => target.file === relative);
  if (target) expect(createHash('sha256').update(source).digest('hex')).toBe(target.sha256);
  nativeSources.set(relative, source);
  return source;
}

async function nativeInstaller() {
  const filesystem = path.join(runtime, 'node_modules/@openclaw/fs-safe/dist');
  expect(JSON.parse(fs.readFileSync(path.join(filesystem, '../package.json'), 'utf8')).version).toBe('0.26.0');
  const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(file).href);
  const [advanced, atomic, errors, authority, removal] = await Promise.all([
    load(path.join(filesystem, 'advanced.js')), load(path.join(filesystem, 'atomic.js')),
    load(path.join(filesystem, 'errors.js')), load(path.join(runtime, 'dist/mutation-authority-E8BC9dNY.mjs')),
    load(path.join(runtime, 'dist/fs-safe-remove-DuP7yp5L.mjs')),
  ]);
  const named = (module: Record<string, unknown>, name: string) => Object.values(module)
    .find(value => typeof value === 'function' && value.name === name);
  const move = vi.fn(atomic.movePathWithCopyFallback);
  const source = patch.__testing.transform(nativeSource(patch.__testing.TARGETS.install), 'install')
    .replace(/^import .*;\r?\n/gm, '').replace(/^export \{.*\};?\r?$/gm, '');
  const bindings = {
    fs, 'fs$1': fsp, path, randomUUID, FsSafeError: errors.FsSafeError,
    ...Object.fromEntries(['assertCanonicalPathWithinBase', 'assertDirectoryIdentitySync', 'readDirectoryIdentity'].map(name => [name, advanced[name]])),
    pathExists$1: advanced.pathExists, movePathWithCopyFallback: move,
    retainMutationAuthority: named(authority, 'retainMutationAuthority'),
    isRemovalIoError: named(removal, 'isRemovalIoError'), removePathWithinRoot: named(removal, 'removePathWithinRoot'),
  };
  return { ...new Function(...Object.keys(bindings), source + '\nreturn { installPackageDir, requestDeferredPackageDirInstall, resolvePackageDirInstallTransaction };')(...Object.values(bindings)), move };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== artifacts) throw new Error('Invalid publication test cleanup');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  fs.mkdirSync(artifacts, { recursive: true });
  const root = fs.mkdtempSync(path.join(artifacts, 'run-'));
  roots.push(root);
  const sourcePath = path.join(root, 'source');
  const staged = path.join(root, '.fs-safe-move-test.tmp');
  const targetPath = path.join(root, 'installed');
  fs.mkdirSync(path.join(sourcePath, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(sourcePath, 'index.mjs'), 'export const version = 2;\n');
  fs.writeFileSync(path.join(sourcePath, 'nested/data.txt'), '中文 fixture bytes');
  fs.cpSync(sourcePath, staged, { recursive: true });
  const copied = new Map();
  const manifest = (relative: string): unknown => {
    const original = fs.lstatSync(path.join(sourcePath, relative), { bigint: true });
    const destination = fs.lstatSync(path.join(staged, relative), { bigint: true });
    copied.set(path.join(staged, relative), { dev: destination.dev, ino: destination.ino });
    const identity = Object.fromEntries(['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(key => [key, original[key as keyof fs.BigIntStats]]));
    return original.isDirectory() ? {
      ...identity, kind: 'directory', directoryIdentity: { dev: original.dev, ino: original.ino },
      children: fs.readdirSync(path.join(sourcePath, relative)).map(name => ({ name, manifest: manifest(path.join(relative, name)) })),
    } : { ...identity, kind: 'leaf' };
  };
  const state = { sourcePath, staged, targetPath, copied, manifest: manifest(''), assertCurrent: vi.fn() };
  let elapsed = 0;
  let duringWait: (() => void) | undefined;
  const dependencies = {
    fs, path, execFile: vi.fn(), platform: 'win32', env: {}, now: () => elapsed,
    proveLocalNtfs: vi.fn(async () => true),
    wait: vi.fn(async (ms: number) => { elapsed += ms; duringWait?.(); }),
  };
  const error = (extra = {}) => Object.assign(new Error('rename refused'), {
    code: 'EPERM', syscall: 'rename', path: staged, dest: targetPath, ...extra,
  });
  return { root, state, dependencies, error, duringWait: (callback: () => void) => { duringWait = callback; }, elapse: (ms: number) => { elapsed += ms; } };
}

describe('receipt-bound Windows plugin publication recovery', () => {
  it('publishes the same copied directory after an actual refusal without recopying the source', async () => {
    const f = fixture();
    const before = fs.lstatSync(f.state.staged, { bigint: true });
    const dispatch = vi.fn(() => fsp.rename(f.state.staged, f.state.targetPath));
    await createPluginDirectoryPublicationRecovery(f.state, f.dependencies)(f.error(), dispatch);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(fs.lstatSync(f.state.targetPath, { bigint: true }).ino).toBe(before.ino);
    expect(fs.readFileSync(path.join(f.state.targetPath, 'index.mjs'), 'utf8')).toContain('version = 2');
    expect(fs.existsSync(f.state.sourcePath)).toBe(true);
    expect(f.dependencies.proveLocalNtfs).toHaveBeenCalledOnce();
  });

  it('bounds a permanent lock and leaves source and copied stage for their existing native owner', async () => {
    const f = fixture();
    const refusal = f.error();
    const dispatch = vi.fn(async () => { throw refusal; });
    await expect(createPluginDirectoryPublicationRecovery(f.state, f.dependencies)(refusal, dispatch)).rejects.toBe(refusal);
    expect(dispatch.mock.calls.length).toBeGreaterThan(1);
    expect(dispatch.mock.calls.length).toBeLessThan(15);
    expect(fs.existsSync(f.state.targetPath)).toBe(false);
    expect(fs.readFileSync(path.join(f.state.sourcePath, 'index.mjs'), 'utf8')).toBe(fs.readFileSync(path.join(f.state.staged, 'index.mjs'), 'utf8'));
  });

  it.each([
    { code: 'EACCES' }, { code: 'CLIENT_TIMEOUT' }, { syscall: 'open' },
    { path: 'another-stage' }, { dest: 'another-target' },
  ])('does not recover an unrelated or uncertain error: %j', async extra => {
    const f = fixture();
    const error = f.error(extra);
    const dispatch = vi.fn();
    await expect(createPluginDirectoryPublicationRecovery(f.state, f.dependencies)(error, dispatch)).rejects.toBe(error);
    expect(dispatch).not.toHaveBeenCalled();
    expect(f.dependencies.proveLocalNtfs).not.toHaveBeenCalled();
  });

  it('leaves every non-Windows call unchanged', () => {
    const f = fixture();
    expect(createPluginDirectoryPublicationRecovery(f.state, { ...f.dependencies, platform: 'linux' })).toBeUndefined();
    expect(f.dependencies.proveLocalNtfs).not.toHaveBeenCalled();
  });

  it('refuses network, mapped and unknown volumes before waiting or sending again', async () => {
    const f = fixture();
    f.dependencies.proveLocalNtfs.mockResolvedValue(false);
    const refusal = f.error();
    const dispatch = vi.fn();
    await expect(createPluginDirectoryPublicationRecovery(f.state, f.dependencies)(refusal, dispatch)).rejects.toBe(refusal);
    expect(f.dependencies.wait).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('includes slow volume proof in the original five-second recovery budget', async () => {
    const f = fixture();
    f.dependencies.proveLocalNtfs.mockImplementation(async () => { f.elapse(5_000); return true; });
    const refusal = f.error();
    const dispatch = vi.fn();
    await expect(createPluginDirectoryPublicationRecovery(f.state, f.dependencies)(refusal, dispatch)).rejects.toBe(refusal);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('preserves a changed native owner and never sends after its wait', async () => {
    const f = fixture();
    const ownerError = new Error('Native lease expired');
    f.duringWait(() => f.state.assertCurrent.mockImplementation(() => { throw ownerError; }));
    const dispatch = vi.fn();
    await expect(createPluginDirectoryPublicationRecovery(f.state, f.dependencies)(f.error(), dispatch)).rejects.toBe(ownerError);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['copied bytes', (f: ReturnType<typeof fixture>) => fs.writeFileSync(path.join(f.state.staged, 'index.mjs'), 'unreviewed')],
    ['copied file identity', (f: ReturnType<typeof fixture>) => { const file = path.join(f.state.staged, 'index.mjs'); fs.renameSync(file, file + '.old'); fs.copyFileSync(file + '.old', file); fs.unlinkSync(file + '.old'); }],
    ['copied extra file', (f: ReturnType<typeof fixture>) => fs.writeFileSync(path.join(f.state.staged, 'new.txt'), 'extra')],
    ['copied hardlink', (f: ReturnType<typeof fixture>) => fs.linkSync(path.join(f.state.staged, 'index.mjs'), path.join(f.root, 'alias'))],
    ['source bytes', (f: ReturnType<typeof fixture>) => fs.writeFileSync(path.join(f.state.sourcePath, 'index.mjs'), 'changed source')],
    ['source extra file', (f: ReturnType<typeof fixture>) => fs.writeFileSync(path.join(f.state.sourcePath, 'new.txt'), 'extra')],
    ['source hardlink', (f: ReturnType<typeof fixture>) => fs.linkSync(path.join(f.state.sourcePath, 'index.mjs'), path.join(f.root, 'alias'))],
    ['competing target', (f: ReturnType<typeof fixture>) => fs.mkdirSync(f.state.targetPath)],
  ])('rejects a changed %s before native dispatch', async (_label, mutate) => {
    const f = fixture();
    f.duringWait(() => mutate(f));
    const dispatch = vi.fn();
    await expect(createPluginDirectoryPublicationRecovery(f.state, f.dependencies)(f.error(), dispatch)).rejects.toBeDefined();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not reinterpret a synchronous dispatch guard exception as another native refusal', async () => {
    const f = fixture();
    const guardFailure = f.error();
    const dispatch = vi.fn(() => { throw guardFailure; });
    await expect(createPluginDirectoryPublicationRecovery(f.state, f.dependencies)(f.error(), dispatch)).rejects.toBe(guardFailure);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(f.dependencies.wait).toHaveBeenCalledOnce();
  });

  it('stops on an uncertain later send instead of repeating it', async () => {
    const f = fixture();
    const unknown = f.error({ code: 'ETIMEDOUT' });
    const dispatch = vi.fn(async () => { throw unknown; });
    await expect(createPluginDirectoryPublicationRecovery(f.state, f.dependencies)(f.error(), dispatch)).rejects.toBe(unknown);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('caps slow synchronous verification before it can consume the five-second wait budget', async () => {
    const f = fixture();
    const slowFs = { ...fs, lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
      f.elapse(60);
      return fs.lstatSync(...args);
    } };
    const refusal = f.error();
    const dispatch = vi.fn();
    await expect(createPluginDirectoryPublicationRecovery(f.state, { ...f.dependencies, fs: slowFs })(refusal, dispatch)).rejects.toBe(refusal);
    expect(dispatch).not.toHaveBeenCalled();
    expect(f.dependencies.wait).toHaveBeenCalledOnce();
  });

  it('rejects a large file before synchronous byte reads', async () => {
    const f = fixture();
    // Keep real files small: the admitted metadata models a legitimately large artifact.
    const realStat = fs.lstatSync.bind(fs);
    const largeFs = { ...fs, lstatSync: (file: fs.PathLike, options: { bigint: true }) => {
      const observed = realStat(file, options);
      return observed.isFile() ? Object.assign(Object.create(Object.getPrototypeOf(observed)), observed, { size: 65n * 1024n * 1024n }) : observed;
    }, readSync: vi.fn(fs.readSync) };
    const alter = (value: unknown) => {
      const manifest = value as { kind: string; children: Array<{ manifest: unknown }>; size: bigint };
      if (manifest.kind === 'directory') manifest.children.forEach(child => alter(child.manifest));
      else manifest.size = 65n * 1024n * 1024n;
    };
    alter(f.state.manifest);
    const refusal = f.error();
    const dispatch = vi.fn();
    await expect(createPluginDirectoryPublicationRecovery(f.state, { ...f.dependencies, fs: largeFs })(refusal, dispatch)).rejects.toBe(refusal);
    expect(dispatch).not.toHaveBeenCalled();
    expect(largeFs.readSync).not.toHaveBeenCalled();
  });

  it('rejects a source read-open ctime transition without rewriting the cleanup manifest', async () => {
    const f = fixture();
    const originalManifest = structuredClone(f.state.manifest);
    const sourceFile = path.join(f.state.sourcePath, 'index.mjs');
    let sourceFd: number | undefined;
    const closeSync = vi.fn(fs.closeSync);
    const advancingFs = {
      ...fs, closeSync,
      openSync: (...args: Parameters<typeof fs.openSync>) => {
        const fd = fs.openSync(...args);
        if (args[0] === sourceFile) sourceFd = fd;
        return fd;
      },
      fstatSync: (fd: number, options: { bigint: true }) => {
        const observed = fs.fstatSync(fd, options);
        return fd === sourceFd ? Object.assign(Object.create(Object.getPrototypeOf(observed)), observed, { ctimeNs: observed.ctimeNs + 1n }) : observed;
      },
    };
    const dispatch = vi.fn();
    await expect(createPluginDirectoryPublicationRecovery(f.state, { ...f.dependencies, fs: advancingFs })(f.error(), dispatch)).rejects.toMatchObject({ code: 'ESTALE' });
    expect(dispatch).not.toHaveBeenCalled();
    expect(f.state.manifest).toEqual(originalManifest);
    expect(sourceFd).toBeDefined();
    expect(closeSync).toHaveBeenCalledWith(sourceFd);
  });
});

describe.skipIf(!nativeAvailable)('native retained installed-tree transactions', () => {
  function installedFixture() {
    const f = fixture();
    const policy = 'outbound-header-policy.json';
    fs.writeFileSync(path.join(f.state.sourcePath, policy), '{"schemaVersion":1,"groups":[]}');
    fs.cpSync(f.state.sourcePath, f.state.targetPath, { recursive: true });
    fs.writeFileSync(path.join(f.state.targetPath, 'index.mjs'), 'export const version = 1;\n');
    const retained = path.join(f.root, 'retained-policy.json');
    fs.linkSync(path.join(f.state.targetPath, policy), retained);
    const retainedInode = fs.statSync(retained, { bigint: true }).ino;
    const params = {
      sourceDir: f.state.sourcePath, targetDir: f.state.targetPath, mode: 'update',
      timeoutMs: 1_000, copyErrorPrefix: 'failed to copy plugin', hasDeps: false,
      depsLogMessage: '', sourceHardlinks: 'reject', allowInstalledTreeHardlinks: true,
      windowsPluginPublicationRecovery: true,
    };
    const expectOriginal = () => {
      expect(fs.readFileSync(path.join(f.state.targetPath, 'index.mjs'), 'utf8')).toContain('version = 1');
      expect(fs.readFileSync(retained, 'utf8')).toBe('{"schemaVersion":1,"groups":[]}');
      expect(fs.statSync(retained, { bigint: true }).ino).toBe(retainedInode);
    };
    return { ...f, policy, retained, retainedInode, params, expectOriginal };
  }

  it('moves the retained old tree while publishing an independent new tree', async () => {
    const f = installedFixture();
    fs.linkSync(f.retained, path.join(f.root, 'second-retained-policy.json'));
    const native = await nativeInstaller();
    const result = await native.installPackageDir(f.params);
    expect(result).toEqual({ ok: true });
    expect(native.move.mock.calls.map(([options]) => options.sourceHardlinks)).toEqual(['allow', 'reject']);
    expect(native.move.mock.calls.map(([options]) => options.windowsPluginPublicationRecovery)).toEqual([false, true]);
    expect(fs.readFileSync(path.join(f.state.targetPath, 'index.mjs'), 'utf8')).toContain('version = 2');
    expect(fs.readFileSync(f.retained, 'utf8')).toBe('{"schemaVersion":1,"groups":[]}');
    expect(fs.statSync(f.retained, { bigint: true }).ino).toBe(f.retainedInode);
    expect(fs.statSync(path.join(f.state.targetPath, f.policy), { bigint: true }).ino).not.toBe(f.retainedInode);
    expect(fs.statSync(path.join(f.state.sourcePath, f.policy)).nlink).toBe(1);
  }, 20_000);

  it.each(['backup validation', 'post-publication copy fallback'])(
    'restores old bytes after %s, retaining the real old alias', async failure => {
      const f = installedFixture();
      const native = await nativeInstaller();
      const originalDirectory = fs.statSync(f.state.targetPath, { bigint: true }).ino;
      const rename = fsp.rename.bind(fsp);
      let backup: string | undefined;
      if (failure === 'post-publication copy fallback') vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
        if (String(to).includes('.openclaw-install-backups') && from === f.state.targetPath || from === backup)
          throw Object.assign(new Error('cross-device fixture'), { code: 'EXDEV' });
        return rename(from, to);
      });
      const params = { ...f.params, afterBackup: async (directory: string) => {
        backup = directory;
        if (failure === 'backup validation') return { ok: false, error: 'review refused displaced original' };
        expect(fs.statSync(directory, { bigint: true }).ino).not.toBe(originalDirectory);
        return { ok: true };
      } };
      const result = await native.installPackageDir(failure === 'backup validation' ? params
        : native.requestDeferredPackageDirInstall(params, () => {}));
      if (failure === 'backup validation') expect(result).toMatchObject({ ok: false, error: 'review refused displaced original' });
      else {
        expect(result.ok).toBe(true);
        expect(fs.readFileSync(path.join(f.state.targetPath, 'index.mjs'), 'utf8')).toContain('version = 2');
        await native.resolvePackageDirInstallTransaction(result).rollback();
        expect(fs.statSync(f.state.targetPath, { bigint: true }).ino).not.toBe(originalDirectory);
      }
      f.expectOriginal();
      expect(native.move.mock.calls.at(-1)?.[0].sourceHardlinks).toBe('allow');
      expect(native.move.mock.calls.at(-1)?.[0].windowsPluginPublicationRecovery).toBeUndefined();
    }, 20_000,
  );

  it('keeps generic callers strict when no installed-tree opt-in was supplied', async () => {
    const f = installedFixture();
    const native = await nativeInstaller();
    const result = await native.installPackageDir({ ...f.params, allowInstalledTreeHardlinks: undefined });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Refusing to move hardlinked file') });
    expect(native.move).toHaveBeenCalledOnce();
    expect(native.move.mock.calls[0][0].sourceHardlinks).toBe('reject');
    f.expectOriginal();
  }, 20_000);

  it('rejects a new staging hardlink and rolls back instead of widening incoming admission', async () => {
    const f = installedFixture();
    const native = await nativeInstaller();
    const result = await native.installPackageDir({ ...f.params, afterCopy: (staged: string) =>
      fs.linkSync(path.join(staged, f.policy), path.join(f.root, 'untrusted-new-alias')) });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('Refusing to move hardlinked file') });
    expect(native.move.mock.calls.map(([options]) => options.sourceHardlinks)).toEqual(['allow', 'reject', 'allow']);
    f.expectOriginal();
  }, 20_000);

  it('retains the first owner refusal without replaying publication or overwriting recovery state', async () => {
    const f = installedFixture();
    const native = await nativeInstaller();
    const rename = vi.spyOn(fsp, 'rename');
    let displaced = false;
    let refused = false;
    const owned = vi.fn(() => {
      if (displaced && !refused) { refused = true; throw new Error('native lease expired'); }
    });
    let backup = '';
    const result = await native.installPackageDir(native.requestDeferredPackageDirInstall({ ...f.params,
      afterBackup: async (directory: string) => { displaced = true; backup = directory; return { ok: true }; },
    }, owned));
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('native lease expired') });
    expect(result.error).toContain('backup recovery path:');
    expect(rename).toHaveBeenCalledOnce();
    expect(fs.existsSync(f.state.targetPath)).toBe(false);
    expect(fs.readFileSync(path.join(backup, 'index.mjs'), 'utf8')).toContain('version = 1');
    expect(fs.statSync(f.retained, { bigint: true }).ino).toBe(f.retainedInode);
  }, 20_000);
});

describe('current-shape native publication patch', () => {
  it.each(Object.keys(patch.__testing.TARGETS))('transforms %s once and rejects changed or mixed shapes', kind => {
    const changes = patch.__testing.CHANGES[kind] as Array<[string, string, number?]>;
    const original = changes.map(([before, _after, count = 1]) => Array(count).fill(before).join('\n')).join('\n');
    const transformed = patch.__testing.transform(original, kind);
    expect(patch.__testing.transform(transformed, kind)).toBe(transformed);
    expect(() => patch.__testing.transform(original.replace(changes[0][0], 'unexpected'), kind)).toThrow(/partial/);
    expect(() => patch.__testing.transform(transformed.replace(patch.__testing.CONTRACT, ''), kind)).toThrow(/marker/);
  });

  it.skipIf(!nativeAvailable)('applies to all actual pinned files, is byte-idempotent and rejects partial application', () => {
    fs.mkdirSync(artifacts, { recursive: true });
    const root = fs.mkdtempSync(path.join(artifacts, 'contract-'));
    roots.push(root);
    for (const relative of [...Object.values(patch.__testing.TARGETS), 'node_modules/@openclaw/fs-safe/package.json'] as string[]) {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, nativeSource(relative));
    }
    expect(() => patch.verifyPatch(root)).toThrow(/missing/);
    expect(patch.applyPatch(root)).toHaveLength(4);
    patch.verifyPatch(root);
    expect(patch.applyPatch(root)).toEqual([]);
    const native = path.join(root, patch.__testing.TARGETS.install);
    fs.writeFileSync(native, nativeSource(patch.__testing.TARGETS.install));
    expect(() => patch.applyPatch(root)).toThrow(/Mixed/);
  });

  it.skipIf(!nativeAvailable)('rejects the complete former 033 source shape rather than upgrading it in place', () => {
    const selectors = [
      'sourceHardlinks: params.allowInstalledTreeHardlinks === true && kind === "backup" ? "allow" : sourceHardlinks,',
      'sourceHardlinks: params.allowInstalledTreeHardlinks === true ? "allow" : sourceHardlinks,',
    ];
    const install = patch.__testing.transform(nativeSource(patch.__testing.TARGETS.install), 'install');
    const formerInstall = selectors.reduce((source, selector) => source.replace(selector, 'sourceHardlinks,'), install);
    expect(formerInstall).not.toBe(install);
    expect(() => patch.__testing.transform(formerInstall, 'install')).toThrow(/partial|historical/);
    const plugin = patch.__testing.transform(nativeSource(patch.__testing.TARGETS.plugin), 'plugin');
    const formerPlugin = plugin.replace('\n\t\tallowInstalledTreeHardlinks: true,', '');
    expect(formerPlugin).not.toBe(plugin);
    expect(() => patch.__testing.transform(formerPlugin, 'plugin')).toThrow(/partial|historical/);
  });

  it.skipIf(!nativeAvailable)('isolates the real guardedRename syscall catch from authority, receipt and post-guard errors', async () => {
    const original = nativeSource(patch.__testing.TARGETS.guard);
    const transformed = patch.__testing.transform(original, 'guard');
    const create = (request: (from: string, to: string) => Promise<void>, check: () => void = vi.fn(), post: () => void = vi.fn()) => {
      const source = transformed.replace(/^import .*;\r?\n/gm, '').replace(/\bexport (?=(?:async )?function)/g, '');
      const guard = { request: 0 };
      return new Function('fs', 'fsSync', 'path', 'createAsyncDirectoryGuard', 'assertDirectoryGuard', 'assertSyncDirectoryGuard', 'createSyncDirectoryGuard', source + '\nreturn guardedRename;')(
        { rename: request }, { lstatSync: () => ({}) }, path, async () => guard,
        () => { guard.request += 1; if (guard.request > 2) post(); }, check, () => guard,
      );
    };
    const refusal = Object.assign(new Error('EPERM from callback'), { code: 'EPERM' });
    const first = vi.fn(async () => undefined);
    const recover = vi.fn();
    await expect(create(first)({ from: 'source', to: 'target', assertBeforeRename: () => { throw refusal; }, recoverRename: recover })).rejects.toBe(refusal);
    expect(first).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    await expect(create(first)({ from: 'source', to: 'target', onRenamed: () => { throw refusal; }, recoverRename: recover })).rejects.toBe(refusal);
    expect(first).toHaveBeenCalledOnce();
    expect(recover).not.toHaveBeenCalled();
    await expect(create(first, vi.fn(), () => { throw refusal; })({ from: 'source', to: 'target', recoverRename: recover })).rejects.toBe(refusal);
    expect(recover).not.toHaveBeenCalled();
    const syscall = vi.fn().mockRejectedValueOnce(refusal).mockResolvedValue(undefined);
    const checks = vi.fn();
    const received = vi.fn();
    const retry = vi.fn(async (_error, dispatch) => dispatch());
    await create(syscall, checks)({ from: 'source', to: 'target', recoverRename: retry, onRenamed: received });
    expect(syscall).toHaveBeenCalledTimes(2);
    expect(checks).toHaveBeenCalledTimes(2);
    expect(received).toHaveBeenCalledOnce();
  });

  it.skipIf(!nativeAvailable)('verifies complete actual owner semantics after bundling and rejects a disabled or stale boundary', async () => {
    const owners: Record<string, string[]> = {
      move: ['movePathWithCopyFallback', 'copyEntryWithManifest'], guard: ['guardedRename'],
      install: ['installPackageDir'], plugin: ['installPluginDirectoryIntoExtensions'],
    };
    const sources = Object.fromEntries(Object.entries(patch.__testing.TARGETS).map(([kind, relative]) =>
      [kind, patch.__testing.transform(nativeSource(relative as string), kind)]));
    const modules = Object.fromEntries(Object.entries(owners).map(([kind, names]) => {
      const imports = sources[kind].match(/^import .* from ["']node:[^"']+["'];?$/gm)?.join('\n') ?? '';
      return [kind, imports + '\n' + (kind === 'move' ? 'import { createPluginDirectoryPublicationRecovery } from "fixture:support";\nimport { guardedRename } from "fixture:guard";\n' : '') +
        (kind === 'move' ? 'import { sameIdentity, modeBits } from "fixture:native";\n' : '') +
        (kind === 'install' ? 'import { movePathWithCopyFallback } from "fixture:move";\nimport { pathExists as pathExists$1 } from "fixture:native";\n' : '') +
        names.map(name => 'export ' + patch.__testing.functionBody(sources[kind], name)).join('\n')];
    }));
    modules.support = fs.readFileSync(patch.__testing.SUPPORT_SOURCE, 'utf8');
    modules.native = 'import fsSync from "node:fs";\n' + Object.values(patch.__testing.NATIVE_BINDINGS).map(body => 'export ' + body).join('\n');
    const output = await build({
      stdin: { contents: Object.entries(owners).map(([kind, names]) => `export { ${names.join(', ')} } from "fixture:${kind}";`).join('\n') },
      bundle: true, platform: 'node', format: 'esm', write: false,
      plugins: [{ name: 'isolated-native-owner-contract', setup(builder) {
        builder.onResolve({ filter: /^fixture:/ }, args => ({ path: args.path.slice(8), namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: modules[args.path], loader: 'js' }));
      } }],
    });
    const bundle = output.outputFiles[0].text;
    expect(() => patch.__testing.verifyBundle(bundle, sources)).not.toThrow();
    expect(() => patch.__testing.verifyBundle(bundle.replace('windowsPluginPublicationRecovery: true', 'windowsPluginPublicationRecovery: false'), sources)).toThrow();
    expect(() => patch.__testing.verifyBundle(bundle.replace('allowInstalledTreeHardlinks: true', 'allowInstalledTreeHardlinks: false'), sources)).toThrow();
    expect(() => patch.__testing.verifyBundle(bundle.replace('now() + 100', 'now() + 5000'), sources)).toThrow();
  });
});
