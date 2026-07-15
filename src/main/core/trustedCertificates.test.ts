import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test } from 'vitest';

import { buildTrustedCaBundle } from './trustedCertificates';

const tempDirs: string[] = [];

const createTempDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-trust-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writes the trusted CA bundle next to outbound header proxy certificates', () => {
  const userDataPath = createTempDir();

  const bundlePath = buildTrustedCaBundle(userDataPath);

  expect(bundlePath).toBe(
    path.join(userDataPath, 'outbound-header-proxy', 'certs', 'trusted-ca-bundle.pem'),
  );
  expect(fs.existsSync(bundlePath as string)).toBe(true);
  expect(fs.existsSync(path.join(userDataPath, 'network-trust'))).toBe(false);
});

test('removes the legacy generated trust bundle after writing the new bundle', () => {
  const userDataPath = createTempDir();
  const legacyDir = path.join(userDataPath, 'network-trust');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'trusted-ca-bundle.pem'), 'old bundle\n', 'utf8');
  fs.writeFileSync(path.join(legacyDir, 'keep.pem'), 'user file\n', 'utf8');

  const bundlePath = buildTrustedCaBundle(userDataPath);

  expect(bundlePath).toBe(
    path.join(userDataPath, 'outbound-header-proxy', 'certs', 'trusted-ca-bundle.pem'),
  );
  expect(fs.existsSync(path.join(legacyDir, 'trusted-ca-bundle.pem'))).toBe(false);
  expect(fs.existsSync(path.join(legacyDir, 'keep.pem'))).toBe(true);
});
