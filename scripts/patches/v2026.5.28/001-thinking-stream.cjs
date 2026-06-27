'use strict';

// Purpose: Keep reasoning stream emission enabled even when the caller has no
// onReasoningStream callback, while still guarding optional callback calls.
// Affected OpenClaw version: v2026.5.28.
// Risk: Diverges from upstream reasoning-stream gating semantics.
// Remove when: OpenClaw exposes thinking stream events without requiring a
// callback gate, or JustDo consumes the upstream event shape directly.
// Upstream tracking: TODO(openclaw): file issue/PR with reasoning stream fixture.
// Temporary: yes.

const fs = require('fs');
const path = require('path');

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
  let content = fs.readFileSync(filePath, 'utf8');
  const original = content;

  content = content.replace(
    /streamReasoning:\s*reasoningMode === "stream" && canShowReasoning && typeof params\.onReasoningStream === "function"/g,
    'streamReasoning: reasoningMode === "stream" && canShowReasoning',
  );

  content = content.replace(
    /if \(!([A-Za-z_$][\w$]*)\.streamReasoning \|\| !params\.onReasoningStream\) return;/g,
    'if (!$1.streamReasoning) return;',
  );

  content = content.replace(
    /(?<!if \(params\.onReasoningStream\) )params\.onReasoningStream\(\{ text: trimmed \}\);/g,
    'if (params.onReasoningStream) params.onReasoningStream({ text: trimmed });',
  );

  content = content.replace(
    /(?:if \(params\.onReasoningStream\) )+params\.onReasoningStream\(\{ text: trimmed \}\);/g,
    'if (params.onReasoningStream) params.onReasoningStream({ text: trimmed });',
  );

  if (content === original) return false;
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function applyPatch(runtimeDir, options = {}) {
  const candidates = [
    path.join(runtimeDir, 'gateway-bundle.mjs'),
    ...walkJsFiles(path.join(runtimeDir, 'dist')),
  ].filter((filePath, index, arr) => fs.existsSync(filePath) && arr.indexOf(filePath) === index);

  const patched = [];
  for (const filePath of candidates) {
    if (patchFile(filePath)) {
      patched.push(path.relative(runtimeDir, filePath));
    }
  }

  const label = options.label || 'patch-openclaw-thinking-stream';
  if (patched.length > 0) {
    console.log(`[${label}] Patched reasoning stream gate: ${patched.join(', ')}`);
  } else if (options.verbose) {
    console.log(`[${label}] No reasoning stream patch needed.`);
  }

  return patched;
}

module.exports = { applyPatch };
