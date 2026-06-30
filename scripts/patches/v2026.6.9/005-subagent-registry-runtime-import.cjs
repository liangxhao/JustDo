'use strict';

// Purpose: Keep the bundled gateway's subagent registry runtime import pointed
// at dist/. esbuild preserves this import as dynamic runtime loading, but after
// bundling import.meta.url refers to gateway-bundle.mjs at the runtime root.
// Affected OpenClaw version: v2026.6.9.
// Risk: Low. This only changes the path used by the bundled gateway for the
// subagent registry runtime facade; the unbundled dist files are left intact.
// Remove when: OpenClaw no longer loads subagent-registry.runtime via
// importRuntimeModule(import.meta.url, ...), or the bundle inlines it upstream.
// Upstream tracking: TODO(openclaw): file issue/PR for bundled gateway dynamic
// runtime facade resolution.
// Temporary: yes.

const fs = require('fs');
const path = require('path');

function patchFile(filePath) {
  if (!fs.existsSync(filePath)) return false;

  let content = fs.readFileSync(filePath, 'utf8');
  const original = content;

  content = content.replace(
    /SUBAGENT_REGISTRY_RUNTIME_SPEC = \["\.\/subagent-registry\.runtime", "\.js"\];/g,
    'SUBAGENT_REGISTRY_RUNTIME_SPEC = ["./dist/subagent-registry.runtime", ".js"];',
  );

  if (content === original) return false;
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function applyPatch(runtimeDir, options = {}) {
  const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  const patched = patchFile(bundlePath) ? [path.relative(runtimeDir, bundlePath)] : [];
  const label = options.label || 'patch-openclaw-subagent-registry-runtime-import';

  if (patched.length > 0) {
    console.log(`[${label}] Patched subagent registry runtime import: ${patched.join(', ')}`);
  } else if (options.verbose) {
    console.log(`[${label}] No subagent registry runtime import patch needed.`);
  }

  return patched;
}

module.exports = { applyPatch };
