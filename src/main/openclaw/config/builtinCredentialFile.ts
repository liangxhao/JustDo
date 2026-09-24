import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { type BuiltinModelCredential } from '../../providers/builtinModelCredential';
import { restrictCredentialFile } from './providerSecretFile';

export const BUILTIN_SECRET_SOURCE = 'justdo_login';
export const BUILTIN_SECRET_ID = 'X-ACCESS-JWT';
export const BUILTIN_ACCOUNT_SECRET_ID = 'X-User-Account';
// Public wrapping material: protects against direct inspection, not reverse engineering.
const WRAPPING_CONTEXT = 'justdo/builtin-credential-file/v1';
const MAGIC = Buffer.from('JDCR1');
const wrappingKey = () => createHash('sha256').update(WRAPPING_CONTEXT).digest();

export function sealBuiltinCredential(value: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', wrappingKey(), nonce);
  cipher.setAAD(MAGIC);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), encrypted]);
}

export function openBuiltinCredential(data: Buffer): string {
  if (data.length < 34 || data.length > 65_536 || !data.subarray(0, 5).equals(MAGIC)) {
    throw new Error('Invalid builtin credential file.');
  }
  const cipher = createDecipheriv('aes-256-gcm', wrappingKey(), data.subarray(5, 17));
  cipher.setAAD(MAGIC);
  cipher.setAuthTag(data.subarray(17, 33));
  return Buffer.concat([cipher.update(data.subarray(33)), cipher.final()]).toString('utf8');
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
        !Array.isArray(request.ids) || request.ids.length < 1 || request.ids.length > 2 ||
        request.ids.some(id => ![${JSON.stringify(BUILTIN_SECRET_ID)}, ${JSON.stringify(BUILTIN_ACCOUNT_SECRET_ID)}].includes(id))) throw new Error();
    const file = path.join(__dirname, 'credentials.bin');
    if (fs.statSync(file).size > 65536) throw new Error();
    const data = fs.readFileSync(file);
    const magic = Buffer.from('JDCR1');
    if (data.length < 34 || !data.subarray(0, 5).equals(magic)) throw new Error();
    const key = crypto.createHash('sha256').update(${JSON.stringify(WRAPPING_CONTEXT)}).digest();
    const cipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(5, 17));
    cipher.setAAD(magic);
    cipher.setAuthTag(data.subarray(17, 33));
    const value = Buffer.concat([cipher.update(data.subarray(33)), cipher.final()]).toString('utf8');
    const credential = JSON.parse(value);
    if (!credential || typeof credential.accessToken !== 'string' || !credential.accessToken ||
        typeof credential.userAccount !== 'string' ||
        !Number.isInteger(credential.expiresAt) || credential.expiresAt <= Date.now() / 1000 + 15 ||
        (credential.authType === 'api-key' ? credential.userAccount !== '' : !credential.userAccount)) throw new Error();
    const available = {
      [${JSON.stringify(BUILTIN_SECRET_ID)}]: credential.accessToken,
      [${JSON.stringify(BUILTIN_ACCOUNT_SECRET_ID)}]: credential.userAccount,
    };
    process.stdout.write(JSON.stringify({ protocolVersion: 1, values: Object.fromEntries(request.ids.map(id => [id, available[id]])) }));
  } catch {
    process.stderr.write('Builtin credential resolution failed.');
    process.exitCode = 1;
  }
});
`;

function publishPrivateFile(file: string, data: Buffer | string, executable = false): void {
  if (fs.existsSync(file) && fs.readFileSync(file).equals(Buffer.from(data))) return;
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
}

/** Keep only SecretRefs in JSON; publish an encrypted binary before its reference. */
export function syncBuiltinCredentialFile(
  config: Record<string, unknown>,
  stateDir: string,
  credential: BuiltinModelCredential | null,
  runtimePath = process.execPath,
): { config: Record<string, unknown>; secretsChanged: boolean } {
  const next = structuredClone(config);
  let referenced = false;
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (record.source === 'exec' && record.provider === BUILTIN_SECRET_SOURCE &&
      [BUILTIN_SECRET_ID, BUILTIN_ACCOUNT_SECRET_ID].includes(String(record.id))) referenced = true;
    for (const child of Object.values(record)) visit(child);
  };
  visit(next);
  const directory = path.join(stateDir, 'credentials');
  const credentialFile = path.join(directory, 'credentials.bin');
  if (!referenced) {
    // Logout removes the snapshot so the old JWT cannot be resolved again.
    const existed = fs.existsSync(credentialFile);
    if (existed) fs.unlinkSync(credentialFile);
    const providers = (next.secrets as { providers?: Record<string, unknown> } | undefined)?.providers;
    if (providers) delete providers[BUILTIN_SECRET_SOURCE];
    return { config: next, secretsChanged: existed };
  }
  if (!credential || credential.expiresAt <= Date.now() / 1000 + 15) throw new Error('Builtin credential is unavailable.');
  const serializedCredential = JSON.stringify(credential);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let secretsChanged = true;
  if (fs.existsSync(credentialFile)) {
    try { secretsChanged = openBuiltinCredential(fs.readFileSync(credentialFile)) !== serializedCredential; } catch { /* Replace corrupted ciphertext. */ }
  }
  if (secretsChanged) publishPrivateFile(credentialFile, sealBuiltinCredential(serializedCredential));
  const resolver = path.join(directory, 'read-builtin.cjs');
  publishPrivateFile(resolver, builtinCredentialResolverSource());
  let command = runtimePath;
  let args = [resolver];
  if (process.platform === 'win32') {
    // Use the OS-owned executable: native ACL inspection of localized paths can
    // be unavailable, and development Electron installations may be writable.
    // Encoded static code and separate path variables avoid shell interpolation.
    command = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from('$ProgressPreference = "SilentlyContinue"; $ErrorActionPreference = "Stop"; $OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::In.ReadToEnd() | & $env:JUSTDO_CREDENTIAL_RUNTIME $env:JUSTDO_CREDENTIAL_RESOLVER | ForEach-Object { [Console]::Out.WriteLine($_) }; exit $LASTEXITCODE', 'utf16le').toString('base64')];
  } else {
    // Native exec validation requires a user-owned command. The app executable
    // can be root-owned on macOS/Linux; this private launcher preserves that check.
    command = path.join(directory, 'read-builtin');
    const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    publishPrivateFile(command, `#!/bin/sh\nexec ${quote(runtimePath)} ${quote(resolver)}\n`, true);
    args = [];
  }
  const secrets = next.secrets as Record<string, unknown> | undefined;
  next.secrets = {
    ...secrets,
    providers: {
      ...(secrets?.providers as Record<string, unknown> | undefined),
      [BUILTIN_SECRET_SOURCE]: {
        source: 'exec', command, args, env: {
          ELECTRON_RUN_AS_NODE: '1',
          ...(process.platform === 'win32' ? {
            JUSTDO_CREDENTIAL_RUNTIME: runtimePath, JUSTDO_CREDENTIAL_RESOLVER: resolver,
            PATHEXT: '.EXE;.COM',
            // Native config requires uppercase names; supply explicitly because
            // inherited environment snapshots may contain mixed-case SystemRoot.
            SYSTEMROOT: process.env.SystemRoot || 'C:\\Windows',
          } : {}),
        },
        passEnv: [],
        timeoutMs: 5000, maxOutputBytes: 65_536, jsonOnly: true,
      },
    },
  };
  return { config: next, secretsChanged };
}
