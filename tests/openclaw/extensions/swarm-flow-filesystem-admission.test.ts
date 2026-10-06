import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { captureFilesystemAdmission, permissionFingerprint } from '../../../openclaw-extensions/swarm-flow/filesystem-admission';

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })));
function fixture() {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'swarm-fs-admission-')); directories.push(cwd);
  const config = { tools: { fs: { workspaceOnly: true } }, agents: { defaults: { workspace: cwd, maxConcurrent: 4 } } };
  return { cwd, config, context: { fsPolicy: { workspaceOnly: true, root: cwd }, workspaceDir: cwd, config, runtimeConfig: config } };
}
it('requires trusted filesystem context, a writable host and the exact parent project', () => {
  const f = fixture();
  expect(captureFilesystemAdmission(f.context, f.cwd, 'workspace', f.config).root).toBe(f.cwd);
  expect(() => captureFilesystemAdmission({ ...f.context, fsPolicy: undefined }, f.cwd, 'full', f.config)).toThrow('native host');
  expect(() => captureFilesystemAdmission({ ...f.context, sandboxed: true }, f.cwd, 'full', f.config)).toThrow('native host');
  expect(() => captureFilesystemAdmission(f.context, f.cwd, 'read-only', f.config)).toThrow('native host');
  const other = fixture();
  expect(() => captureFilesystemAdmission({ ...f.context, fsPolicy: { workspaceOnly: true, root: other.cwd } }, f.cwd, 'workspace', f.config)).toThrow('outside');
});
it('invalidates a captured admission on permission changes but preserves numeric hot settings', () => {
  const f = fixture();
  const hot = { ...f.config, agents: { defaults: { ...f.config.agents.defaults, maxConcurrent: 8 } }, plugins: { entries: { 'swarm-flow': { config: { globalConcurrency: 7 } } } } };
  expect(permissionFingerprint(hot)).toBe(permissionFingerprint(f.config));
  expect(captureFilesystemAdmission(f.context, f.cwd, 'workspace', hot)).toBeDefined();
  const rosterChange = { ...f.config, agents: { ...f.config.agents, entries: { other: { workspace: '/different-workspace', tools: { deny: ['write'] } } } } };
  expect(permissionFingerprint(rosterChange)).toBe(permissionFingerprint(f.config));
  expect(permissionFingerprint(rosterChange, ['other'])).not.toBe(permissionFingerprint(f.config, ['other']));
  const revoked = { ...f.config, tools: { deny: ['write'] } };
  expect(() => captureFilesystemAdmission(f.context, f.cwd, 'workspace', revoked)).toThrow('outdated');
  expect(() => captureFilesystemAdmission({ ...f.context, runtimeConfig: revoked, getRuntimeConfig: () => revoked }, f.cwd, 'workspace', revoked)).toThrow('outdated');
  expect(() => captureFilesystemAdmission({ ...f.context, getRuntimeConfig: () => revoked }, f.cwd, 'workspace', f.config)).toThrow('outdated');
});
