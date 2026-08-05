'use strict';

const { createHash } = require('crypto');
const { createReadStream, existsSync, readFileSync, statSync } = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const { readWindowsUpdateConfig } = require('./windows-update-config.cjs');

function sha512File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('base64')));
  });
}

async function verifyWindowsUpdateArtifacts(releaseDir, env = process.env) {
  const updateConfig = readWindowsUpdateConfig(env);
  const manifestPath = path.join(releaseDir, 'latest.yml');
  if (!existsSync(manifestPath)) throw new Error(`Missing update manifest: ${manifestPath}`);

  const manifest = yaml.load(readFileSync(manifestPath, 'utf8'));
  if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.files)) {
    throw new Error('latest.yml is not a valid update manifest.');
  }
  if (manifest.files.length !== 1 || typeof manifest.path !== 'string') {
    throw new Error('latest.yml must reference exactly one Windows installer.');
  }
  const fileInfo = manifest.files[0];
  if (fileInfo.url !== manifest.path || path.basename(manifest.path) !== manifest.path) {
    throw new Error('latest.yml installer paths must match and contain only a filename.');
  }
  if (!Object.prototype.hasOwnProperty.call(manifest, 'releaseNotes')) {
    throw new Error('latest.yml must explicitly contain releaseNotes.');
  }

  const installerPath = path.join(releaseDir, manifest.path);
  if (!existsSync(installerPath)) throw new Error(`Missing installer: ${installerPath}`);
  if (statSync(installerPath).size !== fileInfo.size) throw new Error('Installer size mismatch.');
  const hash = await sha512File(installerPath);
  if (hash !== fileInfo.sha512 || hash !== manifest.sha512) {
    throw new Error('Installer SHA-512 mismatch.');
  }
  if (!existsSync(`${installerPath}.blockmap`)) {
    throw new Error(`Missing differential update blockmap: ${installerPath}.blockmap`);
  }

  const appUpdatePath = path.join(releaseDir, 'win-unpacked', 'resources', 'app-update.yml');
  if (!existsSync(appUpdatePath)) throw new Error(`Missing packaged update config: ${appUpdatePath}`);
  const configuredMarkerPath = path.join(
    releaseDir,
    'win-unpacked',
    'resources',
    '.justdo-auto-update-configured',
  );
  if (!existsSync(configuredMarkerPath)) {
    throw new Error(`Missing packaged auto-update marker: ${configuredMarkerPath}`);
  }
  const appUpdate = yaml.load(readFileSync(appUpdatePath, 'utf8'));
  if (appUpdate?.provider !== 'generic' || appUpdate?.url !== updateConfig.feedUrl) {
    throw new Error('Packaged app-update.yml does not match the configured Generic feed.');
  }

  return { installerPath, manifestPath };
}

if (require.main === module) {
  const releaseDir = path.resolve(process.argv[2] || 'release');
  verifyWindowsUpdateArtifacts(releaseDir)
    .then(result => console.log(`[verify-windows-update-artifacts] Verified ${result.installerPath}`))
    .catch(error => {
      console.error(`[verify-windows-update-artifacts] ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = { verifyWindowsUpdateArtifacts };
