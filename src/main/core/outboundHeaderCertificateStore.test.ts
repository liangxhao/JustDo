import { X509Certificate } from 'crypto';
import fs from 'fs';
import CA from 'http-mitm-proxy/dist/lib/ca';
import type { AddressInfo } from 'net';
import Forge from 'node-forge';
import os from 'os';
import path from 'path';
import tls from 'tls';
import { afterEach, expect, test } from 'vitest';

import {
  OutboundHeaderCertificateResetReason,
  prepareOutboundHeaderCertificateStore,
} from './outboundHeaderCertificateStore';

const temporaryDirectories: string[] = [];

const createTempDir = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-proxy-cert-store-'));
  temporaryDirectories.push(directory);
  return directory;
};

const createCertificateAuthority = (directory: string): Promise<CA> =>
  new Promise((resolve, reject) => {
    CA.create(directory, (error: Error | null, certificateAuthority: CA) =>
      error ? reject(error) : resolve(certificateAuthority),
    );
  });

const generateServerCertificate = (
  certificateAuthority: CA,
  hostname: string,
): Promise<{ certificate: string; privateKey: string }> =>
  new Promise(resolve => {
    certificateAuthority.generateServerCertificateKeys(
      hostname,
      (certificate: string, privateKey: string) => resolve({ certificate, privateKey }),
    );
  });

const connectWithCertificateAuthorities = async (
  leaf: { certificate: string; privateKey: string },
  certificateAuthorities: string[],
): Promise<void> => {
  const server = tls.createServer({ cert: leaf.certificate, key: leaf.privateKey }, socket =>
    socket.end(),
  );
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve, reject) => {
      const socket = tls.connect({
        ca: certificateAuthorities,
        host: '127.0.0.1',
        port,
        rejectUnauthorized: true,
        servername: 'model.example.com',
      });
      socket.once('secureConnect', () => {
        socket.end();
        resolve();
      });
      socket.once('error', reject);
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
  }
};

const writeCertificateAuthority = (
  directory: string,
  commonName: string,
  validity: { notAfter: Date; notBefore: Date } = {
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000),
  },
): void => {
  const { md, pki } = Forge;
  const keys = pki.rsa.generateKeyPair(2_048);
  const certificate = pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = '01';
  certificate.validity.notBefore = validity.notBefore;
  certificate.validity.notAfter = validity.notAfter;
  const attributes = [{ name: 'commonName', value: commonName }];
  certificate.setSubject(attributes);
  certificate.setIssuer(attributes);
  certificate.setExtensions([{ name: 'basicConstraints', cA: true }]);
  certificate.sign(keys.privateKey, md.sha256.create());

  fs.mkdirSync(path.join(directory, 'certs'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'keys'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'certs', 'ca.pem'), pki.certificateToPem(certificate));
  fs.writeFileSync(
    path.join(directory, 'keys', 'ca.private.key'),
    pki.privateKeyToPem(keys.privateKey),
  );
  fs.writeFileSync(
    path.join(directory, 'keys', 'ca.public.key'),
    pki.publicKeyToPem(keys.publicKey),
  );
};

const writeLegacyCertificateAuthority = (directory: string): void =>
  writeCertificateAuthority(directory, 'NodeMITMProxyCA');

const writeExpiredLeaf = (directory: string, certificateAuthority: CA, hostname: string): void => {
  const { md, pki } = Forge;
  const keys = pki.rsa.generateKeyPair(2_048);
  const certificate = pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = '02';
  certificate.validity.notBefore = new Date(Date.now() - 172_800_000);
  certificate.validity.notAfter = new Date(Date.now() - 86_400_000);
  certificate.setSubject([{ name: 'commonName', value: hostname }]);
  certificate.setIssuer(certificateAuthority.CAcert.issuer.attributes);
  certificate.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] },
  ]);
  certificate.sign(certificateAuthority.CAkeys.privateKey, md.sha256.create());
  fs.writeFileSync(
    path.join(directory, 'certs', `${hostname}.pem`),
    pki.certificateToPem(certificate),
  );
  fs.writeFileSync(
    path.join(directory, 'keys', `${hostname}.key`),
    pki.privateKeyToPem(keys.privateKey),
  );
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rotates the legacy fixed-subject certificate authority while preserving sibling files', () => {
  const directory = createTempDir();
  writeLegacyCertificateAuthority(directory);
  fs.writeFileSync(path.join(directory, 'keep.txt'), 'keep');

  expect(prepareOutboundHeaderCertificateStore(directory)).toBe(
    OutboundHeaderCertificateResetReason.LegacyIdentity,
  );
  expect(fs.existsSync(path.join(directory, 'certs'))).toBe(false);
  expect(fs.existsSync(path.join(directory, 'keys'))).toBe(false);
  expect(fs.readFileSync(path.join(directory, 'keep.txt'), 'utf8')).toBe('keep');
});

test('keeps a valid installation-unique certificate authority', async () => {
  const directory = createTempDir();
  const certificateAuthority = await createCertificateAuthority(directory);

  expect(certificateAuthority.CAcert.subject.getField('CN').value).toMatch(
    /^NodeMITMProxyCA-[0-9a-f]{40}$/,
  );
  expect(prepareOutboundHeaderCertificateStore(directory)).toBeNull();
  expect(fs.existsSync(path.join(directory, 'certs', 'ca.pem'))).toBe(true);
});

