'use strict';

const { createHash } = require('crypto');
const { createReadStream, existsSync, readFileSync, statSync } = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const { readWindowsUpdateConfig } = require('./windows-update-config.cjs');
const { releaseHistory: releaseHistoryLimits } = require('../src/shared/appUpdateConfig.json');

const UPDATE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function validateReleaseHistory(releaseHistory, manifest) {
  if (
    releaseHistory?.schemaVersion !== 1 ||
    releaseHistory?.latestVersion !== manifest.version ||
    !Array.isArray(releaseHistory?.releases) ||
    releaseHistory.releases.length === 0 ||
    releaseHistory.releases.length > releaseHistoryLimits.maxEntries ||
    releaseHistory.releases[0]?.version !== manifest.version ||
    releaseHistory.releases[0]?.releaseDate !== manifest.releaseDate ||
    releaseHistory.releases[0]?.releaseNotes !== manifest.releaseNotes
  ) {
    return false;
  }

  const versions = new Set();
  for (let index = 0; index < releaseHistory.releases.length; index += 1) {
    const release = releaseHistory.releases[index];
    if (
      !release ||
      typeof release.version !== 'string' ||
      !UPDATE_VERSION_PATTERN.test(release.version) ||
      versions.has(release.version) ||
      typeof release.releaseDate !== 'string' ||
      release.releaseDate.length > releaseHistoryLimits.maxReleaseDateLength ||
      !Number.isFinite(Date.parse(release.releaseDate)) ||
      typeof release.releaseNotes !== 'string' ||
      release.releaseNotes.length > releaseHistoryLimits.maxReleaseNotesLength
    ) {
      return false;
    }
    versions.add(release.version);
    if (
      index > 0 &&
      Date.parse(releaseHistory.releases[index - 1].releaseDate) < Date.parse(release.releaseDate)
    ) {
      return false;
    }
  }
  return true;
}

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

  const releaseHistoryPath = path.join(releaseDir, 'release-history.json');
  if (!existsSync(releaseHistoryPath)) {
    throw new Error(`Missing release history: ${releaseHistoryPath}`);
  }
  if (statSync(releaseHistoryPath).size > releaseHistoryLimits.maxBytes) {
    throw new Error('release-history.json exceeds the supported size limit.');
  }
  const releaseHistory = JSON.parse(readFileSync(releaseHistoryPath, 'utf8'));
  if (!validateReleaseHistory(releaseHistory, manifest)) {
    throw new Error('release-history.json latest release does not match latest.yml.');
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
  if (!existsSync(appUpdatePath))
    throw new Error(`Missing packaged update config: ${appUpdatePath}`);
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

  return { installerPath, manifestPath, releaseHistoryPath };
}

if (require.main === module) {
  const releaseDir = path.resolve(process.argv[2] || 'release');
  verifyWindowsUpdateArtifacts(releaseDir)
    .then(result =>
      console.log(`[verify-windows-update-artifacts] Verified ${result.installerPath}`),
    )
    .catch(error => {
      console.error(`[verify-windows-update-artifacts] ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = { validateReleaseHistory, verifyWindowsUpdateArtifacts };
