const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.join(__dirname, '..', 'node_modules', 'http-mitm-proxy');
const packageMetadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
if (packageMetadata.version !== '1.1.0') {
  throw new Error(`Unsupported http-mitm-proxy version: ${packageMetadata.version}`);
}

const targets = [
  path.join(packageRoot, 'lib', 'proxy.ts'),
  path.join(packageRoot, 'dist', 'lib', 'proxy.js'),
];

for (const target of targets) {
  if (!fs.existsSync(target)) {
    throw new Error(`http-mitm-proxy file is missing: ${target}`);
  }
  const lines = fs
    .readFileSync(target, 'utf8')
    .split(/\r?\n/)
    .filter(line => !line.includes('delete self.sslSemaphores[wildcardHost];'));
  if (!lines.some(line => line.includes('getHttpsServer(hostname, (err, port) => {'))) {
    throw new Error(`Unsupported http-mitm-proxy@1.1.0 source layout: ${target}`);
  }
  // Keep the semaphore for the proxy lifetime. Deleting it when one hostname
  // completes lets a sibling hostname create a second semaphore while waiters
  // still exist on the first wildcard-keyed semaphore.
  fs.writeFileSync(target, lines.join('\n'), 'utf8');
}
