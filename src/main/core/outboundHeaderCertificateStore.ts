import { createPrivateKey, createPublicKey, type KeyObject, X509Certificate } from 'crypto';
import fs from 'fs';
import path from 'path';

const LEGACY_CA_COMMON_NAME = 'NodeMITMProxyCA';
const CA_CERTIFICATE_NAME = 'ca.pem';
const CA_PRIVATE_KEY_NAME = 'ca.private.key';
const CA_PUBLIC_KEY_NAME = 'ca.public.key';
const GENERATED_CERTIFICATE_DIRECTORIES = ['certs', 'keys'] as const;
const GENERATED_BUNDLE_NAMES = new Set(['trusted-ca-bundle.pem', 'gateway-trusted-ca-bundle.pem']);

export const OutboundHeaderCertificateResetReason = {
  Incomplete: 'incomplete',
  Invalid: 'invalid',
  Expired: 'expired',
  LegacyIdentity: 'legacy-identity',
  KeyMismatch: 'key-mismatch',
  StaleLeaf: 'stale-leaf',
} as const;

export type OutboundHeaderCertificateResetReason =
  (typeof OutboundHeaderCertificateResetReason)[keyof typeof OutboundHeaderCertificateResetReason];

const getSubjectCommonName = (certificate: X509Certificate): string | null => {
  const subject = certificate.toLegacyObject().subject;
  const commonName = subject?.CN;
  return typeof commonName === 'string' ? commonName : null;
};

const exportPublicKey = (key: KeyObject): Buffer =>
  key.export({ type: 'spki', format: 'der' }) as Buffer;

const keysMatch = (left: KeyObject, right: KeyObject): boolean =>
  exportPublicKey(left).equals(exportPublicKey(right));

const isCertificateCurrent = (certificate: X509Certificate): boolean => {
  const now = Date.now();
  return certificate.validFromDate.getTime() <= now && now <= certificate.validToDate.getTime();
};

const hasGeneratedCertificateMaterial = (caDirectory: string): boolean =>
  GENERATED_CERTIFICATE_DIRECTORIES.some(directoryName => {
    const directory = path.join(caDirectory, directoryName);
    return fs.existsSync(directory) && fs.readdirSync(directory).length > 0;
  });

const inspectCertificateStore = (
  caDirectory: string,
): OutboundHeaderCertificateResetReason | null => {
  if (!hasGeneratedCertificateMaterial(caDirectory)) {
    return null;
  }

  const certificatesDirectory = path.join(caDirectory, 'certs');
  const keysDirectory = path.join(caDirectory, 'keys');
  const caCertificatePath = path.join(certificatesDirectory, CA_CERTIFICATE_NAME);
  const caPrivateKeyPath = path.join(keysDirectory, CA_PRIVATE_KEY_NAME);
  const caPublicKeyPath = path.join(keysDirectory, CA_PUBLIC_KEY_NAME);
  if (
    !fs.existsSync(caCertificatePath) ||
    !fs.existsSync(caPrivateKeyPath) ||
    !fs.existsSync(caPublicKeyPath)
  ) {
    return OutboundHeaderCertificateResetReason.Incomplete;
  }

  try {
    const caCertificate = new X509Certificate(fs.readFileSync(caCertificatePath));
    if (getSubjectCommonName(caCertificate) === LEGACY_CA_COMMON_NAME) {
      return OutboundHeaderCertificateResetReason.LegacyIdentity;
    }
    if (!isCertificateCurrent(caCertificate)) {
      return OutboundHeaderCertificateResetReason.Expired;
    }
    if (
      !caCertificate.ca ||
      !caCertificate.checkIssued(caCertificate) ||
      !caCertificate.verify(caCertificate.publicKey)
    ) {
      return OutboundHeaderCertificateResetReason.Invalid;
    }

    const privateKeyPublic = createPublicKey(
      createPrivateKey(fs.readFileSync(caPrivateKeyPath, 'utf8')),
    );
    const storedPublicKey = createPublicKey(fs.readFileSync(caPublicKeyPath, 'utf8'));
    if (
      !keysMatch(caCertificate.publicKey, privateKeyPublic) ||
      !keysMatch(caCertificate.publicKey, storedPublicKey)
    ) {
      return OutboundHeaderCertificateResetReason.KeyMismatch;
    }

    for (const certificateName of fs.readdirSync(certificatesDirectory)) {
      if (
        certificateName === CA_CERTIFICATE_NAME ||
        GENERATED_BUNDLE_NAMES.has(certificateName) ||
        !certificateName.endsWith('.pem')
      ) {
        continue;
      }

      const leafCertificate = new X509Certificate(
        fs.readFileSync(path.join(certificatesDirectory, certificateName)),
      );
      const leafKeyPath = path.join(
        keysDirectory,
        `${certificateName.slice(0, -'.pem'.length)}.key`,
      );
      if (!isCertificateCurrent(leafCertificate)) {
        return OutboundHeaderCertificateResetReason.Expired;
      }
      if (
        !fs.existsSync(leafKeyPath) ||
        !leafCertificate.checkIssued(caCertificate) ||
        !leafCertificate.verify(caCertificate.publicKey)
      ) {
        return OutboundHeaderCertificateResetReason.StaleLeaf;
      }
      const leafPrivateKeyPublic = createPublicKey(
        createPrivateKey(fs.readFileSync(leafKeyPath, 'utf8')),
      );
      if (!keysMatch(leafCertificate.publicKey, leafPrivateKeyPublic)) {
        return OutboundHeaderCertificateResetReason.StaleLeaf;
      }
    }
  } catch {
    return OutboundHeaderCertificateResetReason.Invalid;
  }

  return null;
};

/**
 * Removes only app-generated certificate material when it cannot be reused safely.
 * Unknown sibling files under the proxy directory are deliberately preserved.
 */
export const prepareOutboundHeaderCertificateStore = (
  caDirectory: string,
): OutboundHeaderCertificateResetReason | null => {
  const resetReason = inspectCertificateStore(caDirectory);
  if (!resetReason) {
    return null;
  }

  for (const directoryName of GENERATED_CERTIFICATE_DIRECTORIES) {
    fs.rmSync(path.join(caDirectory, directoryName), { recursive: true, force: true });
  }
  return resetReason;
};
