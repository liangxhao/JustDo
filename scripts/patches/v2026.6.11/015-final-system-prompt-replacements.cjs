'use strict';

// Purpose: Apply JustDo-managed ordered regex replacements to the final
// system prompt after prompt hooks and before cache/preflight/model submission.
// Affected OpenClaw version: v2026.6.11.
// Risk: Invalid or overly broad trusted-local regex rules can remove important
// agent instructions; pathological expressions can consume excessive CPU.
// Remove when: OpenClaw exposes a final, system-only prompt transform hook.
// Upstream tracking: TODO(openclaw): request a final system-only prompt hook.
// Temporary: yes.

const fs = require('fs');
const path = require('path');

const HELPER_MARKER = 'JUSTDO_FINAL_SYSTEM_PROMPT_REPLACEMENTS';
const LIVE_CONTEXT_PUBLISHER_ANCHOR =
  'async function persistJustDoLiveContextBudgetStatus(params) {';
const ORIGINAL_FINALIZATION = '          const systemPromptForHook = systemPromptText;';
const PATCHED_FINALIZATION = `          const transformedSystemPromptText = applyJustDoFinalSystemPromptReplacements(systemPromptText);
          if (transformedSystemPromptText !== systemPromptText) {
            setActiveSessionSystemPrompt(transformedSystemPromptText);
          }
          const systemPromptForHook = systemPromptText;`;
const PREVIOUS_RULE_APPLICATION = `  for (const rule of loadJustDoSystemPromptReplacementRules()) {
    transformed = transformed.replace(rule.expression, rule.replacement);
  }`;
const RULE_APPLICATION = `  for (const rule of loadJustDoSystemPromptReplacementRules()) {
    rule.expression.lastIndex = 0;
    transformed = transformed.replace(rule.expression, rule.replacement);
  }`;

const HELPER_SOURCE = `// ${HELPER_MARKER}
let justDoSystemPromptReplacementCache = {
  filePath: "",
  stamp: "",
  rules: []
};
function loadJustDoSystemPromptReplacementRules() {
  const filePath = process.env.JUSTDO_SYSTEM_PROMPT_REPLACEMENTS_PATH?.trim() ?? "";
  if (!filePath) return [];
  try {
    const fsModule = process.getBuiltinModule("node:fs");
    const stat = fsModule.statSync(filePath);
    const stamp = \`\${stat.mtimeMs}:\${stat.ctimeMs}:\${stat.size}\`;
    if (
      justDoSystemPromptReplacementCache.filePath === filePath &&
      justDoSystemPromptReplacementCache.stamp === stamp
    ) {
      return justDoSystemPromptReplacementCache.rules;
    }
    const parsed = JSON.parse(fsModule.readFileSync(filePath, "utf8"));
    if (!Array.isArray(parsed)) throw new TypeError("rules must be an array");
    const rules = parsed.flatMap((rule) => {
      if (
        !rule ||
        typeof rule !== "object" ||
        rule.enabled === false ||
        typeof rule.pattern !== "string" ||
        !rule.pattern ||
        typeof rule.replacement !== "string"
      ) {
        return [];
      }
      try {
        return [{
          expression: new RegExp(rule.pattern, typeof rule.flags === "string" ? rule.flags : "g"),
          replacement: rule.replacement
        }];
      } catch (error) {
        console.warn(\`[JustDoSystemPrompt] Ignoring invalid replacement rule \${String(rule.id ?? "unknown")}: \${String(error)}\`);
        return [];
      }
    });
    justDoSystemPromptReplacementCache = { filePath, stamp, rules };
    return rules;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn(\`[JustDoSystemPrompt] Failed to load replacement rules: \${String(error)}\`);
    }
    justDoSystemPromptReplacementCache = { filePath, stamp: "", rules: [] };
    return [];
  }
}
function applyJustDoFinalSystemPromptReplacements(systemPrompt) {
  if (typeof systemPrompt !== "string" || !systemPrompt) return systemPrompt;
  let transformed = systemPrompt;
  for (const rule of loadJustDoSystemPromptReplacementRules()) {
    rule.expression.lastIndex = 0;
    transformed = transformed.replace(rule.expression, rule.replacement);
  }
  return transformed;
}
`;

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
    content.includes(HELPER_MARKER) &&
    content.includes(PATCHED_FINALIZATION) &&
    content.includes(RULE_APPLICATION);
  if (alreadyPatched) return false;

  if (!content.includes(HELPER_MARKER)) {
    content = replaceExactlyOnce(
      content,
      LIVE_CONTEXT_PUBLISHER_ANCHOR,
      `${HELPER_SOURCE}\n${LIVE_CONTEXT_PUBLISHER_ANCHOR}`,
      'final system prompt helper anchor',
      filePath,
    );
  } else if (!content.includes(RULE_APPLICATION)) {
    content = replaceExactlyOnce(
      content,
      PREVIOUS_RULE_APPLICATION,
      RULE_APPLICATION,
      'final system prompt rule application',
      filePath,
    );
  }
  if (!content.includes(PATCHED_FINALIZATION)) {
    content = replaceExactlyOnce(
      content,
      ORIGINAL_FINALIZATION,
      PATCHED_FINALIZATION,
      'final system prompt replacement',
      filePath,
    );
  }
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function applyPatch(runtimeDir, options = {}) {
  const bundlePath = path.join(runtimeDir, 'gateway-bundle.mjs');
  const label = options.label || 'patch-openclaw-final-system-prompt-replacements';
  if (!fs.existsSync(bundlePath)) {
    if (options.verbose) {
      console.log(`[${label}] Gateway bundle not generated yet; deferring prompt patch.`);
    }
    return [];
  }

  const patched = patchFile(bundlePath) ? ['gateway-bundle.mjs'] : [];
  if (patched.length > 0) {
    console.log(`[${label}] Added final system prompt replacement support.`);
  } else if (options.verbose) {
    console.log(`[${label}] Final system prompt replacement support already applied.`);
  }
  return patched;
}

module.exports = { applyPatch };
