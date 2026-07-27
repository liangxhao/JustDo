import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

const { applyPatch } =
  require('../scripts/patches/v2026.6.11/011-trim-runtime-system-prompt.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
  };

const BUNDLE_FIXTURE = `function buildModelIdentityPromptLine(model) {
  const trimmed = model?.trim();
  if (!trimmed) return;
  return \`\${MODEL_IDENTITY_PREFIX} \${trimmed}. If asked what model you are, answer with this value for the current run.\`;
}
function sanitizeContextFileContentForPrompt(content) {
  return content.replaceAll(DEFAULT_HEARTBEAT_PROMPT_CONTEXT_BLOCK, "").replace(/\\n{3,}/g, "\\n\\n");
}
function buildAgentSystemPrompt(params) {
  const modelIdentityLine = buildModelIdentityPromptLine(params.runtimeInfo?.model);
  const reasoningLevel = params.reasoningLevel ?? "off";
  lines.push("## Runtime", buildRuntimeLine(runtimeInfo, runtimeChannel, runtimeCapabilities, params.defaultThinkLevel), ...modelIdentityLine ? [modelIdentityLine] : [], ...buildActiveProcessSessionReferenceLines(runtimeInfo?.activeProcessSessions), \`Reasoning: \${reasoningLevel} (hidden unless on/stream). Toggle /reasoning; /status shows Reasoning when enabled.\`);
}
function buildRuntimeLine(runtimeInfo, runtimeChannel, runtimeCapabilities = [], defaultThinkLevel) {
  const normalizedRuntimeCapabilities = normalizePromptCapabilityIds(runtimeCapabilities);
  return \`Runtime: \${[
    runtimeInfo?.agentId ? \`agent=\${runtimeInfo.agentId}\` : "",
    runtimeInfo?.sessionKey ? \`session=\${sanitizeForPromptLiteral(runtimeInfo.sessionKey)}\` : "",
    runtimeInfo?.sessionId ? \`sessionId=\${sanitizeForPromptLiteral(runtimeInfo.sessionId)}\` : "",
    runtimeInfo?.host ? \`host=\${runtimeInfo.host}\` : "",
    runtimeInfo?.model ? \`model=\${runtimeInfo.model}\` : "",
    runtimeInfo?.defaultModel ? \`default_model=\${runtimeInfo.defaultModel}\` : "",
    runtimeInfo?.shell ? \`shell=\${runtimeInfo.shell}\` : "",
    runtimeChannel ? \`channel=\${runtimeChannel}\` : "",
    runtimeChannel ? \`capabilities=\${normalizedRuntimeCapabilities.length > 0 ? normalizedRuntimeCapabilities.join(",") : "none"}\` : "",
    \`thinking=\${defaultThinkLevel ?? "off"}\`
  ].filter(Boolean).join(" | ")}\`;
}`;

test('removes redundant runtime metadata and guidance from the system prompt', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-runtime-prompt-patch-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(bundlePath, BUNDLE_FIXTURE, 'utf8');

    expect(applyPatch(runtimeDir)).toEqual(['gateway-bundle.mjs']);
    const patched = fs.readFileSync(bundlePath, 'utf8');

    expect(patched).not.toContain('session=${');
    expect(patched).not.toContain('sessionId=${');
    expect(patched).not.toContain('default_model=${');
    expect(patched).not.toContain('channel=${');
    expect(patched).not.toContain('capabilities=${');
    expect(patched).not.toContain('thinking=${');
    expect(patched).not.toContain('Current model identity:');
    expect(patched).not.toContain('Reasoning: ${reasoningLevel}');
    expect(patched).toContain('function buildModelIdentityPromptLine() {\n  return;\n}');
    expect(patched).toContain(
      'return content.replace(/\\r\\n?/g, "\\n").replaceAll(DEFAULT_HEARTBEAT_PROMPT_CONTEXT_BLOCK, "")',
    );
    const sanitizerSource = patched.match(
      /function sanitizeContextFileContentForPrompt\(content\) \{[\s\S]*?\n\}/,
    )?.[0];
    expect(sanitizerSource).toBeDefined();
    const sanitizeContextFileContentForPrompt = new Function(
      'DEFAULT_HEARTBEAT_PROMPT_CONTEXT_BLOCK',
      `${sanitizerSource}; return sanitizeContextFileContentForPrompt;`,
    )('') as (content: string) => string;
    expect(sanitizeContextFileContentForPrompt('first\r\nsecond\rlast')).toBe(
      'first\nsecond\nlast',
    );
    expect(patched).toContain(
      'lines.push("## Runtime", buildRuntimeLine(runtimeInfo, runtimeChannel, runtimeCapabilities, params.defaultThinkLevel), ...buildActiveProcessSessionReferenceLines(runtimeInfo?.activeProcessSessions));',
    );
    expect(applyPatch(runtimeDir)).toEqual([]);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('fails when an upstream runtime prompt patch point changes', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-runtime-prompt-mismatch-'));
  try {
    const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
    fs.writeFileSync(bundlePath, 'function buildRuntimeLine() {}', 'utf8');

    expect(() => applyPatch(runtimeDir)).toThrow(/patch target not found/i);
  } finally {
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
