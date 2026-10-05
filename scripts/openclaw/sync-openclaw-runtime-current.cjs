'use strict';

const fs = require('fs');
const path = require('path');

function fail(message) {
  console.error(`[sync-openclaw-runtime-current] ${message}`);
  process.exit(1);
}

function extractRuntimeEntryFiles(runtimeRoot) {
  const gatewayAsarPath = path.join(runtimeRoot, 'gateway.asar');
  if (!fs.existsSync(gatewayAsarPath)) return 0;
  const asar = require('@electron/asar');
  let extracted = 0;
  for (const entry of asar.listPackage(gatewayAsarPath)) {
    const normalized = entry.replace(/\\/g, '/').replace(/^\//, '');
    if (
      !['openclaw.mjs', 'node-version.mjs', 'package.json'].includes(normalized) &&
      !normalized.startsWith('dist/')
    )
      continue;
    const destPath = path.join(runtimeRoot, normalized);
    if (fs.existsSync(destPath)) continue;
    // Keep archive separators for lookup; normalize only the destination path.
    const asarEntry = entry.replace(/^[/\\]/, '');
    const metadata = asar.statFile(gatewayAsarPath, asarEntry);
    if (metadata.files) continue;
    const content = asar.extractFile(gatewayAsarPath, asarEntry);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, content);
    extracted++;
  }
  return extracted;
}

function main() {
  const targetId = (process.argv[2] || '').trim();
  if (!targetId) {
    fail(
      'Missing target id. Usage: node scripts/openclaw/sync-openclaw-runtime-current.cjs <target-id>',
    );
  }

  const rootDir = path.resolve(__dirname, '../..');
  const runtimeBaseDir = path.join(rootDir, 'vendor', 'openclaw-runtime');
  const targetRuntimeDir = path.join(runtimeBaseDir, targetId);
  const currentRuntimeDir = path.join(runtimeBaseDir, 'current');

  if (!fs.existsSync(targetRuntimeDir)) {
    fail(`Target runtime does not exist: ${targetRuntimeDir}`);
  }

  // Remove existing current (handle both real dirs and symlinks/junctions safely).
  try {
    const stat = fs.lstatSync(currentRuntimeDir);
    if (stat.isSymbolicLink()) {
      // Junction (Windows) or symlink (macOS/Linux) — unlink without following.
      fs.unlinkSync(currentRuntimeDir);
    } else {
      fs.rmSync(currentRuntimeDir, { recursive: true, force: true });
    }
  } catch (_e) {
    // Does not exist — nothing to remove.
  }

  // Use a directory junction (Windows) or symlink (macOS/Linux) instead of
  // copying thousands of node_modules files.  This is near-instant.
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(targetRuntimeDir, currentRuntimeDir, linkType);

  console.log(
    `[sync-openclaw-runtime-current] Synced ${targetId} -> vendor/openclaw-runtime/current`,
  );

  // Extract entry files from gateway.asar if bare files are missing.
  // On Windows, Electron's utilityProcess.fork() cannot load ESM from inside .asar archives,
  // so bare files must exist on the real filesystem.
  // An existing CLI entry does not prove that native workers are present.
  // Materialize missing files from this same frozen archive on every sync.
  try {
    const extracted = extractRuntimeEntryFiles(currentRuntimeDir);
    console.log(
      `[sync-openclaw-runtime-current] Extracted ${extracted} missing entry files from gateway.asar`,
    );
  } catch (err) {
    fail(`Could not extract from gateway.asar: ${err.message}`);
  }

  // NOTE: facade-activation-check.runtime.js and its dependencies are NOT copied to root.
  // The openclaw-facade-runtime-dist-path.patch modifies facade-runtime.ts to load from
  // ./dist/facade-activation-check.runtime.js directly, where all dependencies exist.
  // This avoids copying ~1610 dependency files to maintain the import chain.
}

if (require.main === module) main();

module.exports = { extractRuntimeEntryFiles };
