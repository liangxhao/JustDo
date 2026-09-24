'use strict';

// Capability: apply JustDo system-prompt replacements to the model-aware final prompt.
// Target: pristine openclaw@2026.9.6, which lacks a final-system-only transformation hook.
// Scope: reads JustDo replacement configuration after hooks/model identity and before dispatch.
// Safety: hook output and the native model-aware/cache-boundary additions are never overwritten.
// Remove when: upstream offers a supported final system prompt hook with equivalent timing.

const fs = require('fs');
const path = require('path');
const {
  assertCurrentPatchContract,
  findFilesContaining,
  isGatewayBundlePath,
  replaceUnique,
  writeIfChanged,
} = require('./_patch-utils.js');

const CONTRACT = 'JUSTDO_FINAL_SYSTEM_PROMPT_REPLACEMENTS_V2026_9_6';
const ATTEMPT_ANCHOR = 'async function prepareEmbeddedAttemptPromptAssembly(input) {';
const FINAL_ANCHOR =
  '\tif (modelAwareSystemPrompt !== systemPromptText) setSystemPrompt(modelAwareSystemPrompt);\n\tconst routingSummary = describeProviderRequestRoutingSummary({';
const FINAL_REPLACEMENT = `\tif (modelAwareSystemPrompt !== systemPromptText) setSystemPrompt(modelAwareSystemPrompt);
\tconst justDoFinalSystemPrompt = applyJustDoFinalSystemPromptReplacements(systemPromptText);
\tif (justDoFinalSystemPrompt !== systemPromptText) setSystemPrompt(justDoFinalSystemPrompt);
\tconst routingSummary = describeProviderRequestRoutingSummary({`;
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


function transform(content, filePath) {
  assertCurrentPatchContract(content, CONTRACT, filePath, false);
  const anchor = 'async function prepareEmbeddedAttemptPromptAssembly(';
  if (content.includes('function applyJustDoFinalSystemPromptReplacements(')) {
    assertCurrentPatchContract(content, CONTRACT, filePath, !isGatewayBundlePath(filePath));
    if (!/const justDoFinalSystemPrompt = applyJustDoFinalSystemPromptReplacements\([\w$]+\);/.test(content) || !content.includes('setSystemPrompt(justDoFinalSystemPrompt)')) throw new Error('Partial final prompt patch');
    return content;
  }
  let next = replaceUnique(content, anchor, HELPER + '\n' + anchor, filePath);
  if (next.includes(FINAL_ANCHOR)) return replaceUnique(next, FINAL_ANCHOR, FINAL_REPLACEMENT, filePath);
  const worker = /([\w$]+)!==([\w$]+)&&setSystemPrompt\(\1\);let ([\w$]+)=describeProviderRequestRoutingSummary\(/g;
  const matches = [...next.matchAll(worker)];
  if (matches.length !== 1) throw new Error('Final prompt worker boundary changed');
  return next.replace(worker, (_m, aware, prompt, routing) =>
    aware + '!==' + prompt + '&&setSystemPrompt(' + aware + ');const justDoFinalSystemPrompt = applyJustDoFinalSystemPromptReplacements(' + prompt + ');if (justDoFinalSystemPrompt !== ' + prompt + ') setSystemPrompt(justDoFinalSystemPrompt);let ' + routing + '=describeProviderRequestRoutingSummary(');
}
function processTargets(runtimeDir, verify) {
  const files = findFilesContaining(runtimeDir, 'async function prepareEmbeddedAttemptPromptAssembly(');
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 4 : 3;
  if (files.length !== expected) throw new Error('Final prompt target count changed');
  return files.flatMap(file => {
    const before = fs.readFileSync(file, 'utf8'), after = transform(before, file);
    if (verify && before !== after) throw new Error('Final prompt patch missing');
    return !verify && writeIfChanged(file, before, after) ? [path.relative(runtimeDir, file)] : [];
  });
}
module.exports = {
  applyPatch: root => processTargets(root, false),
  verifyPatch: root => processTargets(root, true),
  __testing: { CONTRACT, ATTEMPT_ANCHOR, FINAL_ANCHOR, FINAL_REPLACEMENT, HELPER, transform },
};
