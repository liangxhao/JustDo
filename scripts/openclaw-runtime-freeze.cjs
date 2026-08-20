'use strict';

function decideRuntimeInstall({ forceInstall, targetExists }) {
  if (forceInstall || !targetExists) return 'install';
  return 'verify-frozen';
}

function decideRuntimeBundle({ forceInstall, bundleExists, initialBundlePending }) {
  if (forceInstall) return 'build';
  if (bundleExists) return 'verify-frozen';
  if (initialBundlePending) return 'build-initial';
  return 'reject';
}

module.exports = { decideRuntimeBundle, decideRuntimeInstall };
