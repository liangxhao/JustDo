import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { resolveManagedMcpFile } from '../mcp/managedMcpFile';
import type { NativeMcpDataBinding } from './nativeMcpData';
import {
  nativeMcpDataDirectory, ownedNativeMcpDataServerNames, prepareNativeMcpData, projectNativeMcpData,
  publishNativeMcpDataReceipt, suspendNativeMcpDataServers,
} from './nativeMcpData';
import { inspectPluginData } from './pluginDataService';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    expect(path.dirname(root)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(root).startsWith('native-mcp-data-')).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
type Config = { plugins: { entries: Record<string, { enabled?: boolean; config?: Record<string, unknown> }> }; mcp: { servers: Record<string, unknown> } };
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-mcp-data-'));
  roots.push(root);
  const state = path.join(root, 'state');
  fs.mkdirSync(state);
  await prepareNativeMcpData(state, ['sample']);
  const file = path.join(state, 'openclaw.json'), receipt = `${file}.plugin-data.json`;
  const binding: NativeMcpDataBinding = { pluginId: 'sample', servers: { sample: {
    command: 'node', args: [path.join(root, 'extension', 'server.cjs')], cwd: path.join(root, 'extension'),
    env: { PLUGIN_DATA: '${PLUGIN_DATA}', TOKEN: 'synthetic-secret' },
  } } };
  const config: Config = { plugins: { entries: { sample: { enabled: true, config: { other: 'retained' } } } }, mcp: { servers: {} } };
  const project = (value = config, bindings: NativeMcpDataBinding[] = [binding], userNames = new Set<string>()) =>
    projectNativeMcpData(value, bindings, state, file, userNames);
  const save = (value = config, bindings = [binding]) => {
    const next = project(value, bindings);
    publishNativeMcpDataReceipt(file, next, () => fs.writeFileSync(file, JSON.stringify(value)));
    return next;
  };
  return { root, state, file, receipt, binding, config, project, save };
}

test('resolves only an exact named document of the current managed service', async () => {
  const f = await fixture();
  f.save();
  const id = '660fec46-853c-4b83-b477-dbb07a84e749';
  const cwd = path.join(nativeMcpDataDirectory(f.state, 'sample'), 'files', id);
  const filePath = path.join(cwd, '原始文档.xlsx');
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(filePath, 'fixture');
  const input = { serverName: 'sample', relativePath: `files/${id}/原始文档.xlsx`, gatewayUrl: 'ws://127.0.0.1:12345' };
  const gateway = { port: 12345, isCurrent: () => true };
  const admitted = resolveManagedMcpFile(f.state, f.file, input, gateway);
  expect(admitted).toMatchObject({ filePath, cwd, name: '原始文档.xlsx' });
  expect(() => resolveManagedMcpFile(f.state, f.file, { ...input, gatewayUrl: 'ws://remote.invalid:12345' }, gateway))
    .toThrow('requires the local Gateway');
  expect(() => resolveManagedMcpFile(f.state, f.file, { ...input, gatewayUrl: 'ws://localhost:12346/' }, gateway))
    .toThrow('requires the local Gateway');

  const next = path.join(cwd, 'editing.tmp');
  fs.writeFileSync(next, 'saved content');
  fs.renameSync(next, filePath);
  expect(() => admitted.assertCurrent()).not.toThrow();
  f.config.mcp.servers.sample = { command: 'operator-override' };
  fs.writeFileSync(f.file, JSON.stringify(f.config));
  expect(() => admitted.assertCurrent()).toThrow('Managed App data is unavailable');
});

