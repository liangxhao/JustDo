'use strict';

// Purpose: Keep reasoning stream enabled for Gateway agent runs, including
// subagent completion announce runs. The upstream agent-command path resolves
// thinking level but does not pass a reasoning level into embedded PI, so
// announce turns fall back to reasoningMode="off" even when the agent config
// has reasoningDefault="stream".
// Affected OpenClaw version: v2026.6.9.
// Risk: Makes agent-command runs honor session/agent reasoning visibility
// defaults instead of silently hiding reasoning.
// Remove when: OpenClaw threads reasoningDefault/reasoningLevel through the
// Gateway agent command runtime natively.
// Upstream tracking: TODO(openclaw): file issue/PR with announce reasoning
// stream reproduction.
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
  if (!fs.existsSync(filePath)) return false;

  let content = fs.readFileSync(filePath, 'utf8');
  const original = content;

  // 1. Insert resolvedReasoningLevel after resolvedThinkLevel declaration
  content = content.replace(
    /(let resolvedThinkLevel = thinkOnce \?\? thinkOverride \?\? persistedThinking;\n)(\s*)(const resolvedVerboseLevel = verboseOverride \?\? persistedVerbose \?\? agentCfg\?\.verboseDefault;)/g,
    '$1$2const resolvedReasoningLevel = sessionEntry?.reasoningLevel ?? cfg.agents?.list?.find((entry) => entry?.id === sessionAgentId)?.reasoningDefault ?? agentCfg?.reasoningDefault ?? "off";\n$2$3',
  );

  // 2. Add resolvedReasoningLevel to the spread arguments (after resolvedThinkLevel)
  content = content.replace(
    /(resolvedThinkLevel,\n)(\s*)(fastMode: resolveFastModeState\(\{)/g,
    '$1$2resolvedReasoningLevel,\n$2$3',
  );

  // 3. Add reasoningLevel to the object literal (after thinkLevel)
  //    In v2026.6.9, thinkLevel is followed by extraSystemPrompt, not fastMode
  content = content.replace(
    /(thinkLevel: resolvedThinkLevel,\n)(\s*)(extraSystemPrompt:)/g,
    '$1$2reasoningLevel: params.resolvedReasoningLevel,\n$2$3',
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

  const label = options.label || 'patch-openclaw-agent-announce-reasoning-stream';
  if (patched.length > 0) {
    console.log('[' + label + '] Patched agent announce reasoning stream: ' + patched.join(', '));
  } else if (options.verbose) {
    console.log('[' + label + '] No agent announce reasoning stream patch needed.');
  }

  return patched;
}

module.exports = { applyPatch };
