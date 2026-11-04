import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  BUILTIN_SECRET_ID,
  BUILTIN_SECRET_SOURCE,
  MODEL_AUTH_SESSION_ENV,
  MODEL_AUTH_SESSION_PATTERN,
  MODEL_AUTH_TYPE_ENV,
} from '../../../../../plugins/extensions/runtime-services/contracts/model-auth';
import {
  BuiltinModelAuthDiagnosticEvent,
  BuiltinModelAuthDiagnosticReason,
  getBuiltinModelAuthErrorCode,
  writeBuiltinModelAuthDiagnostic,
} from '../../../providers/builtinModelAuthDiagnostics';
import {
  type BuiltinModelCredential,
  getActiveBuiltinModelCredentialSessionId,
} from '../../../providers/builtinModelCredential';
import {
  type CredentialNodeRuntimeSource,
  prepareCredentialNodeRuntime,
} from '../../runtime/launch/credentialNodeRuntime';
import { resolveBuiltinCredentialResolverTimeoutMs } from './credentialTimeouts';
import { restrictCredentialFile } from './providerSecretFile';

export { BUILTIN_SECRET_ID, BUILTIN_SECRET_SOURCE };
// Public wrapping material: protects against direct inspection, not reverse engineering.
const WRAPPING_CONTEXT = 'model-credential-snapshot/v1';
const CREDENTIAL_FILE_NAME = 'credentials.json';
const LEGACY_CREDENTIAL_FILE_NAME = 'credentials.bin';
const CREDENTIAL_FILE_LIMIT_BYTES = 65_536;
const wrappingKey = () => createHash('sha256').update(WRAPPING_CONTEXT).digest();

