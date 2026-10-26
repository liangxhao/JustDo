import { historicalRuntime } from './historical-runtime';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { build } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { createPluginDirectoryPublicationRecovery } = require('../../../../src/main/openclaw/runtime/native-support/plugin-directory-publication.mjs');
const patch = require('../../../../scripts/patches/v2026.10.6/033-windows-plugin-directory-publication.cjs');
const artifacts = path.resolve('.agent-tasks/plugin-publication-tests');
const roots: string[] = [];
const pristine = historicalRuntime(process.env.PLUGIN_PUBLICATION_PRISTINE);

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

describe('current-shape native publication patch', () => {
  it.each(Object.keys(patch.__testing.TARGETS))('transforms %s once and rejects changed or mixed shapes', kind => {
    const changes = patch.__testing.CHANGES[kind] as Array<[string, string, number?]>;
    const original = changes.map(([before, _after, count = 1]) => Array(count).fill(before).join('\n')).join('\n');
    const transformed = patch.__testing.transform(original, kind);
    expect(patch.__testing.transform(transformed, kind)).toBe(transformed);
    expect(() => patch.__testing.transform(original.replace(changes[0][0], 'unexpected'), kind)).toThrow(/partial/);
    expect(() => patch.__testing.transform(transformed.replace(patch.__testing.CONTRACT, ''), kind)).toThrow(/marker/);
  });

  it.skipIf(!pristine)('applies to all actual pinned files, is byte-idempotent and rejects partial application', () => {
    fs.mkdirSync(artifacts, { recursive: true });
    const root = fs.mkdtempSync(path.join(artifacts, 'contract-'));
    roots.push(root);
    for (const relative of [...Object.values(patch.__testing.TARGETS), 'node_modules/@openclaw/fs-safe/package.json'] as string[]) {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(pristine!, relative), target);
    }
    expect(() => patch.verifyPatch(root)).toThrow(/missing/);
    expect(patch.applyPatch(root)).toHaveLength(4);
    patch.verifyPatch(root);
    expect(patch.applyPatch(root)).toEqual([]);
    const native = path.join(root, patch.__testing.TARGETS.install);
    fs.copyFileSync(path.join(pristine!, patch.__testing.TARGETS.install), native);
    expect(() => patch.applyPatch(root)).toThrow(/Mixed/);
  });

  it.skipIf(!pristine)('isolates the real guardedRename syscall catch from authority, receipt and post-guard errors', async () => {
    const original = fs.readFileSync(path.join(pristine!, patch.__testing.TARGETS.guard), 'utf8');
    const transformed = patch.__testing.transform(original, 'guard');
    const create = (request: (from: string, to: string) => Promise<void>, check: () => void = vi.fn(), post: () => void = vi.fn()) => {
      const source = transformed.replace(/^import .*;\r?\n/gm, '').replace(/\bexport (?=(?:async )?function)/g, '');
      const guard = { request: 0 };
      return new Function('fs', 'fsSync', 'path', 'createAsyncDirectoryGuard', 'assertAsyncDirectoryGuard', 'assertSyncDirectoryGuard', 'createSyncDirectoryGuard', source + '\nreturn guardedRename;')(
        { rename: request }, { lstatSync: () => ({}) }, path, async () => guard,
        async () => { guard.request += 1; if (guard.request > 2) post(); }, check, () => guard,
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

  it.skipIf(!pristine)('verifies complete actual owner semantics after bundling and rejects a disabled or stale boundary', async () => {
    const owners: Record<string, string[]> = {
      move: ['movePathWithCopyFallback', 'copyEntryWithManifest'], guard: ['guardedRename'],
      install: ['installPackageDir'], plugin: ['installPluginDirectoryIntoExtensions'],
    };
    const sources = Object.fromEntries(Object.entries(patch.__testing.TARGETS).map(([kind, relative]) =>
      [kind, patch.__testing.transform(fs.readFileSync(path.join(pristine!, relative as string), 'utf8'), kind)]));
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
    fs.mkdirSync(path.resolve('build/plugin-publication'), { recursive: true });
    fs.writeFileSync(path.resolve('build/plugin-publication/publication-owner-contract.mjs'), bundle);
    expect(() => patch.__testing.verifyBundle(bundle, sources)).not.toThrow();
    expect(() => patch.__testing.verifyBundle(bundle.replace('windowsPluginPublicationRecovery: true', 'windowsPluginPublicationRecovery: false'), sources)).toThrow();
    expect(() => patch.__testing.verifyBundle(bundle.replace('now() + 100', 'now() + 5000'), sources)).toThrow();
  });
});
