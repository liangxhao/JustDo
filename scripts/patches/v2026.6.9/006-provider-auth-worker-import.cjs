'use strict';

// Purpose: Keep the bundled gateway's worker URLs pointed at the extracted
// dist/agents workers. esbuild preserves these workers as separate files, but
// after bundling import.meta.url points at gateway-bundle.mjs in the runtime
// root, so the upstream fallback looks for nonexistent root-level *.worker.mjs
// files.
// Affected OpenClaw version: v2026.6.9.
// Risk: Low. This only changes bundled gateway fallback paths used when the
// current module is not already under dist/.
// Remove when: OpenClaw resolves this worker URL relative to the runtime dist
// directory in bundled builds, or the worker is inlined upstream.
// Upstream tracking: TODO(openclaw): file issue/PR for bundled gateway worker
// URL resolution.
// Temporary: yes.

const fs = require('fs');
const path = require('path');

function patchFile(filePath) {
  if (!fs.existsSync(filePath)) return false;

  let content = fs.readFileSync(filePath, 'utf8');
  const original = content;

  const replacements = [
    [
      /const extension2 = path199\.extname\(currentPath\) \|\| "\.js";\s*return new URL\(`\.\/model-provider-auth\.worker\$\{extension2\}`, currentModuleUrl\);/g,
      'return new URL("./dist/agents/model-provider-auth.worker.js", currentModuleUrl);',
    ],
    [
      /const extension2 = path271\.extname\(currentPath\) \|\| "\.js";\s*return new URL\(`\.\/compaction-planning\.worker\$\{extension2\}`, currentModuleUrl\);/g,
      'return new URL("./dist/agents/compaction-planning.worker.js", currentModuleUrl);',
    ],
    [
      /const extension2 = path283\.extname\(currentPath\) \|\| "\.js";\s*return new URL\(`\.\/code-mode\.worker\$\{extension2\}`, currentModuleUrl\);/g,
      'return new URL("./dist/agents/code-mode.worker.js", currentModuleUrl);',
    ],
  ];

  for (const [pattern, replacement] of replacements) {
    content = content.replace(pattern, replacement);
  }

  if (content === original) return false;
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function applyPatch(runtimeDir, options = {}) {
  const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  const patched = patchFile(bundlePath) ? [path.relative(runtimeDir, bundlePath)] : [];
  const label = options.label || 'patch-openclaw-provider-auth-worker-import';

  if (patched.length > 0) {
    console.log(`[${label}] Patched provider auth worker import: ${patched.join(', ')}`);
  } else if (options.verbose) {
    console.log(`[${label}] No provider auth worker import patch needed.`);
  }

  return patched;
}

module.exports = { applyPatch };
