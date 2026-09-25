'use strict';

function decideRuntimeInstall({ forceInstall, targetExists, currentVersion, targetVersion }) {
  if (forceInstall || !targetExists) return 'install';
  if (
    typeof currentVersion === 'string' &&
    typeof targetVersion === 'string' &&
    currentVersion !== targetVersion
  ) {
    return 'install';
  }
  return 'verify-frozen';
}

function decideRuntimeBundle({ forceInstall, bundleExists, initialBundlePending }) {
  if (forceInstall) return 'build';
  if (bundleExists) return 'verify-frozen';
  if (initialBundlePending) return 'build-initial';
  return 'reject';
}

module.exports = { decideRuntimeBundle, decideRuntimeInstall };
