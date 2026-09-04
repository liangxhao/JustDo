const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_PACKAGE_ROOT = path.join(__dirname, '..', 'node_modules', 'http-mitm-proxy');

const UNIQUE_CA_MARKER = 'justdo-installation-unique-ca-subject';
const UNIQUE_CA_BLOCK = [
  `// ${UNIQUE_CA_MARKER}`,
  'const caAttrs = CAattrs.map((attribute) => ({ ...attribute }));',
  'const commonName = caAttrs.find((attribute) => attribute.name === "commonName");',
  'if (commonName) {',
  'commonName.value = `NodeMITMProxyCA-${cert.generateSubjectKeyIdentifier().toHex()}`;',
  '}',
];

const findUniqueLineIndex = (lines, needle, target) => {
  const indexes = lines.flatMap((line, index) => (line.trim() === needle ? [index] : []));
  if (indexes.length !== 1) {
    throw new Error(
      `Unsupported http-mitm-proxy@1.1.0 source layout: ${target} (${needle}, count=${indexes.length})`,
    );
  }
  return indexes[0];
};

const patchCertificateAuthority = (lines, target) => {
  const serialIndex = findUniqueLineIndex(
    lines,
    'cert.serialNumber = self.randomSerialNumber();',
    target,
  );
  const trimmedLines = lines.map(line => line.trim());
  const markerIndexes = trimmedLines.flatMap((line, index) =>
    line === UNIQUE_CA_BLOCK[0] ? [index] : [],
  );
  const markerCount = lines.filter(line => line.includes(UNIQUE_CA_MARKER)).length;
  const hasCompleteBlock =
    markerCount === 1 &&
    markerIndexes.length === 1 &&
    markerIndexes[0] === serialIndex + 1 &&
    UNIQUE_CA_BLOCK.every((line, offset) => trimmedLines[markerIndexes[0] + offset] === line);
  const hasPatchedShape =
    hasCompleteBlock &&
    trimmedLines.filter(line => line === UNIQUE_CA_BLOCK[1]).length === 1 &&
    trimmedLines.filter(line => line === UNIQUE_CA_BLOCK[2]).length === 1 &&
    trimmedLines.filter(line => line === UNIQUE_CA_BLOCK[4]).length === 1 &&
    trimmedLines.filter(line => line === 'cert.setSubject(caAttrs);').length === 1 &&
    trimmedLines.filter(line => line === 'cert.setIssuer(caAttrs);').length === 1 &&
    !trimmedLines.includes('cert.setSubject(CAattrs);') &&
    !trimmedLines.includes('cert.setIssuer(CAattrs);');
  const hasAnyPatchedToken = trimmedLines.some(
    line =>
      line === UNIQUE_CA_BLOCK[0] ||
      line === UNIQUE_CA_BLOCK[1] ||
      line === UNIQUE_CA_BLOCK[2] ||
      line === UNIQUE_CA_BLOCK[4] ||
      line === 'cert.setSubject(caAttrs);' ||
      line === 'cert.setIssuer(caAttrs);',
  );
  if (!hasPatchedShape && (markerCount > 0 || hasAnyPatchedToken)) {
    throw new Error(`Partially applied JustDo CA identity patch: ${target}`);
  }

  if (!hasPatchedShape) {
    const indent = lines[serialIndex].match(/^\s*/)[0];
    lines.splice(
      serialIndex + 1,
      0,
      ...UNIQUE_CA_BLOCK.map((line, index) =>
        index === 4 ? `${indent}  ${line}` : `${indent}${line}`,
      ),
    );
    const subjectIndex = findUniqueLineIndex(lines, 'cert.setSubject(CAattrs);', target);
    const issuerIndex = findUniqueLineIndex(lines, 'cert.setIssuer(CAattrs);', target);
    lines[subjectIndex] = lines[subjectIndex].replace('CAattrs', 'caAttrs');
    lines[issuerIndex] = lines[issuerIndex].replace('CAattrs', 'caAttrs');
  }
};

const patchHttpMitmProxy = (packageRoot = DEFAULT_PACKAGE_ROOT) => {
  const packageMetadata = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
  );
  if (packageMetadata.version !== '1.1.0') {
    throw new Error(`Unsupported http-mitm-proxy version: ${packageMetadata.version}`);
  }

  const targets = [
    path.join(packageRoot, 'lib', 'ca.ts'),
    path.join(packageRoot, 'dist', 'lib', 'ca.js'),
    path.join(packageRoot, 'lib', 'proxy.ts'),
    path.join(packageRoot, 'dist', 'lib', 'proxy.js'),
  ];
  for (const target of targets) {
    if (!fs.existsSync(target)) {
      throw new Error(`http-mitm-proxy file is missing: ${target}`);
    }
    const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/);
    if (path.basename(target).startsWith('ca.')) {
      patchCertificateAuthority(lines, target);
    } else {
      if (!lines.some(line => line.includes('getHttpsServer(hostname, (err, port) => {'))) {
        throw new Error(`Unsupported http-mitm-proxy@1.1.0 source layout: ${target}`);
      }
      // Keep the semaphore for the proxy lifetime. Deleting it when one hostname
      // completes lets a sibling hostname create a second semaphore while waiters
      // still exist on the first wildcard-keyed semaphore.
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        if (lines[index].includes('delete self.sslSemaphores[wildcardHost];')) {
          lines.splice(index, 1);
        }
      }
    }
    fs.writeFileSync(target, lines.join('\n'), 'utf8');
  }
};

if (require.main === module) {
  patchHttpMitmProxy();
}

module.exports = { patchCertificateAuthority, patchHttpMitmProxy };
