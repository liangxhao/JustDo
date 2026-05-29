'use strict';

const fs = require('fs');
const path = require('path');

function patchFile(filePath) {
  if (!fs.existsSync(filePath)) return false;

  let content = fs.readFileSync(filePath, 'utf8');
  const original = content;

  content = content.replace(
    /SUBAGENT_REGISTRY_RUNTIME_SPEC = \["\.\/subagent-registry\.runtime", "\.js"\]/g,
    'SUBAGENT_REGISTRY_RUNTIME_SPEC = ["./dist/subagent-registry.runtime", ".js"]',
  );

  if (content === original) return false;
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function applyPatch(runtimeDir, options = {}) {
  const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  const patched = patchFile(bundlePath) ? [path.relative(runtimeDir, bundlePath)] : [];

  const label = options.label || 'patch-openclaw-subagent-registry-runtime-path';
  if (patched.length > 0) {
    console.log(`[${label}] Patched subagent registry runtime path: ${patched.join(', ')}`);
  } else if (options.verbose) {
    console.log(`[${label}] No subagent registry runtime path patch needed.`);
  }

  return patched;
}

module.exports = { applyPatch };