test.each([
  {
    expectedReason: OutboundHeaderCertificateResetReason.Incomplete,
    mutate(directory: string) {
      fs.rmSync(path.join(directory, 'keys', 'ca.public.key'));
    },
    name: 'incomplete certificate material',
  },
  {
    expectedReason: OutboundHeaderCertificateResetReason.Invalid,
    mutate(directory: string) {
      fs.writeFileSync(path.join(directory, 'certs', 'ca.pem'), 'not a certificate');
    },
    name: 'an invalid CA certificate',
  },
  {
    expectedReason: OutboundHeaderCertificateResetReason.KeyMismatch,
    async mutate(directory: string) {
      const otherDirectory = createTempDir();
      await createCertificateAuthority(otherDirectory);
      fs.copyFileSync(
        path.join(otherDirectory, 'keys', 'ca.private.key'),
        path.join(directory, 'keys', 'ca.private.key'),
      );
    },
    name: 'a mismatched CA private key',
  },
  {
    expectedReason: OutboundHeaderCertificateResetReason.Expired,
    mutate(directory: string) {
      writeCertificateAuthority(directory, 'NodeMITMProxyCA-expired-test', {
        notBefore: new Date(Date.now() - 172_800_000),
        notAfter: new Date(Date.now() - 86_400_000),
      });
    },
    name: 'an expired CA certificate',
  },
  {
    expectedReason: OutboundHeaderCertificateResetReason.Expired,
    async mutate(directory: string) {
      const certificateAuthority = await createCertificateAuthority(directory);
      writeExpiredLeaf(directory, certificateAuthority, 'expired.example.com');
    },
    name: 'an expired leaf certificate',
    skipInitialAuthority: true,
  },
])('rotates $name', async testCase => {
  const { expectedReason, mutate } = testCase;
  const directory = createTempDir();
  if (!('skipInitialAuthority' in testCase) || !testCase.skipInitialAuthority) {
    await createCertificateAuthority(directory);
  }
  await mutate(directory);

  expect(prepareOutboundHeaderCertificateStore(directory)).toBe(expectedReason);
  expect(fs.existsSync(path.join(directory, 'certs'))).toBe(false);
  expect(fs.existsSync(path.join(directory, 'keys'))).toBe(false);
});

test('gives new leaves an unambiguous issuer when a legacy CA remains trusted', async () => {
  const legacyWrongDirectory = createTempDir();
  writeLegacyCertificateAuthority(legacyWrongDirectory);
  const legacyWrongAuthority = await createCertificateAuthority(legacyWrongDirectory);
  const legacySignerDirectory = createTempDir();
  writeLegacyCertificateAuthority(legacySignerDirectory);
  const legacySignerAuthority = await createCertificateAuthority(legacySignerDirectory);
  const legacyLeaf = await generateServerCertificate(legacySignerAuthority, 'model.example.com');

  const legacyLeafCertificate = new X509Certificate(legacyLeaf.certificate);
  const legacyWrongCertificate = new X509Certificate(legacyWrongAuthority.getPem());
  const legacySignerCertificate = new X509Certificate(legacySignerAuthority.getPem());
  expect(legacyLeafCertificate.checkIssued(legacyWrongCertificate)).toBe(true);
  expect(legacyLeafCertificate.verify(legacyWrongCertificate.publicKey)).toBe(false);
  expect(legacyLeafCertificate.checkIssued(legacySignerCertificate)).toBe(true);
  expect(legacyLeafCertificate.verify(legacySignerCertificate.publicKey)).toBe(true);

  const uniqueDirectory = createTempDir();
  const uniqueAuthority = await createCertificateAuthority(uniqueDirectory);
  const uniqueLeaf = await generateServerCertificate(uniqueAuthority, 'model.example.com');
  const uniqueLeafCertificate = new X509Certificate(uniqueLeaf.certificate);
  const uniqueCaCertificate = new X509Certificate(uniqueAuthority.getPem());
  expect(uniqueLeafCertificate.checkIssued(legacyWrongCertificate)).toBe(false);
  expect(uniqueLeafCertificate.checkIssued(uniqueCaCertificate)).toBe(true);

  await expect(
    connectWithCertificateAuthorities(uniqueLeaf, [
      legacyWrongAuthority.getPem(),
      uniqueAuthority.getPem(),
    ]),
  ).resolves.toBeUndefined();
});

test('uses distinct CA subjects and rotates a leaf signed by another authority', async () => {
  const directory = createTempDir();
  const certificateAuthority = await createCertificateAuthority(directory);
  const otherDirectory = createTempDir();
  const otherCertificateAuthority = await createCertificateAuthority(otherDirectory);
  expect(otherCertificateAuthority.CAcert.subject.getField('CN').value).not.toBe(
    certificateAuthority.CAcert.subject.getField('CN').value,
  );
  const otherLeaf = await generateServerCertificate(otherCertificateAuthority, 'model.example.com');
  fs.writeFileSync(path.join(directory, 'certs', 'model.example.com.pem'), otherLeaf.certificate);
  fs.writeFileSync(path.join(directory, 'keys', 'model.example.com.key'), otherLeaf.privateKey);

  expect(prepareOutboundHeaderCertificateStore(directory)).toBe(
    OutboundHeaderCertificateResetReason.StaleLeaf,
  );
  expect(fs.existsSync(path.join(directory, 'certs'))).toBe(false);
  expect(fs.existsSync(path.join(directory, 'keys'))).toBe(false);
});
