import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { BUILTIN_MODEL_USER_ACCOUNT_FIELD } from '../../../providers/builtinModelCredential';
import {
  BUILTIN_SECRET_ID, BUILTIN_SECRET_SOURCE, openBuiltinCredential,
  sealBuiltinCredential, syncBuiltinCredentialFile as syncCredentialFile,
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
  models: { providers: { builtin_models: { apiKey: { source: 'exec', provider: BUILTIN_SECRET_SOURCE, id: BUILTIN_SECRET_ID } } } },
  memory: { search: { remote: { apiKey: { source: 'exec', provider: BUILTIN_SECRET_SOURCE, id: BUILTIN_SECRET_ID } } } },
});
const secret = 'synthetic-short-lived-jwt';
const credential = { accessToken: secret, userAccount: 'test-user', expiresAt: Math.floor(Date.now() / 1000) + 300 };
const sessionId = 'a'.repeat(32);
const syncBuiltinCredentialFile = (config: Record<string, unknown>, state: string, value: typeof credential | null, session = sessionId) =>
  syncCredentialFile(config, state, value, process.execPath, session);

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
    const first = syncBuiltinCredentialFile(source(), state, credential);
    const json = JSON.stringify(first.config);
    expect(json).not.toContain(secret);
    expect(json).not.toContain('ciphertext');
    expect(json).not.toContain(credential.userAccount);
    expect(first.config.models).toMatchObject({
      providers: {
        builtin_models: {
          apiKey: { source: 'exec', provider: BUILTIN_SECRET_SOURCE, id: BUILTIN_SECRET_ID },
        },
      },
    });
    expect(first.secretsChanged).toBe(true);
    const file = path.join(state, 'credentials', 'credentials.bin');
    const original = fs.readFileSync(file);
    expect(syncBuiltinCredentialFile(first.config, state, credential).secretsChanged).toBe(false);
    expect(fs.readFileSync(file)).toEqual(original);
    const rotated = syncBuiltinCredentialFile(first.config, state, { ...credential, accessToken: `${secret}-rotated` });
    expect(rotated.secretsChanged).toBe(true);
    expect(rotated.config).toEqual(first.config);
    expect(JSON.parse(openBuiltinCredential(fs.readFileSync(file))).accessToken).toBe(`${secret}-rotated`);
  });

  it('rotates account snapshots without publishing the account through native secret configuration', () => {
    const state = directory();
    const input = source();
    const first = syncBuiltinCredentialFile(input, state, credential);
    const switched = syncBuiltinCredentialFile(first.config, state, {
      ...credential, userAccount: 'next-user', accessToken: 'next-user-jwt',
    }, 'b'.repeat(32));
    expect(switched.config).not.toEqual(first.config);
    expect(JSON.stringify(switched.config)).not.toContain('next-user');
    expect(JSON.parse(openBuiltinCredential(fs.readFileSync(path.join(state, 'credentials', 'credentials.bin')))))
      .toMatchObject({ userAccount: 'next-user', accessToken: 'next-user-jwt' });
    expect(input.models.providers.builtin_models).not.toHaveProperty('headers');
    expect(switched.secretsChanged).toBe(true);
  });

  it('resolves through stdin/stdout without a key in argv or environment, including Unicode paths', () => {
    const state = directory();
    const result = syncBuiltinCredentialFile(source(), state, credential);
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
    expect(JSON.parse(resolved.stdout).values).toEqual({ [BUILTIN_SECRET_ID]: secret });
    const accountDenied = run([BUILTIN_MODEL_USER_ACCOUNT_FIELD]);
    expect(accountDenied.status).not.toBe(0);
    expect(accountDenied.stdout).toBe('');
    const denied = run(['other']);
    expect(denied.status).not.toBe(0);
    expect(denied.stdout).toBe('');
    expect(denied.stderr).not.toContain(secret);
    fs.writeFileSync(path.join(state, 'credentials', 'credentials.bin'), sealBuiltinCredential(JSON.stringify({ ...credential, authSessionId: sessionId, expiresAt: 1 })));
    const expired = run([BUILTIN_SECRET_ID]);
    expect(expired.status).not.toBe(0);
    expect(expired.stdout).toBe('');
    expect(expired.stderr).not.toContain(secret);
  });

  it('resolves a static development API key without requiring an account', () => {
    const state = directory();
    const developmentCredential = {
      accessToken: 'sk-development',
      userAccount: '',
      expiresAt: Number.MAX_SAFE_INTEGER,
      authType: 'api-key' as const,
    };
    const result = syncBuiltinCredentialFile(source(), state, developmentCredential);
    expect((result.config.models as { providers: Record<string, unknown> }).providers.builtin_models)
      .not.toHaveProperty('headers');
    const provider = (result.config.secrets as { providers: Record<string, {
      command: string; args: string[]; env: Record<string, string>;
    }> }).providers[BUILTIN_SECRET_SOURCE];
    const resolved = spawnSync(provider.command, provider.args, {
      env: provider.env,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 5000,
      input: JSON.stringify({
        protocolVersion: 1,
        provider: BUILTIN_SECRET_SOURCE,
        ids: [BUILTIN_SECRET_ID],
      }),
    });
    expect(resolved.status).toBe(0);
    expect(JSON.parse(resolved.stdout).values[BUILTIN_SECRET_ID]).toBe('sk-development');
  });

  it('revokes the binary on logout and does not load a credential for custom-only config', () => {
    const state = directory();
    syncBuiltinCredentialFile(source(), state, credential);
    const loggedOut = syncBuiltinCredentialFile({}, state, null);
    expect(loggedOut.secretsChanged).toBe(true);
    expect(fs.existsSync(path.join(state, 'credentials', 'credentials.bin'))).toBe(false);
  });

  it('rejects the old resolver after relogin even for the same account', () => {
    const state = directory();
    const first = syncBuiltinCredentialFile(source(), state, credential);
    const provider = (first.config.secrets as { providers: Record<string, {
      command: string; args: string[]; env: Record<string, string>;
    }> }).providers[BUILTIN_SECRET_SOURCE];
    const run = () => spawnSync(provider.command, provider.args, {
      env: provider.env, windowsHide: true, encoding: 'utf8', timeout: 5000,
      input: JSON.stringify({ protocolVersion: 1, provider: BUILTIN_SECRET_SOURCE, ids: [BUILTIN_SECRET_ID] }),
    });
    syncBuiltinCredentialFile(first.config, state, { ...credential, accessToken: 'rotated' });
    expect(JSON.parse(run().stdout).values[BUILTIN_SECRET_ID]).toBe('rotated');
    syncBuiltinCredentialFile({}, state, null);
    expect(run().status).not.toBe(0);
    syncBuiltinCredentialFile(source(), state, { ...credential, accessToken: 'next-login' }, 'b'.repeat(32));
    const denied = run();
    expect(denied.status).not.toBe(0);
    expect(denied.stdout).toBe('');
    expect(denied.stderr).toBe('Builtin credential resolution failed.');
  });
});