test('refuses a path outside the named document scope or with a different filesystem identity', async () => {
  const f = await fixture();
  f.save();
  const id = '660fec46-853c-4b83-b477-dbb07a84e749';
  const base = nativeMcpDataDirectory(f.state, 'sample');
  const cwd = path.join(base, 'files', id);
  const relativePath = `files/${id}/document.txt`;
  const resolve = (name = relativePath) => resolveManagedMcpFile(f.state, f.file, {
    serverName: 'sample', relativePath: name, gatewayUrl: 'ws://localhost:12345/',
  }, { port: 12345, isCurrent: () => true });
  fs.mkdirSync(cwd, { recursive: true });
  const filePath = path.join(cwd, 'document.txt');
  fs.writeFileSync(filePath, 'fixture');
  expect(() => resolve(`files/${id}/../knowledge.sqlite`)).toThrow('Invalid managed App file');
  expect(() => resolve(`files/${id}/document.txt:alternate`)).toThrow('Invalid managed App file');
  fs.linkSync(filePath, path.join(f.root, 'hardlink.txt'));
  expect(resolve).toThrow('Managed App file is unavailable');
  fs.unlinkSync(path.join(f.root, 'hardlink.txt'));

  const admitted = resolve();
  fs.renameSync(cwd, path.join(base, 'files', `${id}-moved`));
  fs.mkdirSync(cwd);
  fs.writeFileSync(filePath, 'different directory');
  expect(() => admitted.assertCurrent()).toThrow('Managed App file changed');
});

test('uses SDK-owned data in both configs and stores only digests and durable owner identity', async () => {
  const f = await fixture();
  const before = structuredClone(f.binding);
  const receipt = f.save()!;
  const directory = nativeMcpDataDirectory(f.state, 'sample');
  await expect(inspectPluginData(f.state, ['sample'])).resolves.toMatchObject({ exists: true, canDelete: true });
  expect(f.config.plugins.entries.sample.config?.dataDirectory).toBe(directory);
  expect(f.config.mcp.servers.sample).toMatchObject({ command: 'node', env: { PLUGIN_DATA: directory, TOKEN: 'synthetic-secret' } });
  expect(receipt).not.toContain('synthetic-secret');
  expect(receipt).not.toContain('server.cjs');
  expect(receipt).toContain('dataId');
  const stored = JSON.parse(receipt);
  expect(stored.entries.every((entry: Record<string, unknown>) => !Object.hasOwn(entry, 'directory'))).toBe(true);
  stored.entries.forEach((entry: Record<string, unknown>) => { entry.directory = directory; });
  fs.writeFileSync(f.receipt, JSON.stringify(stored));
  expect(f.binding).toEqual(before);
  expect(f.project()).toBe(receipt);
  expect(ownedNativeMcpDataServerNames(f.file, f.state)).toEqual(new Set(['sample']));
});

test('deduplicates live initialization of the same canonical owner and retains existing bytes', async () => {
  const f = await fixture();
  await Promise.all(Array.from({ length: 8 }, (_, index) =>
    prepareNativeMcpData(index % 2 ? path.join(f.state, '.') : f.state, ['concurrent-owner'])));
  const directory = nativeMcpDataDirectory(f.state, 'concurrent-owner');
  const owner = fs.readFileSync(path.join(directory, '.owner.json'), 'utf8');
  fs.writeFileSync(path.join(directory, 'retained.bin'), 'existing-library');
  await Promise.all(Array.from({ length: 4 }, () => prepareNativeMcpData(f.state, ['concurrent-owner'])));
  expect(fs.readFileSync(path.join(directory, '.owner.json'), 'utf8')).toBe(owner);
  expect(fs.readFileSync(path.join(directory, 'retained.bin'), 'utf8')).toBe('existing-library');
  expect(fs.readdirSync(path.dirname(directory)).some(name => name.startsWith('.preparing-'))).toBe(false);
});

test('withdraws generated values on disable/removal while preserving operator overrides and tombstones', async () => {
  const f = await fixture();
  f.save();
  f.config.mcp.servers.user = { command: 'custom' };
  f.save(f.config, []);
  expect(f.config.mcp.servers).toEqual({ user: { command: 'custom' } });
  expect(f.config.plugins.entries.sample.config).toEqual({ other: 'retained' });
  f.config.mcp.servers.sample = { enabled: false };
  f.save();
  expect(f.config.mcp.servers.sample).toEqual({ enabled: false });
  f.config.plugins.entries.sample.config!.dataDirectory = path.join(f.root, 'operator-data');
  f.config.mcp.servers.sample = { command: 'operator', env: { TOKEN: 'operator-value' } };
  const expected = structuredClone(f.config);
  f.save(f.config, []);
  expect(f.config).toEqual(expected);
  expect(ownedNativeMcpDataServerNames(f.file, f.state)).toEqual(new Set());
});

