import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { type CredentialNodeRuntimeSource,prepareCredentialNodeRuntime } from './credentialNodeRuntime';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function fixture(executable?: string) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-runtime 中文 '));
  roots.push(stateDir);
  const source = executable ?? path.join(stateDir, 'source.exe');
  if (!executable) fs.writeFileSync(source, 'synthetic runtime bytes');
  const runtime = { executable: source, sha256: createHash('sha256').update(fs.readFileSync(source)).digest('hex') };
  return { stateDir, source: runtime, target: path.join(stateDir, 'credentials', 'runtime', runtime.sha256, 'node.exe') };
}

describe.skipIf(process.platform !== 'win32')('private Windows credential Node', () => {
  it('publishes a real content-addressed copy without changing the source and reuses it across renewals', () => {
    const value = fixture();
    const sourceBefore = fs.statSync(value.source.executable);
    const icacls = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
    const sourceAcl = execFileSync(icacls, [value.source.executable], { windowsHide: true, encoding: 'utf8' });

    expect(prepareCredentialNodeRuntime(value.stateDir, value.source)).toBe(value.target);
    const targetStat = fs.statSync(value.target);
    expect(fs.readFileSync(value.target)).toEqual(fs.readFileSync(value.source.executable));
    expect(targetStat.ino).not.toBe(sourceBefore.ino);
    expect(targetStat.nlink).toBe(1);
    expect(fs.statSync(value.source.executable)).toMatchObject({
      ino: sourceBefore.ino, nlink: sourceBefore.nlink, size: sourceBefore.size,
      mtimeMs: sourceBefore.mtimeMs, ctimeMs: sourceBefore.ctimeMs, mode: sourceBefore.mode,
    });
    expect(execFileSync(icacls, [value.source.executable], { windowsHide: true, encoding: 'utf8' })).toBe(sourceAcl);

    const read = vi.spyOn(fs, 'readSync');
    const rename = vi.spyOn(fs, 'renameSync');
    fs.writeFileSync(path.join(value.stateDir, 'credentials', 'credentials.json'), 'synthetic renewal');
    expect(prepareCredentialNodeRuntime(value.stateDir, value.source)).toBe(value.target);
    expect(read).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });

  it('rejects a corrupt cache and never falls back to the source executable', () => {
    const value = fixture();
    prepareCredentialNodeRuntime(value.stateDir, value.source);
    fs.appendFileSync(value.target, 'corrupt');
    expect(() => prepareCredentialNodeRuntime(value.stateDir, value.source)).toThrow('cached checksum mismatch');
    expect(fs.readFileSync(value.source.executable, 'utf8')).toBe('synthetic runtime bytes');
  });

  it('keeps existing inherited credential children readable and removable when securing directories', () => {
    const value = fixture();
    const directory = path.join(value.stateDir, 'credentials');
    fs.mkdirSync(directory);
    const legacy = path.join(directory, 'credentials.bin');
    fs.writeFileSync(legacy, 'synthetic obsolete ciphertext');

    prepareCredentialNodeRuntime(value.stateDir, value.source);

    expect(fs.readFileSync(legacy, 'utf8')).toBe('synthetic obsolete ciphertext');
    const icacls = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
    const acl = execFileSync(icacls, [directory], { windowsHide: true, encoding: 'utf8' });
    expect(acl).toContain('(OI)(CI)(F)');
    fs.unlinkSync(legacy);
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it('cleans an incomplete copy on checksum failure and admits no executable', () => {
    const value = fixture();
    expect(() => prepareCredentialNodeRuntime(value.stateDir, { ...value.source, sha256: 'a'.repeat(64) }))
      .toThrow('source checksum mismatch');
    expect(fs.readdirSync(path.join(value.stateDir, 'credentials', 'runtime', 'a'.repeat(64)))).toEqual([]);
  });

  it('rejects directory junctions before changing the linked location', () => {
    const value = fixture();
    const external = path.join(value.stateDir, 'unrelated');
    fs.mkdirSync(external);
    fs.symlinkSync(external, path.join(value.stateDir, 'credentials'), 'junction');
    expect(() => prepareCredentialNodeRuntime(value.stateDir, value.source)).toThrow('ordinary private directory or file');
    expect(fs.readdirSync(external)).toEqual([]);
  });

  it('rejects a hard-linked target but permits reading a hash-verified hard-linked source', () => {
    const value = fixture();
    const alias = path.join(value.stateDir, 'source-alias.exe');
    fs.linkSync(value.source.executable, alias);
    expect(prepareCredentialNodeRuntime(value.stateDir, value.source)).toBe(value.target);
    const malicious = fixture();
    fs.mkdirSync(path.dirname(malicious.target), { recursive: true });
    fs.linkSync(malicious.source.executable, malicious.target);
    expect(() => prepareCredentialNodeRuntime(malicious.stateDir, malicious.source)).toThrow('ordinary private directory or file');
    expect(fs.statSync(malicious.source.executable).nlink).toBe(2);
  });

  it('fails closed when a managed directory cannot be created', () => {
    const value = fixture();
    vi.spyOn(fs, 'mkdirSync').mockImplementationOnce(() => { throw Object.assign(new Error('synthetic denial'), { code: 'EACCES' }); });
    expect(() => prepareCredentialNodeRuntime(value.stateDir, value.source)).toThrow('synthetic denial');
    expect(fs.existsSync(value.target)).toBe(false);
  });

  it('passes the installed public native SDK using the private executable on Unicode paths', () => {
    const value = fixture(process.execPath);
    const executable = prepareCredentialNodeRuntime(value.stateDir, value.source);
    const resolver = path.join(value.stateDir, 'resolver.cjs');
    fs.writeFileSync(resolver, `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const r=JSON.parse(input);process.stdout.write(JSON.stringify({protocolVersion:1,values:{[r.ids[0]]:'synthetic-value'}}));});`);
    const sdk = pathToFileURL(path.resolve('vendor/openclaw-runtime/current/dist/plugin-sdk/secret-ref-runtime.js')).href;
    const driver = `
      import { resolveSecretRefValues } from ${JSON.stringify(sdk)};
      try {
        const values = await resolveSecretRefValues([{source:'exec',provider:'credential_test',id:'token'}], {
          config:{secrets:{providers:{credential_test:{source:'exec',command:${JSON.stringify(executable)},args:[${JSON.stringify(resolver)}],passEnv:[],timeoutMs:60000,jsonOnly:true}}}},
          manifestRegistry:{plugins:[]}
        });
        if(values.get('exec:credential_test:token')!=='synthetic-value')process.exit(2);
        process.stdout.write('admitted');
      } catch { process.stderr.write('native admission failed'); process.exitCode=1; }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', driver], {
      windowsHide: true, encoding: 'utf8', timeout: 75_000, maxBuffer: 8192,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('admitted');
  }, 90_000);
});

it('keeps the existing runtime on platforms that use the user-owned launcher', () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const source: CredentialNodeRuntimeSource = { executable: '/root-owned/node', sha256: 'a'.repeat(64) };
    expect(prepareCredentialNodeRuntime('/does-not-need-to-exist', source)).toBe(source.executable);
  } finally { Object.defineProperty(process, 'platform', descriptor); }
});
