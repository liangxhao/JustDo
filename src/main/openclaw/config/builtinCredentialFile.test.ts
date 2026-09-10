import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BUILTIN_CREDENTIAL_MARKER } from '../../cowork/builtinModelProviderConfig';
import {
  BUILTIN_SECRET_ID, BUILTIN_SECRET_SOURCE, openBuiltinCredential,
  sealBuiltinCredential, syncBuiltinCredentialFile,
} from './builtinCredentialFile';

const directories: string[] = [];
const directory = () => {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-credential 测试 '));
  directories.push(value);
  return value;
};
afterEach(() => {
  for (const item of directories.splice(0)) fs.rmSync(item, { recursive: true, force: true });
});
const source = () => ({
  models: { providers: { builtin_models: { apiKey: BUILTIN_CREDENTIAL_MARKER } } },
  memory: { search: { remote: { apiKey: BUILTIN_CREDENTIAL_MARKER } } },
});
const secret = 'synthetic-builtin-key';

describe('encrypted binary builtin credentials', () => {
  it('uses authenticated randomized ciphertext and rejects modification', () => {
    const first = sealBuiltinCredential(secret);
    expect(first.includes(Buffer.from(secret))).toBe(false);
    expect(first.equals(sealBuiltinCredential(secret))).toBe(false);
    expect(openBuiltinCredential(first)).toBe(secret);
    first[first.length - 1] ^= 1;
    expect(() => openBuiltinCredential(first)).toThrow();
  });

  it('keeps config as references and reloads only when the credential changes', () => {
    const state = directory();
    const first = syncBuiltinCredentialFile(source(), state, () => secret);
    const json = JSON.stringify(first.config);
    expect(json).not.toContain(secret);
    expect(json).not.toContain('ciphertext');
    expect(json).not.toContain(BUILTIN_CREDENTIAL_MARKER);
    expect(first.secretsChanged).toBe(true);
    const file = path.join(state, 'credentials', 'credentials.bin');
    const original = fs.readFileSync(file);
    expect(syncBuiltinCredentialFile(first.config, state, () => secret).secretsChanged).toBe(false);
    expect(fs.readFileSync(file)).toEqual(original);
    const rotated = syncBuiltinCredentialFile(first.config, state, () => `${secret}-rotated`);
    expect(rotated.secretsChanged).toBe(true);
    expect(rotated.config).toEqual(first.config);
    expect(openBuiltinCredential(fs.readFileSync(file))).toBe(`${secret}-rotated`);
  });

  it('resolves through stdin/stdout without a key in argv or environment, including Unicode paths', () => {
    const state = directory();
    const result = syncBuiltinCredentialFile(source(), state, () => secret);
    const provider = (result.config.secrets as { providers: Record<string, {
      command: string; args: string[]; env: Record<string, string>;
    }> }).providers[BUILTIN_SECRET_SOURCE];
    const run = (ids: string[]) => spawnSync(provider.command, provider.args, {
      env: provider.env,
      windowsHide: true, encoding: 'utf8', timeout: 5000,
      input: JSON.stringify({ protocolVersion: 1, provider: BUILTIN_SECRET_SOURCE, ids }),
    });
    const resolved = run([BUILTIN_SECRET_ID]);
    expect(resolved.status).toBe(0);
    expect(resolved.stderr).toBe('');
    expect(JSON.parse(resolved.stdout).values[BUILTIN_SECRET_ID]).toBe(secret);
    const denied = run(['other']);
    expect(denied.status).not.toBe(0);
    expect(denied.stdout).toBe('');
    expect(denied.stderr).not.toContain(secret);
  });

  it('revokes the binary on logout and does not load a credential for custom-only config', () => {
    const state = directory();
    syncBuiltinCredentialFile(source(), state, () => secret);
    const getter = vi.fn(() => secret);
    const loggedOut = syncBuiltinCredentialFile({}, state, getter);
    expect(loggedOut.secretsChanged).toBe(true);
    expect(getter).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(state, 'credentials', 'credentials.bin'))).toBe(false);
  });
});