export function sealBuiltinCredential(value: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', wrappingKey(), nonce);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.from(`${JSON.stringify({
    version: 1, iv: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64'),
  }, null, 2)}\n`, 'utf8');
}

export function openBuiltinCredential(data: Buffer): string {
  if (data.length > CREDENTIAL_FILE_LIMIT_BYTES) throw new Error('Invalid builtin credential file.');
  const envelope = JSON.parse(data.toString('utf8'));
  const decode = (value: unknown, length?: number): Buffer => {
    if (typeof value !== 'string') throw new Error('Invalid builtin credential file.');
    const decoded = Buffer.from(value, 'base64');
    if (!decoded.length || decoded.toString('base64') !== value || (length !== undefined && decoded.length !== length)) {
      throw new Error('Invalid builtin credential file.');
    }
    return decoded;
  };
  if (!envelope || envelope.version !== 1) throw new Error('Invalid builtin credential file.');
  const cipher = createDecipheriv('aes-256-gcm', wrappingKey(), decode(envelope.iv, 12));
  cipher.setAuthTag(decode(envelope.tag, 16));
  return Buffer.concat([cipher.update(decode(envelope.data)), cipher.final()]).toString('utf8');
}

function readPrivateFile(file: string): Buffer {
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Invalid builtin credential file.');
  const descriptor = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > CREDENTIAL_FILE_LIMIT_BYTES) throw new Error('Invalid builtin credential file.');
    const data = Buffer.alloc(CREDENTIAL_FILE_LIMIT_BYTES + 1);
    let size = 0;
    while (size < data.length) {
      const count = fs.readSync(descriptor, data, size, data.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > CREDENTIAL_FILE_LIMIT_BYTES) throw new Error('Invalid builtin credential file.');
    return data.subarray(0, size);
  } finally { fs.closeSync(descriptor); }
}

// Standalone, dependency-free exec SecretRef provider. Output is consumed only by
// OpenClaw's bounded stdin/stdout protocol, never a log or an environment variable.
export const builtinCredentialResolverSource = (): string => `
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (Buffer.byteLength(input) > 8192) process.exit(1);
});
process.stdin.on('end', () => {
  try {
    const request = JSON.parse(input);
    if (request.protocolVersion !== 1 || request.provider !== ${JSON.stringify(BUILTIN_SECRET_SOURCE)} ||
        !Array.isArray(request.ids) || request.ids.length !== 1 ||
        request.ids[0] !== ${JSON.stringify(BUILTIN_SECRET_ID)}) throw new Error();
    const file = path.join(__dirname, ${JSON.stringify(CREDENTIAL_FILE_NAME)});
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error();
    const fd = fs.openSync(file, 'r');
    let data;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 65536) throw new Error();
      const buffer = Buffer.alloc(65537);
      let count = 0;
      while (count < buffer.length) {
        const size = fs.readSync(fd, buffer, count, buffer.length - count, null);
        if (!size) break;
        count += size;
      }
      if (count > 65536) throw new Error();
      data = buffer.subarray(0, count);
    } finally { fs.closeSync(fd); }
    const envelope = JSON.parse(data.toString('utf8'));
    const decode = (value, length) => {
      if (typeof value !== 'string') throw new Error();
      const decoded = Buffer.from(value, 'base64');
      if (!decoded.length || decoded.toString('base64') !== value || (length !== undefined && decoded.length !== length)) throw new Error();
      return decoded;
    };
    if (!envelope || envelope.version !== 1) throw new Error();
    const key = crypto.createHash('sha256').update(${JSON.stringify(WRAPPING_CONTEXT)}).digest();
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, decode(envelope.iv, 12));
    cipher.setAuthTag(decode(envelope.tag, 16));
    const value = Buffer.concat([cipher.update(decode(envelope.data)), cipher.final()]).toString('utf8');
    const credential = JSON.parse(value);
    const sessionId = process.env[${JSON.stringify(MODEL_AUTH_SESSION_ENV)}];
    const authType = process.env[${JSON.stringify(MODEL_AUTH_TYPE_ENV)}];
    if (!credential || typeof credential.accessToken !== 'string' || !credential.accessToken ||
        credential.accessToken.length > 8192 || /[\\s\\u0000-\\u001f\\u007f]/.test(credential.accessToken) ||
        typeof sessionId !== 'string' || !${MODEL_AUTH_SESSION_PATTERN}.test(sessionId) ||
        credential.authSessionId !== sessionId ||
        !['jwt', 'api-key'].includes(authType) || (credential.authType || 'jwt') !== authType ||
        typeof credential.userAccount !== 'string' ||
        !Number.isInteger(credential.expiresAt) || credential.expiresAt <= Date.now() / 1000 + 15 ||
        (credential.authType === 'api-key' ? credential.userAccount !== '' : !credential.userAccount)) throw new Error();
    const available = {
      [${JSON.stringify(BUILTIN_SECRET_ID)}]: credential.accessToken,
    };
    process.stdout.write(JSON.stringify({ protocolVersion: 1, values: Object.fromEntries(request.ids.map(id => [id, available[id]])) }));
  } catch {
    process.stderr.write('Builtin credential resolution failed.');
    process.exitCode = 1;
  }
});
`;

function publishPrivateFile(file: string, data: Buffer | string, executable = false, fileKind: 'snapshot' | 'resolver' | 'launcher' = 'snapshot'): void {
  try {
    try { if (readPrivateFile(file).equals(Buffer.from(data))) return; } catch { /* Publish a complete private replacement. */ }
    const temporary = `${file}.tmp-${randomUUID()}`;
    try {
      fs.writeFileSync(temporary, '', { flag: 'wx', mode: 0o600 });
      restrictCredentialFile(temporary);
      fs.writeFileSync(temporary, data);
      if (executable && process.platform !== 'win32') fs.chmodSync(temporary, 0o700);
      fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  } catch (error) {
    // Snapshot failures are reported by their publisher; launcher/resolver files have no outer publication catch.
    if (fileKind !== 'snapshot') writeBuiltinModelAuthDiagnostic('error', BuiltinModelAuthDiagnosticEvent.SnapshotPublicationFailed, {
      reason: BuiltinModelAuthDiagnosticReason.SnapshotWriteFailed, fileKind,
      errorCode: getBuiltinModelAuthErrorCode(error),
    });
    throw error;
  }
}

/** Publish a validated login snapshot without waiting for configuration application. */
export function publishBuiltinCredentialFile(
  stateDir: string,
  credential: BuiltinModelCredential,
  authSessionId: string,
): boolean {
  const startedAt = Date.now();
  try {
    if (credential.expiresAt <= Date.now() / 1000 + 15) throw new Error('Builtin credential is unavailable.');
    if (!MODEL_AUTH_SESSION_PATTERN.test(authSessionId)) throw new Error('Builtin credential session is unavailable.');
    const directory = path.join(stateDir, 'credentials');
    const file = path.join(directory, CREDENTIAL_FILE_NAME);
    const serialized = JSON.stringify({ ...credential, authSessionId });
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.existsSync(file)) {
      try {
        if (openBuiltinCredential(readPrivateFile(file)) === serialized) {
          return retireLegacyCredentialFile(stateDir);
        }
      } catch { /* Replace corrupted ciphertext. */ }
    }
    publishPrivateFile(file, sealBuiltinCredential(serialized));
    retireLegacyCredentialFile(stateDir);
    writeBuiltinModelAuthDiagnostic('info', BuiltinModelAuthDiagnosticEvent.SnapshotPublished, {
      changed: true, fileKind: 'snapshot', elapsedMs: Date.now() - startedAt,
      remainingSeconds: Math.floor(credential.expiresAt - Date.now() / 1000),
      authType: credential.authType ?? 'jwt',
    });
    return true;
  } catch (error) {
    writeBuiltinModelAuthDiagnostic('error', BuiltinModelAuthDiagnosticEvent.SnapshotPublicationFailed, {
      reason: credential.expiresAt <= Date.now() / 1000 + 15 || !MODEL_AUTH_SESSION_PATTERN.test(authSessionId)
        ? BuiltinModelAuthDiagnosticReason.SnapshotInvalid : BuiltinModelAuthDiagnosticReason.SnapshotWriteFailed,
      fileKind: 'snapshot', errorCode: getBuiltinModelAuthErrorCode(error), elapsedMs: Date.now() - startedAt,
    });
    throw error;
  }
}

function retireLegacyCredentialFile(stateDir: string): boolean {
  try { fs.unlinkSync(path.join(stateDir, 'credentials', LEGACY_CREDENTIAL_FILE_NAME)); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Keep only JWT SecretRefs in config; publish an opaque JSON snapshot first. */
export function syncBuiltinCredentialFile(
  config: Record<string, unknown>,
  stateDir: string,
  credential: BuiltinModelCredential | null,
  runtimeSource: CredentialNodeRuntimeSource,
  authSessionId = getActiveBuiltinModelCredentialSessionId(),
): { config: Record<string, unknown>; secretsChanged: boolean } {
  const next = structuredClone(config);
  let referenced = false;
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (record.source === 'exec' && record.provider === BUILTIN_SECRET_SOURCE &&
      record.id === BUILTIN_SECRET_ID) referenced = true;
    for (const child of Object.values(record)) visit(child);
  };
  visit(next);
  const directory = path.join(stateDir, 'credentials');
  const credentialFile = path.join(directory, CREDENTIAL_FILE_NAME);
  if (!referenced) {
    // Logout removes the snapshot so the old JWT cannot be resolved again.
    const existed = fs.existsSync(credentialFile) || fs.existsSync(path.join(directory, LEGACY_CREDENTIAL_FILE_NAME));
    revokeBuiltinCredentialFile(stateDir);
    const providers = (next.secrets as { providers?: Record<string, unknown> } | undefined)?.providers;
    if (providers) delete providers[BUILTIN_SECRET_SOURCE];
    return { config: next, secretsChanged: existed };
  }
  if (!credential || credential.expiresAt <= Date.now() / 1000 + 15) {
    writeBuiltinModelAuthDiagnostic('error', BuiltinModelAuthDiagnosticEvent.SnapshotPublicationFailed, {
      reason: BuiltinModelAuthDiagnosticReason.SnapshotInvalid, fileKind: 'snapshot',
      credentialPresent: credential !== null, snapshotState: credential ? 'expired' : 'missing',
    });
    throw new Error('Builtin credential is unavailable.');
  }
  if (!authSessionId || !MODEL_AUTH_SESSION_PATTERN.test(authSessionId)) {
    writeBuiltinModelAuthDiagnostic('error', BuiltinModelAuthDiagnosticEvent.SnapshotPublicationFailed, {
      reason: BuiltinModelAuthDiagnosticReason.SnapshotInvalid, fileKind: 'snapshot', snapshotState: 'invalid-session',
    });
    throw new Error('Builtin credential session is unavailable.');
  }
  let runtimePath = runtimeSource.executable;
  if (process.platform === 'win32') {
    try { runtimePath = prepareCredentialNodeRuntime(stateDir, runtimeSource); }
    catch (error) {
      writeBuiltinModelAuthDiagnostic('error', BuiltinModelAuthDiagnosticEvent.SnapshotPublicationFailed, {
        reason: BuiltinModelAuthDiagnosticReason.SnapshotWriteFailed, fileKind: 'launcher',
        errorCode: getBuiltinModelAuthErrorCode(error),
      });
      throw error;
    }
  }
  const secretsChanged = publishBuiltinCredentialFile(stateDir, credential, authSessionId);
  const resolver = path.join(directory, 'read-builtin.cjs');
  publishPrivateFile(resolver, builtinCredentialResolverSource(), false, 'resolver');
  let command = runtimePath;
  let args = [resolver];
  if (process.platform !== 'win32') {
    // Native exec validation requires a user-owned command. The app executable
    // can be root-owned on macOS/Linux; this private launcher preserves that check.
    command = path.join(directory, 'read-builtin');
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    publishPrivateFile(command, `#!/bin/sh\nexec ${quote(runtimePath)} ${quote(resolver)}\n`, true, 'launcher');
    args = [];
  }
  const secrets = next.secrets as Record<string, unknown> | undefined;
  next.secrets = {
    ...secrets,
    providers: {
      ...(secrets?.providers as Record<string, unknown> | undefined),
      [BUILTIN_SECRET_SOURCE]: {
        source: 'exec', command, args, env: {
          [MODEL_AUTH_SESSION_ENV]: authSessionId,
          [MODEL_AUTH_TYPE_ENV]: credential.authType ?? 'jwt',
          ...(process.platform === 'win32' ? {
            // Native config requires uppercase names; supply explicitly because
            // inherited environment snapshots may contain mixed-case SystemRoot.
            SYSTEMROOT: process.env.SystemRoot || 'C:\\Windows',
          } : {}),
        },
        passEnv: [],
        timeoutMs: resolveBuiltinCredentialResolverTimeoutMs(), maxOutputBytes: 65_536, jsonOnly: true,
      },
    },
  };
  return { config: next, secretsChanged };
}

/** Revoke captured exec providers before awaiting catalog/config cleanup. */
export function revokeBuiltinCredentialFile(stateDir: string): void {
  let firstError: unknown;
  let changed = false;
  for (const name of [CREDENTIAL_FILE_NAME, LEGACY_CREDENTIAL_FILE_NAME]) {
    try { fs.unlinkSync(path.join(stateDir, 'credentials', name)); changed = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      firstError ??= error;
      writeBuiltinModelAuthDiagnostic('error', BuiltinModelAuthDiagnosticEvent.SnapshotRevocationFailed, {
        reason: BuiltinModelAuthDiagnosticReason.SnapshotRevokeFailed, errorCode: getBuiltinModelAuthErrorCode(error),
      });
    }
  }
  if (changed) writeBuiltinModelAuthDiagnostic('info', BuiltinModelAuthDiagnosticEvent.SnapshotRevoked, { changed: true });
  if (firstError) throw firstError;
}
