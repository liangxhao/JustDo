'use strict';

// Capability: apply JustDo system-prompt replacements to the model-aware final prompt.
// Target: pristine openclaw@2026.8.1, which lacks a final-system-only transformation hook.
// Scope: reads JustDo replacement configuration after hooks/model identity and before dispatch.
// Safety: hook output and the native model-aware/cache-boundary additions are never overwritten.
// Remove when: upstream offers a supported final system prompt hook with equivalent timing.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUnique, writeIfChanged } = require('./_patch-utils.js');

const CONTRACT = 'JUSTDO_FINAL_SYSTEM_PROMPT_REPLACEMENTS_V2026_8_1';
const ATTEMPT_ANCHOR = 'async function prepareEmbeddedAttemptPromptAssembly(input) {';
const FINAL_ANCHOR =
  '\tif (modelAwareSystemPrompt !== systemPromptText) setSystemPrompt(modelAwareSystemPrompt);\n\tlet promptCacheChangesForTurn = null;';
const FINAL_REPLACEMENT = `\tif (modelAwareSystemPrompt !== systemPromptText) setSystemPrompt(modelAwareSystemPrompt);
\tconst justDoFinalSystemPrompt = applyJustDoFinalSystemPromptReplacements(systemPromptText);
\tif (justDoFinalSystemPrompt !== systemPromptText) setSystemPrompt(justDoFinalSystemPrompt);
\tlet promptCacheChangesForTurn = null;`;
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
  const files = findFilesContaining(runtimeDir, [
    ATTEMPT_ANCHOR,
    'const modelAwareSystemPrompt = isSettledTurnFinalization',
  ]);
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  if (files.length !== expected)
    throw new Error(`final system prompt target count is ${files.length}, expected ${expected}`);
  return files.flatMap(filePath => {
    const original = fs.readFileSync(filePath, 'utf8');
    let updated = original;
    const hasHelper = updated.includes('function applyJustDoFinalSystemPromptReplacements(');
    const hasRuleLoader = updated.includes('function loadJustDoFinalSystemPromptRules(');
    if (!hasHelper && !hasRuleLoader) {
      updated = replaceUnique(
        updated,
        ATTEMPT_ANCHOR,
        `${HELPER}\n${ATTEMPT_ANCHOR}`,
        'final system prompt helper',
      );
    } else if (!hasHelper || !hasRuleLoader) {
      throw new Error(`historical or partial final system prompt helper: ${filePath}`);
    }
    if (updated.includes(FINAL_ANCHOR)) {
      updated = replaceUnique(
        updated,
        FINAL_ANCHOR,
        FINAL_REPLACEMENT,
        'final system prompt application',
      );
    } else if (
      !updated.includes(
        'const justDoFinalSystemPrompt = applyJustDoFinalSystemPromptReplacements(systemPromptText);',
      )
    ) {
      throw new Error(`final system prompt control-flow shape is unknown: ${filePath}`);
    }
    return writeIfChanged(filePath, original, updated) ? [path.relative(runtimeDir, filePath)] : [];
  });
}

function verifyPatch(runtimeDir) {
  const files = findFilesContaining(runtimeDir, ATTEMPT_ANCHOR);
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  if (files.length !== expected) throw new Error('patched final system prompt targets are missing');
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const required of [
      'function applyJustDoFinalSystemPromptReplacements(',
      'function loadJustDoFinalSystemPromptRules(',
      'const justDoFinalSystemPrompt = applyJustDoFinalSystemPromptReplacements(systemPromptText);',
      'if (justDoFinalSystemPrompt !== systemPromptText) setSystemPrompt(justDoFinalSystemPrompt);',
    ]) {
      if (!content.includes(required))
        throw new Error(`missing final system prompt contract in ${filePath}: ${required}`);
    }
    if (!/[A-Za-z_$][\w$]*\.expression\.lastIndex\s*=\s*0;/.test(content))
      throw new Error(`final system prompt rules do not reset RegExp.lastIndex: ${filePath}`);
    if (
      (content.match(/function applyJustDoFinalSystemPromptReplacements\(/g) ?? []).length !== 1 ||
      (content.match(/function loadJustDoFinalSystemPromptRules\(/g) ?? []).length !== 1
    ) {
      throw new Error(`final system prompt helper is duplicated or ambiguous: ${filePath}`);
    }
    const modelAwareIndex = content.indexOf(
      'const modelAwareSystemPrompt = isSettledTurnFinalization',
    );
    const replacementIndex = content.indexOf('const justDoFinalSystemPrompt', modelAwareIndex);
    const cacheObservationIndex = content.indexOf(
      'if (input.cache.observabilityEnabled)',
      replacementIndex,
    );
    if (
      modelAwareIndex < 0 ||
      replacementIndex < modelAwareIndex ||
      cacheObservationIndex < replacementIndex
    ) {
      throw new Error(
        `final system prompt replacement is outside the dispatch boundary: ${filePath}`,
      );
    }
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: { CONTRACT, ATTEMPT_ANCHOR, FINAL_ANCHOR, FINAL_REPLACEMENT, HELPER },
};
