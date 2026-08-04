'use strict';

// Purpose: Allow JustDo-managed pip mirror configuration to reach OpenClaw
// shell/tool subprocesses. OpenClaw v2026.6.11 blocks inherited PIP_CONFIG_FILE
// by default; JustDo sets it to a managed per-user config under app userData.
// Affected OpenClaw version: v2026.6.11.
// Risk: Allows inherited PIP_CONFIG_FILE through OpenClaw host env sanitization.
// Keep the JustDo side pointed at a managed file, never arbitrary user input.
// Remove when: OpenClaw exposes a scoped/approved mechanism for dependency
// manager config env passthrough.
// Temporary: yes.

const fs = require('fs');
const path = require('path');

const PATCH_MARKER = 'JUSTDO_ALLOW_MANAGED_PIP_CONFIG_ENV';
const TARGET_ENTRY = /(\r?\n)(\s*)"PIP_CONFIG_FILE",/g;

function walkJsFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsFiles(fullPath, out);
    } else if (entry.isFile() && /\.(?:js|mjs|cjs)$/.test(entry.name)) {
      out.push(fullPath);
    }
  }
  return out;
}

function patchFile(filePath) {
  const original = fs.readFileSync(filePath, 'utf8');
  if (original.includes(PATCH_MARKER)) {
    return false;
  }
  if (!original.includes('"PIP_CONFIG_FILE"')) {
    return false;
  }

  const next = original.replace(
    TARGET_ENTRY,
    `$1$2/* ${PATCH_MARKER}: JustDo injects a managed pip.ini path. */`,
  );
  if (next === original || next.includes('"PIP_CONFIG_FILE"')) {
    throw new Error(`Unable to remove PIP_CONFIG_FILE from host env block list: ${filePath}`);
  }

  fs.writeFileSync(filePath, next, 'utf8');
  return true;
}

function applyPatch(runtimeDir, options = {}) {
  const candidates = [
    path.join(runtimeDir, 'gateway-bundle.mjs'),
    ...walkJsFiles(path.join(runtimeDir, 'dist')),
  ].filter((filePath, index, all) => fs.existsSync(filePath) && all.indexOf(filePath) === index);

  const patched = candidates
    .filter(filePath => {
      const content = fs.readFileSync(filePath, 'utf8');
      return content.includes('"PIP_CONFIG_FILE"') || content.includes(PATCH_MARKER);
    })
    .filter(patchFile)
    .map(filePath => path.relative(runtimeDir, filePath));

  const label = options.label || 'patch-openclaw-allow-managed-pip-config-env';
  if (patched.length > 0) {
    console.log(`[${label}] Allowed managed PIP_CONFIG_FILE passthrough: ${patched.join(', ')}`);
  } else if (options.verbose) {
    console.log(`[${label}] Managed PIP_CONFIG_FILE passthrough is already patched.`);
  }
  return patched;
}

function verifyPatch(runtimeDir) {
  const content = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
  if (!content.includes(PATCH_MARKER)) {
    throw new Error('Managed PIP_CONFIG_FILE patch marker is missing');
  }
  const markerIndex = content.indexOf(PATCH_MARKER);
  const blockStart = content.lastIndexOf('[', markerIndex);
  const blockEnd = content.indexOf(']', markerIndex);
  if (blockStart < 0 || blockEnd < 0 || content.slice(blockStart, blockEnd).includes('"PIP_CONFIG_FILE"')) {
    throw new Error('PIP_CONFIG_FILE remains in the patched host environment block list');
  }
  return true;
}

module.exports = { applyPatch, verifyPatch };
