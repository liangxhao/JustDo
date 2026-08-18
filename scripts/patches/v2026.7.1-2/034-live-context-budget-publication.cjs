'use strict';

// Capability: publish authoritative contextBudgetStatus while an agent run is still active.
// Target: pristine openclaw@2026.7.1-2, which projects/finalizes the field but lacks live writes.
// Scope: publishes initial pre-prompt and mid-turn tool-result boundaries through native storage.
// Safety: writes are best-effort, reject stale session IDs/status timestamps, and preserve updatedAt.
// Remove when: sessions.list or a runtime API exposes native active-run context budget updates.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUniquePattern, writeIfChanged } = require('./_patch-utils');

const HELPER = 'publishJustDoLiveContextBudgetStatus';

function shouldPublishJustDoLiveContextBudgetStatus(entry, params) {
  if (!entry || typeof entry !== 'object') return false;
  if (params.sessionId && entry.sessionId !== params.sessionId) return false;
  const nextUpdatedAt = Number(params.status?.updatedAt);
  if (!Number.isFinite(nextUpdatedAt)) return false;
  const currentUpdatedAt = Number(entry.contextBudgetStatus?.updatedAt);
  if (Number.isFinite(currentUpdatedAt) && currentUpdatedAt >= nextUpdatedAt) return false;
  return true;
}

function transform(content, filePath) {
  if (content.includes(`async function ${HELPER}(`)) return content;
  let updated = replaceUniquePattern(
    content,
    /async function loadAttemptSessionEntryAfterQuotaMaintenance\(params\) \{/,
    `${shouldPublishJustDoLiveContextBudgetStatus.toString()}\nasync function ${HELPER}(params) {\n\tif (!params.sessionKey || !params.status) return;\n\tconst storePath = resolveStorePath(params.config?.session?.store, { agentId: params.agentId });\n\ttry {\n\t\tawait updateSessionEntry({ storePath, sessionKey: params.sessionKey }, (entry) => {\n\t\t\tif (!shouldPublishJustDoLiveContextBudgetStatus(entry, params)) return null;\n\t\t\treturn { contextBudgetStatus: params.status };\n\t\t}, { skipMaintenance: true, takeCacheOwnership: true });\n\t} catch (error) {\n\t\tlog$2.debug(\`[justdo-context-budget] live publication failed: \${String(error)}\`);\n\t}\n}\nasync function loadAttemptSessionEntryAfterQuotaMaintenance(params) {`,
    `${filePath}: live context publisher`,
  );
  updated = replaceUniquePattern(
    updated,
    /(const request = toMidTurnPrecheckRequest\(precheck\);\n\t\t\t\tlog\$2\.debug\(`\[context-overflow-midturn-precheck\][^\n]+\);)/,
    `$1\n\t\t\t\tvoid params.midTurnPrecheck.onContextBudgetStatus?.(precheck, contextMessages.length);`,
    `${filePath}: mid-turn status notification`,
  );
  updated = replaceUniquePattern(
    updated,
    /(getPrePromptMessageCount: \(\) => prePromptMessageCount,\n\t\t\t\tonMidTurnPrecheck)(\n\t\t\t\} \} : \{\};)/,
    `$1,\n\t\t\t\tonContextBudgetStatus: (result, messageCount) => {\n\t\t\t\t\tconst reserveTokens = settingsManager.getCompactionReserveTokens();\n\t\t\t\t\tvoid ${HELPER}({\n\t\t\t\t\t\tconfig: params.config,\n\t\t\t\t\t\tagentId: sessionAgentId,\n\t\t\t\t\t\tsessionKey: params.sessionKey,\n\t\t\t\t\t\tsessionId: params.sessionId,\n\t\t\t\t\t\tstatus: buildPrePromptContextBudgetStatus({ result, provider: params.provider, modelId: params.modelId, messageCount, contextTokenBudget: contextTokenBudgetForGuard, reserveTokens, ...params.sessionId ? { sessionId: params.sessionId } : {} })\n\t\t\t\t\t});\n\t\t\t\t}$2`,
    `${filePath}: mid-turn publisher callback`,
  );
  updated = replaceUniquePattern(
    updated,
    /(contextBudgetStatus = buildPrePromptContextBudgetStatus\(\{[\s\S]*?\n\t+\}\);)(\n\t+log\$2\.debug\(formatPrePromptPrecheckLog)/,
    `$1\n\t\t\t\t\tvoid ${HELPER}({ config: params.config, agentId: sessionAgentId, sessionKey: params.sessionKey, sessionId: params.sessionId, status: contextBudgetStatus });$2`,
    `${filePath}: initial boundary publication`,
  );
  return updated;
}

function applyPatch(runtimeDir) {
  const files = findFilesContaining(runtimeDir, [
    'async function runEmbeddedAttempt(params)',
    'contextBudgetStatus = buildPrePromptContextBudgetStatus',
    'onMidTurnPrecheck',
  ]).filter(filePath => path.basename(filePath) !== 'gateway-bundle.mjs');
  if (files.length !== 1)
    throw new Error(`live context budget target count is ${files.length}, expected 1`);
  const filePath = files[0];
  const original = fs.readFileSync(filePath, 'utf8');
  const updated = transform(original, filePath);
  return writeIfChanged(filePath, original, updated) ? [path.relative(runtimeDir, filePath)] : [];
}

function verifyPatch(runtimeDir) {
  const files = findFilesContaining(runtimeDir, [`async function ${HELPER}(`]);
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  if (files.length !== expected)
    throw new Error(`live context budget target count is ${files.length}, expected ${expected}`);
  const combined = files.map(filePath => fs.readFileSync(filePath, 'utf8')).join('\n');
  for (const contract of [
    'onContextBudgetStatus?.(precheck, contextMessages.length)',
    'contextBudgetStatus: params.status',
    'status: contextBudgetStatus',
    'takeCacheOwnership: true',
    'entry.sessionId !== params.sessionId',
    'currentUpdatedAt >= nextUpdatedAt',
  ]) {
    if (!combined.includes(contract))
      throw new Error(`live context budget contract is missing: ${contract}`);
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: { shouldPublishJustDoLiveContextBudgetStatus },
};