test('operator-managed names win even if their values equal a previous generated value', async () => {
  const f = await fixture();
  f.save();
  const expected = structuredClone(f.config.mcp.servers.sample);
  f.project(f.config, [], new Set(['sample']));
  expect(f.config.mcp.servers.sample).toEqual(expected);
});

test('keeps a suspension associated with the currently selected owner of a shared server name', async () => {
  const f = await fixture();
  const replacement = {
    pluginId: 'replacement',
    servers: { sample: { ...f.binding.servers.sample, args: ['replacement.cjs'] } },
  };
  await prepareNativeMcpData(f.state, [replacement.pluginId]);
  const suspend = (owner: string) => {
    const suspension = suspendNativeMcpDataServers(f.config, new Set([owner]), f.state, f.file, new Set())!;
    publishNativeMcpDataReceipt(f.file, suspension.receipt, () => fs.writeFileSync(f.file, JSON.stringify(f.config)));
  };
  f.save();
  suspend(f.binding.pluginId);
  f.save(f.config, [replacement]);
  expect(f.config.mcp.servers.sample).toMatchObject({ args: ['replacement.cjs'] });

  suspend(replacement.pluginId);
  f.save(f.config, [replacement]);
  expect(f.config.mcp.servers.sample).toEqual({ enabled: false });
});

test('retains observed old hashes across a crash between receipt and config publication', async () => {
  const f = await fixture();
  f.save();
  const old = JSON.parse(fs.readFileSync(f.file, 'utf8')) as Config;
  f.binding.servers.sample.args = ['new-server.cjs'];
  const next = f.project();
  // Power loss after this write leaves the old on-disk config, rather than the projected one.
  fs.writeFileSync(f.receipt, next!);
  f.project(old, []);
  expect(old.mcp.servers.sample).toBeUndefined();
  expect(old.plugins.entries.sample.config?.dataDirectory).toBeUndefined();
});

test('restores receipt on config failure and never calls publication when receipt cannot be saved', async () => {
  const f = await fixture();
  f.save();
  const before = fs.readFileSync(f.receipt, 'utf8');
  f.binding.servers.sample.args = ['new-server.cjs'];
  const next = f.project();
  expect(() => publishNativeMcpDataReceipt(f.file, next, () => { throw new Error('config write refused'); })).toThrow('config write refused');
  expect(fs.readFileSync(f.receipt, 'utf8')).toBe(before);
  const rename = fs.renameSync;
  vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === f.receipt) throw new Error('receipt write refused');
    rename(from, to);
  });
  const publish = vi.fn();
  expect(() => publishNativeMcpDataReceipt(f.file, next, publish)).toThrow('receipt write refused');
  expect(publish).not.toHaveBeenCalled();
  expect(fs.readFileSync(f.receipt, 'utf8')).toBe(before);
  expect(fs.readdirSync(f.state).some(name => name.endsWith('.tmp'))).toBe(false);
});

test('relocates generated values only with the SDK data identity carried by the moved state root', async () => {
  const f = await fixture();
  f.save();
  const moved = path.join(f.root, 'moved');
  fs.cpSync(f.state, moved, { recursive: true });
  const movedFile = path.join(moved, 'openclaw.json');
  const config = JSON.parse(fs.readFileSync(movedFile, 'utf8')) as Config;
  projectNativeMcpData(config, [f.binding], moved, movedFile);
  expect(config.plugins.entries.sample.config?.dataDirectory).toBe(nativeMcpDataDirectory(moved, 'sample'));
  expect(config.mcp.servers.sample).toMatchObject({ env: { PLUGIN_DATA: nativeMcpDataDirectory(moved, 'sample') } });
  const unrelated = path.join(f.root, 'unrelated');
  fs.mkdirSync(unrelated);
  await prepareNativeMcpData(unrelated, ['sample']);
  const unrelatedFile = path.join(unrelated, 'openclaw.json');
  fs.copyFileSync(f.receipt, `${unrelatedFile}.plugin-data.json`);
  const operator = JSON.parse(fs.readFileSync(f.file, 'utf8')) as Config;
  const before = structuredClone(operator);
  expect(() => projectNativeMcpData(operator, [f.binding], unrelated, unrelatedFile)).toThrow('relocation could not be confirmed');
  expect(operator).toEqual(before);
});
