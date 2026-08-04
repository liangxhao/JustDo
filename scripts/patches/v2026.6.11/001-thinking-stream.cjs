'use strict';

// Purpose: Keep reasoning stream emission enabled even when the caller has no
// onReasoningStream callback, while still guarding optional callback calls,
// and include a bounded thinking preview in Gateway websocket diagnostics.
// Affected OpenClaw version: v2026.6.11.
// Risk: Diverges from upstream reasoning-stream gating and diagnostic summary
// semantics; thinking previews can expose up to 80 characters in debug logs.
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

  const wsSummaryMarker = 'function summarizeAgentEventForWsLog(payload) {';
  const wsSummaryVariants = [
    {
      existingMarker: '  if (stream3 === "thinking") {',
      toolMarker: '  if (stream3 === "tool") {',
      thinkingPreviewBlock: `  if (stream3 === "thinking") {
    const text2 = readStringValue(data.text);
    if (text2?.trim()) extra.text = compactPreview(text2, 80);
    return extra;
  }
`,
    },
    {
      existingMarker: '\tif (stream === "thinking") {',
      toolMarker: '\tif (stream === "tool") {',
      thinkingPreviewBlock: `\tif (stream === "thinking") {
\t\tconst text = readStringValue(data.text);
\t\tif (text?.trim()) extra.text = compactPreview(text, 80);
\t\treturn extra;
\t}
`,
    },
  ];
  const wsSummaryIndex = content.indexOf(wsSummaryMarker);
  if (wsSummaryIndex >= 0) {
    const prefix = content.slice(0, wsSummaryIndex);
    let suffix = content.slice(wsSummaryIndex);
    const alreadyPatched = wsSummaryVariants.some(variant =>
      suffix.includes(variant.existingMarker),
    );
    if (!alreadyPatched) {
      const variant = wsSummaryVariants.find(candidate => suffix.includes(candidate.toolMarker));
      if (!variant) {
        throw new Error(`Thinking WS log preview target not found in ${filePath}`);
      }
      suffix = suffix.replace(
        variant.toolMarker,
        `${variant.thinkingPreviewBlock}${variant.toolMarker}`,
      );
      content = prefix + suffix;
    }
  }

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
    console.log(`[${label}] Patched reasoning stream and log preview: ${patched.join(', ')}`);
  } else if (options.verbose) {
    console.log(`[${label}] No reasoning stream patch needed.`);
  }

  return patched;
}

function verifyPatch(runtimeDir) {
  const filePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  const content = fs.readFileSync(filePath, 'utf8');
  const required = [
    'streamReasoning: reasoningMode === "stream" && canShowReasoning',
    'if (params.onReasoningStream) params.onReasoningStream({ text: trimmed });',
    'if (stream3 === "thinking") {',
    'if (text2?.trim()) extra.text = compactPreview(text2, 80);',
  ];
  const missing = required.filter(marker => !content.includes(marker));
  if (!/if \(![A-Za-z_$][\w$]*\.streamReasoning\) return;/.test(content)) {
    missing.push('reasoning stream callback-independent guard');
  }
  if (missing.length > 0) throw new Error(`Thinking stream patch is incomplete: ${missing.join(', ')}`);
  return true;
}

module.exports = { applyPatch, verifyPatch };
