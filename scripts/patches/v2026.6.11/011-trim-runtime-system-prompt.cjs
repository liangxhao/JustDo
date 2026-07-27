'use strict';

// Purpose: Remove redundant and volatile runtime metadata from the OpenClaw
// system prompt to reduce per-turn token usage and avoid exposing session IDs.
// Affected OpenClaw version: v2026.6.11.
// Risk: Upstream changes to buildAgentSystemPrompt/buildRuntimeLine require this
// patch to be updated.
// Remove when: OpenClaw supports configuring runtime prompt fields.
// Upstream tracking: TODO(openclaw): request configurable runtime prompt fields.
// Temporary: yes.

const fs = require('fs');
const path = require('path');

const ORIGINAL_RUNTIME_SUFFIX =
  ', ...modelIdentityLine ? [modelIdentityLine] : [], ...buildActiveProcessSessionReferenceLines(runtimeInfo?.activeProcessSessions), `Reasoning: ${reasoningLevel} (hidden unless on/stream). Toggle /reasoning; /status shows Reasoning when enabled.`';
const PATCHED_RUNTIME_SUFFIX =
  ', ...buildActiveProcessSessionReferenceLines(runtimeInfo?.activeProcessSessions)';

const ORIGINAL_MODEL_IDENTITY_BUILDER = `function buildModelIdentityPromptLine(model) {
  const trimmed = model?.trim();
  if (!trimmed) return;
  return \`\${MODEL_IDENTITY_PREFIX} \${trimmed}. If asked what model you are, answer with this value for the current run.\`;
}`;
const PATCHED_MODEL_IDENTITY_BUILDER = `function buildModelIdentityPromptLine() {
  return;
}`;

const ORIGINAL_CONTEXT_SANITIZER = `function sanitizeContextFileContentForPrompt(content) {
  return content.replaceAll(DEFAULT_HEARTBEAT_PROMPT_CONTEXT_BLOCK, "").replace(/\\n{3,}/g, "\\n\\n");
}`;
const PATCHED_CONTEXT_SANITIZER = `function sanitizeContextFileContentForPrompt(content) {
  return content.replace(/\\r\\n?/g, "\\n").replaceAll(DEFAULT_HEARTBEAT_PROMPT_CONTEXT_BLOCK, "").replace(/\\n{3,}/g, "\\n\\n");
}`;

const REMOVED_RUNTIME_LINES = [
  '  const normalizedRuntimeCapabilities = normalizePromptCapabilityIds(runtimeCapabilities);\n',
  '    runtimeInfo?.sessionKey ? `session=${sanitizeForPromptLiteral(runtimeInfo.sessionKey)}` : "",\n',
  '    runtimeInfo?.sessionId ? `sessionId=${sanitizeForPromptLiteral(runtimeInfo.sessionId)}` : "",\n',
  '    runtimeInfo?.defaultModel ? `default_model=${runtimeInfo.defaultModel}` : "",\n',
  '    runtimeChannel ? `channel=${runtimeChannel}` : "",\n',
  '    runtimeChannel ? `capabilities=${normalizedRuntimeCapabilities.length > 0 ? normalizedRuntimeCapabilities.join(",") : "none"}` : "",\n',
  '    `thinking=${defaultThinkLevel ?? "off"}`\n',
];

function replaceExactlyOnce(content, original, replacement, description, filePath) {
  const firstIndex = content.indexOf(original);
  if (firstIndex === -1) {
    throw new Error(`OpenClaw ${description} patch target not found: ${filePath}`);
  }
  if (content.indexOf(original, firstIndex + original.length) !== -1) {
    throw new Error(`OpenClaw ${description} patch target is ambiguous: ${filePath}`);
  }
  return content.replace(original, replacement);
}

function patchFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  const alreadyPatched =
    content.includes(PATCHED_RUNTIME_SUFFIX) &&
    !content.includes(ORIGINAL_RUNTIME_SUFFIX) &&
    content.includes(PATCHED_MODEL_IDENTITY_BUILDER) &&
    !content.includes(ORIGINAL_MODEL_IDENTITY_BUILDER) &&
    content.includes(PATCHED_CONTEXT_SANITIZER) &&
    !content.includes(ORIGINAL_CONTEXT_SANITIZER) &&
    REMOVED_RUNTIME_LINES.every(line => !content.includes(line));
  if (alreadyPatched) return false;

  if (content.includes(ORIGINAL_RUNTIME_SUFFIX)) {
    content = replaceExactlyOnce(
      content,
      ORIGINAL_RUNTIME_SUFFIX,
      PATCHED_RUNTIME_SUFFIX,
      'runtime prompt suffix',
      filePath,
    );
  } else if (!content.includes(PATCHED_RUNTIME_SUFFIX)) {
    throw new Error(`OpenClaw runtime prompt suffix patch target not found: ${filePath}`);
  }

  if (content.includes(ORIGINAL_MODEL_IDENTITY_BUILDER)) {
    content = replaceExactlyOnce(
      content,
      ORIGINAL_MODEL_IDENTITY_BUILDER,
      PATCHED_MODEL_IDENTITY_BUILDER,
      'model identity prompt',
      filePath,
    );
  } else if (!content.includes(PATCHED_MODEL_IDENTITY_BUILDER)) {
    throw new Error(`OpenClaw model identity prompt patch target not found: ${filePath}`);
  }

  if (content.includes(ORIGINAL_CONTEXT_SANITIZER)) {
    content = replaceExactlyOnce(
      content,
      ORIGINAL_CONTEXT_SANITIZER,
      PATCHED_CONTEXT_SANITIZER,
      'context file line ending normalization',
      filePath,
    );
  } else if (!content.includes(PATCHED_CONTEXT_SANITIZER)) {
    throw new Error(
      `OpenClaw context file line ending normalization patch target not found: ${filePath}`,
    );
  }

  for (const line of REMOVED_RUNTIME_LINES) {
    if (content.includes(line)) {
      content = replaceExactlyOnce(content, line, '', 'runtime metadata', filePath);
    }
  }

  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function applyPatch(runtimeDir, options = {}) {
  const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  const label = options.label || 'patch-openclaw-trim-runtime-system-prompt';
  if (!fs.existsSync(bundlePath)) {
    if (options.verbose) {
      console.log(`[${label}] Gateway bundle not generated yet; deferring prompt patch.`);
    }
    return [];
  }

  const patched = patchFile(bundlePath) ? ['gateway-bundle.mjs'] : [];
  if (patched.length > 0) {
    console.log(`[${label}] Trimmed redundant runtime system prompt metadata.`);
  } else if (options.verbose) {
    console.log(`[${label}] Runtime system prompt metadata already trimmed.`);
  }
  return patched;
}

module.exports = { applyPatch, REMOVED_RUNTIME_LINES };
