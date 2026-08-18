'use strict';

// Capability: apply JustDo system-prompt replacements to the model-aware final prompt.
// Target: pristine openclaw@2026.7.1-2, which lacks a final-system-only transformation hook.
// Scope: reads JustDo replacement configuration after hooks/model identity and before dispatch.
// Safety: hook output and the native model-aware/cache-boundary additions are never overwritten.
// Remove when: upstream offers a supported final system prompt hook with equivalent timing.

const fs = require('fs');
const path = require('path');
const { replaceUnique, writeIfChanged } = require('./_patch-utils.js');

const CONTRACT = 'JUSTDO_FINAL_SYSTEM_PROMPT_REPLACEMENTS_2026_7_1';
const ATTEMPT_ANCHOR = 'async function runEmbeddedAttempt(params) {';
const FINAL_ANCHOR =
  'if (modelAwareSystemPrompt !== systemPromptText) setActiveSessionSystemPrompt(modelAwareSystemPrompt);\n        if (cacheObservabilityEnabled) {';
const FINAL_REPLACEMENT = `if (modelAwareSystemPrompt !== systemPromptText) setActiveSessionSystemPrompt(modelAwareSystemPrompt);
        const justDoFinalSystemPrompt = applyJustDoFinalSystemPromptReplacements(modelAwareSystemPrompt);
        if (justDoFinalSystemPrompt !== modelAwareSystemPrompt) setActiveSessionSystemPrompt(justDoFinalSystemPrompt);
        if (cacheObservabilityEnabled) {`;
const HELPER = `// ${CONTRACT}
let justDoPromptRuleCache = { path: "", signature: "", rules: [] };
function loadJustDoFinalSystemPromptRules() {
  const filePath = process.env.JUSTDO_SYSTEM_PROMPT_REPLACEMENTS_PATH?.trim() ?? "";
  if (!filePath) return [];
  try {
    const fsModule = process.getBuiltinModule("node:fs");
    const stat = fsModule.statSync(filePath);
    const signature = \`${'${'}stat.mtimeMs}:${'${'}stat.ctimeMs}:${'${'}stat.size}\`;
    if (justDoPromptRuleCache.path === filePath && justDoPromptRuleCache.signature === signature) return justDoPromptRuleCache.rules;
    const source = JSON.parse(fsModule.readFileSync(filePath, "utf8"));
    if (!Array.isArray(source)) throw new TypeError("replacement rules must be an array");
    const rules = source.flatMap((rule) => {
      if (!rule || typeof rule !== "object" || rule.enabled === false || typeof rule.pattern !== "string" || !rule.pattern || typeof rule.replacement !== "string") return [];
      try { return [{ expression: new RegExp(rule.pattern, typeof rule.flags === "string" ? rule.flags : "g"), replacement: rule.replacement }]; }
      catch (error) { console.warn(\`[JustDoSystemPrompt] Ignoring invalid rule ${'${'}String(rule.id ?? "unknown")}: ${'${'}String(error)}\`); return []; }
    });
    justDoPromptRuleCache = { path: filePath, signature, rules };
    return rules;
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn(\`[JustDoSystemPrompt] Failed to load rules: ${'${'}String(error)}\`);
    justDoPromptRuleCache = { path: filePath, signature: "", rules: [] };
    return [];
  }
}
function applyJustDoFinalSystemPromptReplacements(systemPrompt) {
  if (typeof systemPrompt !== "string" || systemPrompt.length === 0) return systemPrompt;
  let result = systemPrompt;
  for (const rule of loadJustDoFinalSystemPromptRules()) {
    rule.expression.lastIndex = 0;
    result = result.replace(rule.expression, rule.replacement);
  }
  return result;
}
`;

function applyPatch(runtimeDir) {
  const filePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  if (!fs.existsSync(filePath)) return [];
  const original = fs.readFileSync(filePath, 'utf8');
  let updated = original;
  if (!updated.includes(CONTRACT))
    updated = replaceUnique(
      updated,
      ATTEMPT_ANCHOR,
      `${HELPER}\n${ATTEMPT_ANCHOR}`,
      'final system prompt helper',
    );
  if (updated.includes(FINAL_ANCHOR))
    updated = replaceUnique(
      updated,
      FINAL_ANCHOR,
      FINAL_REPLACEMENT,
      'final system prompt application',
    );
  else if (
    !updated.includes(
      'const justDoFinalSystemPrompt = applyJustDoFinalSystemPromptReplacements(modelAwareSystemPrompt);',
    )
  )
    throw new Error('final system prompt control-flow shape is unknown');
  return writeIfChanged(filePath, original, updated) ? ['gateway-bundle.mjs'] : [];
}

function verifyPatch(runtimeDir) {
  const content = fs.readFileSync(path.join(runtimeDir, 'gateway-bundle.mjs'), 'utf8');
  for (const required of [
    CONTRACT,
    'rule.expression.lastIndex = 0;',
    'const justDoFinalSystemPrompt = applyJustDoFinalSystemPromptReplacements(modelAwareSystemPrompt);',
    'if (justDoFinalSystemPrompt !== modelAwareSystemPrompt) setActiveSessionSystemPrompt(justDoFinalSystemPrompt);',
  ]) {
    if (!content.includes(required))
      throw new Error(`missing final system prompt contract: ${required}`);
  }
  if (content.includes('applyJustDoFinalSystemPromptReplacements(systemPromptText)'))
    throw new Error('final system prompt replacement bypasses model-aware prompt construction');
  const modelAwareIndex = content.indexOf(
    'const modelAwareSystemPrompt = appendModelIdentitySystemPrompt',
  );
  const replacementIndex = content.indexOf('const justDoFinalSystemPrompt');
  const cacheObservationIndex = content.indexOf('if (cacheObservabilityEnabled)', replacementIndex);
  if (
    modelAwareIndex < 0 ||
    replacementIndex < modelAwareIndex ||
    cacheObservationIndex < replacementIndex
  )
    throw new Error('final system prompt replacement is outside the model-aware dispatch boundary');
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: { CONTRACT, ATTEMPT_ANCHOR, FINAL_ANCHOR, FINAL_REPLACEMENT, HELPER },
};
