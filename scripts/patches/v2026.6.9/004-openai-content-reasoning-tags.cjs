'use strict';

// Purpose: Preserve <think>...</think> content as reasoning deltas when an
// OpenAI-compatible provider embeds reasoning inside delta.content.
// Affected OpenClaw version: v2026.6.9.
// Risk: Exposes content explicitly marked with supported reasoning tags through
// the normal reasoning stream instead of silently discarding it.
// Remove when: OpenClaw forwards reasoningTagTextPartitioner "thinking" output
// from the OpenAI completions adapter upstream.
// Upstream tracking: TODO(openclaw): file issue/PR with content-tag reasoning fixture.
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

  // pushVisible() buffers an open <think> block until </think> arrives so it
  // can recover malformed visible text. For a reasoning-enabled model this
  // makes the whole thinking block appear at once. The strict push() path
  // preserves the partitioner's split-tag handling while emitting each
  // completed reasoning delta immediately.
  content = content.replace(
    /const routedDeltas = hasMirroredReasoning \? reasoningTagTextPartitioner\.push\(([^)]+)\) : reasoningTagTextPartitioner\.pushVisible\(\1\);/g,
    'const routedDeltas = reasoningTagTextPartitioner.push($1);',
  );

  // Legacy/simple OpenAI completions stream.
  content = content.replace(
    /for \(const delta of routedDeltas\) if \(delta\.kind === "text"\) appendTextDelta\(delta\.text\);/g,
    'for (const delta of routedDeltas) {\n' +
      '        if (delta.kind === "text") appendTextDelta(delta.text);\n' +
      '        else appendThinkingDelta("reasoning_content", delta.text);\n' +
      '      }',
  );

  content = content.replace(
    /for \(const delta of reasoningTagTextPartitioner\.flush\(\)\) if \(delta\.kind === "text"\) appendTextDelta\(delta\.text\);/g,
    'for (const delta of reasoningTagTextPartitioner.flush()) {\n' +
      '        if (delta.kind === "text") appendTextDelta(delta.text);\n' +
      '        else appendThinkingDelta("reasoning_content", delta.text);\n' +
      '      }',
  );

  // Provider transport stream used by the v2026.6.9 gateway. The upstream
  // partitioner already returns tagged content as { kind: "thinking" }, but
  // this helper intentionally forwarded only visible text. Route both kinds
  // through the existing content handler so reasoning respects emitReasoning.
  content = content.replace(
    /const appendPartitionedVisibleDelta = \(delta\) => \{\s*if \(delta\.kind === "text"\) appendFilteredVisibleTextDelta\(delta\.text\);\s*\};/g,
    'const appendPartitionedVisibleDelta = (delta) => {\n' +
      '    appendRoutedContentDelta(delta);\n' +
      '  };',
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
    if (patchFile(filePath)) patched.push(path.relative(runtimeDir, filePath));
  }

  const label = options.label || 'patch-openclaw-content-reasoning-tags';
  if (patched.length > 0) {
    console.log(`[${label}] Patched OpenAI content reasoning tags: ${patched.join(', ')}`);
  } else if (options.verbose) {
    console.log(`[${label}] No OpenAI content reasoning tag patch needed.`);
  }

  return patched;
}

module.exports = { applyPatch };
