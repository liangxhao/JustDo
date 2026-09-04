import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

const require = createRequire(import.meta.url);
const { patchHttpMitmProxy } = require('../scripts/patch-http-mitm-proxy.cjs') as {
  patchHttpMitmProxy: (packageRoot?: string) => void;
};

const temporaryDirectories: string[] = [];

const createPackageFixture = (): string => {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-http-mitm-proxy-'));
  temporaryDirectories.push(packageRoot);
  fs.mkdirSync(path.join(packageRoot, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(packageRoot, 'dist', 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ name: 'http-mitm-proxy', version: '1.1.0' }),
  );

  const certificateAuthoritySource = [
    'class CA {',
    '  generateCA() {',
    '    const cert = pki.createCertificate();',
    '    cert.publicKey = keys.publicKey;',
    '    cert.serialNumber = self.randomSerialNumber();',
    '    cert.validity.notBefore = new Date();',
    '    cert.setSubject(CAattrs);',
    '    cert.setIssuer(CAattrs);',
    '  }',
    '}',
    '',
  ].join('\n');
  const proxySource = [
    'getHttpsServer(hostname, (err, port) => {',
    '  delete self.sslSemaphores[wildcardHost];',
    '});',
    '',
  ].join('\n');
  for (const relativePath of ['lib/ca.ts', 'dist/lib/ca.js']) {
    fs.writeFileSync(path.join(packageRoot, relativePath), certificateAuthoritySource);
  }
  for (const relativePath of ['lib/proxy.ts', 'dist/lib/proxy.js']) {
    fs.writeFileSync(path.join(packageRoot, relativePath), proxySource);
  }
  return packageRoot;
};

const readPatchedFiles = (packageRoot: string): Record<string, string> =>
  Object.fromEntries(
    ['lib/ca.ts', 'dist/lib/ca.js', 'lib/proxy.ts', 'dist/lib/proxy.js'].map(relativePath => [
      relativePath,
      fs.readFileSync(path.join(packageRoot, relativePath), 'utf8'),
    ]),
  );

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('patches pristine http-mitm-proxy sources', () => {
  const packageRoot = createPackageFixture();

  patchHttpMitmProxy(packageRoot);

  const files = readPatchedFiles(packageRoot);
  for (const relativePath of ['lib/ca.ts', 'dist/lib/ca.js']) {
    expect(files[relativePath]).toContain('// justdo-installation-unique-ca-subject');
    expect(files[relativePath]).toContain('cert.setSubject(caAttrs);');
    expect(files[relativePath]).toContain('cert.setIssuer(caAttrs);');
  }
  for (const relativePath of ['lib/proxy.ts', 'dist/lib/proxy.js']) {
    expect(files[relativePath]).not.toContain('delete self.sslSemaphores[wildcardHost];');
  }
});

test('is idempotent after the complete patch has been applied', () => {
  const packageRoot = createPackageFixture();
  patchHttpMitmProxy(packageRoot);
  const firstPatch = readPatchedFiles(packageRoot);

  patchHttpMitmProxy(packageRoot);

  expect(readPatchedFiles(packageRoot)).toEqual(firstPatch);
});

test('rejects a partially applied CA identity patch', () => {
  const packageRoot = createPackageFixture();
  patchHttpMitmProxy(packageRoot);
  const target = path.join(packageRoot, 'lib', 'ca.ts');
  const source = fs
    .readFileSync(target, 'utf8')
    .replace('    const commonName = caAttrs.find', '    const removedCommonName = caAttrs.find');
  fs.writeFileSync(target, source);

  expect(() => patchHttpMitmProxy(packageRoot)).toThrow(
    `Partially applied JustDo CA identity patch: ${target}`,
  );
});
