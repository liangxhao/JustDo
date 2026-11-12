import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { CredentialReaderExitCode } from '../../../../../plugins/extensions/runtime-services/contracts/model-auth';
import { BUILTIN_MODEL_USER_ACCOUNT_FIELD } from '../../../providers/builtinModelCredential';
import {
  BUILTIN_SECRET_ID, BUILTIN_SECRET_SOURCE, openBuiltinCredential, publishBuiltinCredentialFile,
  revokeBuiltinCredentialFile, sealBuiltinCredential, syncBuiltinCredentialFile as syncCredentialFile,
} from './builtinCredentialFile';
import {
  resolveBuiltinCredentialResolverTimeoutMs,
  resolveManagedCredentialReloadTimeoutMs,
} from './credentialTimeouts';

const directories: string[] = [];
const directory = () => {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-credential 测试 '));
  directories.push(value);
  return value;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const item of directories.splice(0)) fs.rmSync(item, { recursive: true, force: true });
});
const source = () => ({
  models: { providers: { builtin_models: {
    apiKey: { source: 'exec', provider: BUILTIN_SECRET_SOURCE, id: BUILTIN_SECRET_ID },
    request: { allowPrivateNetwork: true },
  } } },
  memory: { search: { remote: { apiKey: { source: 'exec', provider: BUILTIN_SECRET_SOURCE, id: BUILTIN_SECRET_ID } } } },
});
const secret = 'synthetic-short-lived-jwt';
const credential = { accessToken: secret, userAccount: 'test-user', expiresAt: Math.floor(Date.now() / 1000) + 300 };
const sessionId = 'a'.repeat(32);
const runtimeSource = { executable: process.execPath, sha256: createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex') };
const syncBuiltinCredentialFile = (config: Record<string, unknown>, state: string, value: typeof credential | null, session = sessionId) =>
  syncCredentialFile(config, state, value, runtimeSource, session);

describe('opaque JSON builtin credentials', () => {
  it('preserves publication failure while recording only a single-line filesystem code', () => {
    const state = directory();
    const failure = Object.assign(new Error(`${secret}\nprivate-account private-path`), { code: 'EACCES' });
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw failure; });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => publishBuiltinCredentialFile(state, credential, sessionId)).toThrow(failure);
    expect(errorLog).toHaveBeenCalledOnce();
    expect(errorLog.mock.calls[0]).toHaveLength(1);
    const line = String(errorLog.mock.calls[0][0]);
    expect(line).toContain('"errorCode":"EACCES"');
    expect(line).toContain('"fileKind":"snapshot"');
    expect(line).not.toMatch(/[\r\n]|synthetic-short-lived|private-account|private-path/);
  });
  it.each(['win32', 'darwin', 'linux'] as const)('allows resolver completion before the reload RPC deadline on %s', platform => {
    const resolverTimeoutMs = resolveBuiltinCredentialResolverTimeoutMs(platform);
    expect(resolverTimeoutMs).toBe(platform === 'win32' ? 60_000 : 5_000);
    expect(resolveManagedCredentialReloadTimeoutMs(platform) - resolverTimeoutMs).toBe(30_000);
  });

  it('uses authenticated randomized ciphertext and rejects modification', () => {
    const first = sealBuiltinCredential(secret);
    expect(first.includes(Buffer.from(secret))).toBe(false);
    expect(first.equals(sealBuiltinCredential(secret))).toBe(false);
    expect(openBuiltinCredential(first)).toBe(secret);
    const envelope = JSON.parse(first.toString('utf8'));
    expect(envelope).toMatchObject({ version: 1, iv: expect.any(String), tag: expect.any(String), data: expect.any(String) });
    envelope.tag = (envelope.tag[0] === 'A' ? 'B' : 'A') + envelope.tag.slice(1);
    expect(() => openBuiltinCredential(Buffer.from(JSON.stringify(envelope)))).toThrow();
  });

  it.each([{ version: 2 }, { iv: 'AA==' }, { tag: 'invalid-base64!' }, { data: '' }])('rejects an invalid JSON envelope %j', fields => {
    const envelope = { ...JSON.parse(sealBuiltinCredential(secret).toString('utf8')), ...fields };
    expect(() => openBuiltinCredential(Buffer.from(JSON.stringify(envelope)))).toThrow();
  });

  it('keeps config as references and reloads only when the credential changes', () => {
    const state = directory();
    const first = syncBuiltinCredentialFile(source(), state, credential);
    expect(first.config.secrets).toMatchObject({
      providers: { [BUILTIN_SECRET_SOURCE]: { timeoutMs: resolveBuiltinCredentialResolverTimeoutMs() } },
    });
    const json = JSON.stringify(first.config);
    expect(json).not.toContain(secret);
    expect(json).not.toContain('ciphertext');
    expect(json).not.toContain(credential.userAccount);
    expect(first.config.models).toMatchObject({
      providers: {
        builtin_models: {
          apiKey: { source: 'exec', provider: BUILTIN_SECRET_SOURCE, id: BUILTIN_SECRET_ID },
          request: { allowPrivateNetwork: true },
        },
      },
    });
    expect(first.secretsChanged).toBe(true);
    const file = path.join(state, 'credentials', 'credentials.json');
    const original = fs.readFileSync(file);
    expect(syncBuiltinCredentialFile(first.config, state, credential).secretsChanged).toBe(false);
    expect(fs.readFileSync(file)).toEqual(original);
    const rotated = syncBuiltinCredentialFile(first.config, state, { ...credential, accessToken: `${secret}-rotated` });
    expect(rotated.secretsChanged).toBe(true);
    expect(rotated.config).toEqual(first.config);
    expect(JSON.parse(openBuiltinCredential(fs.readFileSync(file))).accessToken).toBe(`${secret}-rotated`);
  });

  it('publishes renewal before config sync without rewriting unchanged credentials', () => {
    const state = directory();
    const first = syncBuiltinCredentialFile(source(), state, credential);
    const renewed = { ...credential, accessToken: `${secret}-renewed` };
    expect(publishBuiltinCredentialFile(state, renewed, sessionId)).toBe(true);
    const file = path.join(state, 'credentials', 'credentials.json');
    const published = fs.readFileSync(file);
    expect(JSON.parse(openBuiltinCredential(published)))
      .toMatchObject({ ...renewed, authSessionId: sessionId });
    expect(publishBuiltinCredentialFile(state, renewed, sessionId)).toBe(false);
    expect(syncBuiltinCredentialFile(first.config, state, renewed).secretsChanged).toBe(false);
    expect(fs.readFileSync(file)).toEqual(published);
    expect(() => publishBuiltinCredentialFile(state, { ...renewed, expiresAt: 0 }, sessionId)).toThrow();
    expect(() => publishBuiltinCredentialFile(state, renewed, 'invalid')).toThrow();
    expect(fs.readFileSync(file)).toEqual(published);
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
    expect(JSON.parse(openBuiltinCredential(fs.readFileSync(path.join(state, 'credentials', 'credentials.json')))))
      .toMatchObject({ userAccount: 'next-user', accessToken: 'next-user-jwt' });
    expect(input.models.providers.builtin_models).not.toHaveProperty('headers');
    expect(switched.secretsChanged).toBe(true);
  });

  it('resolves through stdin/stdout without a key in argv or environment, including Unicode paths', () => {
    const state = directory();
    const result = syncBuiltinCredentialFile(source(), state, credential);
    const provider = (result.config.secrets as { providers: Record<string, {
      command: string; args: string[]; env: Record<string, string>; timeoutMs: number;
    }> }).providers[BUILTIN_SECRET_SOURCE];
    const run = (ids: string[]) => spawnSync(provider.command, provider.args, {
      env: provider.env,
      windowsHide: true, encoding: 'utf8', timeout: provider.timeoutMs,
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
    expect(denied.status).toBe(CredentialReaderExitCode.invalid_request);
    expect(denied.stdout).toBe('');
    expect(denied.stderr).not.toContain(secret);
    fs.writeFileSync(path.join(state, 'credentials', 'credentials.json'), sealBuiltinCredential(JSON.stringify({ ...credential, authSessionId: sessionId, expiresAt: 1 })));
    const expired = run([BUILTIN_SECRET_ID]);
    expect(expired.status).toBe(CredentialReaderExitCode.credential_expired);
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
      command: string; args: string[]; env: Record<string, string>; timeoutMs: number;
    }> }).providers[BUILTIN_SECRET_SOURCE];
    const resolved = spawnSync(provider.command, provider.args, {
      env: provider.env,
      windowsHide: true,
      encoding: 'utf8',
      timeout: provider.timeoutMs,
      input: JSON.stringify({
        protocolVersion: 1,
        provider: BUILTIN_SECRET_SOURCE,
        ids: [BUILTIN_SECRET_ID],
      }),
    });
    expect(resolved.status).toBe(0);
    expect(JSON.parse(resolved.stdout).values[BUILTIN_SECRET_ID]).toBe('sk-development');
  });

  it.skipIf(process.platform !== 'win32')('projects a direct private Node command with only the resolver argument', () => {
    const state = directory();
    const result = syncBuiltinCredentialFile(source(), state, credential);
    const provider = (result.config.secrets as { providers: Record<string, {
      command: string; args: string[]; env: Record<string, string>; timeoutMs: number;
    }> }).providers[BUILTIN_SECRET_SOURCE];
    expect(provider.command).toBe(path.join(state, 'credentials', 'runtime', runtimeSource.sha256, 'node.exe'));
    expect(provider.args).toEqual([path.join(state, 'credentials', 'read-builtin.cjs')]);
    expect(provider.env).toEqual({ MODEL_AUTH_SESSION_ID: sessionId, MODEL_AUTH_TYPE: 'jwt', SYSTEMROOT: process.env.SystemRoot || 'C:\\Windows' });
    expect(JSON.stringify({ args: provider.args, env: provider.env })).not.toContain(secret);
  });

  it('replaces the derived binary snapshot and revokes both known snapshot names', () => {
    const state = directory();
    fs.mkdirSync(path.join(state, 'credentials'));
    const legacy = path.join(state, 'credentials', 'credentials.bin');
    fs.writeFileSync(legacy, 'obsolete encrypted snapshot');
    syncBuiltinCredentialFile(source(), state, credential);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(state, 'credentials', 'credentials.json'), 'utf8')).version).toBe(1);
    fs.writeFileSync(legacy, 'obsolete encrypted snapshot');
    const unlink = fs.unlinkSync.bind(fs);
    vi.spyOn(fs, 'unlinkSync').mockImplementation(file => {
      if (String(file).endsWith('credentials.json')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      unlink(file);
    });
    expect(() => revokeBuiltinCredentialFile(state)).toThrow('denied');
    expect(fs.existsSync(legacy)).toBe(false);
    vi.restoreAllMocks();
    revokeBuiltinCredentialFile(state);
    expect(fs.existsSync(path.join(state, 'credentials', 'credentials.json'))).toBe(false);
  });

  it('revokes the binary on logout and does not load a credential for custom-only config', () => {
    const state = directory();
    syncBuiltinCredentialFile(source(), state, credential);
    const loggedOut = syncBuiltinCredentialFile({}, state, null);
    expect(loggedOut.secretsChanged).toBe(true);
    expect(fs.existsSync(path.join(state, 'credentials', 'credentials.json'))).toBe(false);
  });

  it('rejects the old resolver after relogin even for the same account', () => {
    const state = directory();
    const first = syncBuiltinCredentialFile(source(), state, credential);
    const provider = (first.config.secrets as { providers: Record<string, {
      command: string; args: string[]; env: Record<string, string>; timeoutMs: number;
    }> }).providers[BUILTIN_SECRET_SOURCE];
    const run = () => spawnSync(provider.command, provider.args, {
      env: provider.env, windowsHide: true, encoding: 'utf8', timeout: provider.timeoutMs,
      input: JSON.stringify({ protocolVersion: 1, provider: BUILTIN_SECRET_SOURCE, ids: [BUILTIN_SECRET_ID] }),
    });
    syncBuiltinCredentialFile(first.config, state, { ...credential, accessToken: 'rotated' });
    expect(JSON.parse(run().stdout).values[BUILTIN_SECRET_ID]).toBe('rotated');
    syncBuiltinCredentialFile({}, state, null);
    expect(run().status).toBe(CredentialReaderExitCode.snapshot_missing);
    syncBuiltinCredentialFile(source(), state, { ...credential, accessToken: 'next-login' }, 'b'.repeat(32));
    const denied = run();
    expect(denied.status).toBe(CredentialReaderExitCode.session_mismatch);
    expect(denied.stdout).toBe('');
    expect(denied.stderr).toBe('Builtin credential resolution failed.');
  });
});
