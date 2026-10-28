import vm from 'node:vm';

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test, vi } from 'vitest';

import {
  buildOutboundHeaderTrustedCaBundle,
  buildTrustedCaBundle,
  buildTrustedCertificatePreload,
} from './trustedCertificates';

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

test('keeps the outbound header CA bundle isolated from baseline trust refreshes', () => {
  const userDataPath = createTempDir();
  const caCertificatePath = path.join(userDataPath, 'proxy-ca.pem');
  const proxyCa = [
    '-----BEGIN CERTIFICATE-----',
    'outbound-header-proxy-ca',
    '-----END CERTIFICATE-----',
  ].join('\n');
  fs.writeFileSync(caCertificatePath, proxyCa, 'utf8');

  const outboundBundlePath = buildOutboundHeaderTrustedCaBundle(userDataPath, caCertificatePath);
  const outboundBundleBeforeRefresh = fs.readFileSync(outboundBundlePath as string, 'utf8');
  const baselineBundlePath = buildTrustedCaBundle(userDataPath);

  expect(outboundBundlePath).toBe(
    path.join(userDataPath, 'outbound-header-proxy', 'certs', 'gateway-trusted-ca-bundle.pem'),
  );
  expect(baselineBundlePath).not.toBe(outboundBundlePath);
  expect(outboundBundleBeforeRefresh).toContain(proxyCa);
  expect(fs.readFileSync(outboundBundlePath as string, 'utf8')).toBe(outboundBundleBeforeRefresh);
  expect(fs.readFileSync(baselineBundlePath as string, 'utf8')).not.toContain(proxyCa);
});

test('preload reads UTF-8 PEM and preserves current and system roots without disabling verification', () => {
  const filename = 'C:\\Users\\中文 空格\\trusted.pem';
  const extra = '-----BEGIN CERTIFICATE-----\nextra\n-----END CERTIFICATE-----';
  const readFileSync = vi.fn(() => extra);
  const setDefaultCACertificates = vi.fn();
  const env = { NODE_EXTRA_CA_CERTS: filename };
  vm.runInNewContext(buildTrustedCertificatePreload(), {
    process: { env },
    require: (name: string) =>
      name === 'node:fs'
        ? { readFileSync }
        : {
            getCACertificates: (type: string) =>
              type === 'default' ? ['current', 'shared\n'] : ['system', 'shared'],
            setDefaultCACertificates,
          },
  });
  expect(readFileSync).toHaveBeenCalledWith(filename, 'utf8');
  expect(setDefaultCACertificates).toHaveBeenCalledWith(['current', 'shared', 'system', extra]);
  expect(env).toEqual({ NODE_EXTRA_CA_CERTS: filename });
});

test('preload without explicit extra CA retains default and system roots without reading private files', () => {
  const readFileSync = vi.fn();
  const setDefaultCACertificates = vi.fn();
  const env = {};
  vm.runInNewContext(buildTrustedCertificatePreload(), {
    process: { env },
    require: (name: string) =>
      name === 'node:fs'
        ? { readFileSync }
        : {
            getCACertificates: (type: string) => (type === 'default' ? ['default'] : ['system']),
            setDefaultCACertificates,
          },
  });
  expect(readFileSync).not.toHaveBeenCalled();
  expect(setDefaultCACertificates).toHaveBeenCalledWith(['default', 'system']);
  expect(env).toEqual({});
});

test.each(['missing', 'invalid'])(
  'preload rejects a %s CA bundle without weakening trust',
  kind => {
    const setDefaultCACertificates = vi.fn();
    expect(() =>
      vm.runInNewContext(buildTrustedCertificatePreload(), {
        process: { env: { NODE_EXTRA_CA_CERTS: 'managed.pem' } },
        require: (name: string) =>
          name === 'node:fs'
            ? {
                readFileSync: () => {
                  if (kind === 'missing') throw new Error('ENOENT');
                  return 'not a PEM certificate';
                },
              }
            : { getCACertificates: () => ['current'], setDefaultCACertificates },
      }),
    ).toThrow('Unable to initialize trusted Node CA certificates');
    expect(setDefaultCACertificates).not.toHaveBeenCalled();
  },
);
