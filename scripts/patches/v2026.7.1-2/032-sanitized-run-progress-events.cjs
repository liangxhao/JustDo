'use strict';

// Capability: publish four sanitized run-progress stages consumed by the JustDo UI.
// Target: pristine openclaw@2026.7.1-2, which has execution callbacks but no stable UI projection.
// Scope: only session trees rooted at agent:*:justdo:* emit queued/preparing/waiting_model/retrying.
// Safety: ancestry is persisted, cycle/depth bounded and fail-closed; event details are bounded scalar allow-listed.
// Remove when: upstream publishes an equivalent stable and sanitized progress contract.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUniquePattern, writeIfChanged } = require('./_patch-utils.js');

function isJustDoRunProgressSession(params) {
  const initial = typeof params?.sessionKey === 'string' ? params.sessionKey.trim() : '';
  let current = initial;
  const visited = new Set();
  for (let depth = 0; current && depth < 32; depth += 1) {
    if (visited.has(current)) return false;
    visited.add(current);
    const entry = current === initial ? params.sessionEntry : params.sessionStore?.[current];
    const parents = new Set();
    if (current === initial && typeof params.spawnedBy === 'string' && params.spawnedBy.trim())
      parents.add(params.spawnedBy.trim());
    if (typeof entry?.spawnedBy === 'string' && entry.spawnedBy.trim())
      parents.add(entry.spawnedBy.trim());
    if (parents.size > 1) return false;
    const parent = parents.values().next().value ?? '';
    if (!parent) return /^agent:[^:]+:justdo:[^:]+$/i.test(current);
    current = parent;
  }
  return false;
}

const MANAGED_PROGRESS_HELPER = isJustDoRunProgressSession.toString();

function transform(content, filePath) {
  if (content.includes('const emitJustDoRunProgress =')) return content;
  let updated = replaceUniquePattern(
    content,
    /function runAgentAttempt\(params\) \{\s*const isRawModelRun =/,
    `function runAgentAttempt(params) {
  ${MANAGED_PROGRESS_HELPER}
  const shouldEmitJustDoRunProgress = isJustDoRunProgressSession(params);
  const emitJustDoRunProgress = (stage, details = {}) => {
    if (!shouldEmitJustDoRunProgress) return;
    const provider = typeof details.provider === "string" && details.provider ? details.provider.slice(0, 128) : void 0;
    const model = typeof details.model === "string" && details.model ? details.model.slice(0, 128) : void 0;
    emitAgentEvent({
      runId: params.runId,
      ...params.sessionKey ? { sessionKey: params.sessionKey } : {},
      ...params.lifecycleGeneration ? { lifecycleGeneration: params.lifecycleGeneration } : {},
      stream: "lifecycle",
      data: {
        phase: "progress",
        stage,
        at: Date.now(),
        ...provider ? { provider } : {},
        ...model ? { model } : {}
      }
    });
  };
  const handleJustDoExecutionPhase = (info) => {
    if (info.phase === "attempt_dispatch" || info.phase === "process_spawned") {
      emitJustDoRunProgress("waiting_model", info);
    } else if (["runner_entered", "workspace", "runtime_plugins", "before_agent_reply", "model_resolution", "auth", "context_engine"].includes(info.phase)) {
      emitJustDoRunProgress("preparing", info);
    }
  };
  if (params.isFallbackRetry) emitJustDoRunProgress("retrying", {
    provider: params.providerOverride,
    model: params.modelOverride
  });
  const isRawModelRun =`,
    `${filePath}: progress emitter`,
  );
  updated = replaceUniquePattern(
    updated,
    /(toolsAllow: params\.opts\.toolsAllow,\s*)(cleanupBundleMcpOnRunEnd: params\.opts\.cleanupBundleMcpOnRunEnd,)/,
    '$1onExecutionPhase: handleJustDoExecutionPhase,\n      $2',
    `${filePath}: CLI progress phases`,
  );
  updated = replaceUniquePattern(
    updated,
    /(disableTools: params\.opts\.modelRun === true,\s*)(onAgentEvent: params\.onAgentEvent,)/,
    `$1onExecutionPhase: handleJustDoExecutionPhase,
    onLaneWait: (info) => {
      if (info.waiting) emitJustDoRunProgress("queued", {
        provider: embeddedAgentProvider,
        model: params.modelOverride
      });
    },
    $2`,
    `${filePath}: embedded progress phases`,
  );
  return updated;
}

function applyPatch(runtimeDir) {
  const files = findFilesContaining(runtimeDir, [
    'function runAgentAttempt(params)',
    'disableTools: params.opts.modelRun === true',
    'cleanupBundleMcpOnRunEnd: params.opts.cleanupBundleMcpOnRunEnd',
  ]);
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  if (files.length !== expected)
    throw new Error(`run progress target count is ${files.length}, expected ${expected}`);
  const staged = files.map(filePath => {
    const original = fs.readFileSync(filePath, 'utf8');
    return { filePath, original, updated: transform(original, filePath) };
  });
  return staged
    .filter(item => writeIfChanged(item.filePath, item.original, item.updated))
    .map(item => path.relative(runtimeDir, item.filePath));
}

function verifyPatch(runtimeDir) {
  const files = findFilesContaining(runtimeDir, ['const emitJustDoRunProgress =']);
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  if (files.length !== expected) throw new Error('run progress targets are incomplete');
  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const contract of [
      'const shouldEmitJustDoRunProgress = isJustDoRunProgressSession(params);',
      'if (!shouldEmitJustDoRunProgress) return;',
      'depth < 32',
      'details.provider.slice(0, 128)',
      'details.model.slice(0, 128)',
      'phase: "progress"',
      'emitJustDoRunProgress("queued"',
      'emitJustDoRunProgress("preparing"',
      'emitJustDoRunProgress("waiting_model"',
      'emitJustDoRunProgress("retrying"',
      'onExecutionPhase: handleJustDoExecutionPhase',
    ]) {
      if (!content.includes(contract))
        throw new Error(`${filePath}: missing progress contract ${contract}`);
    }
  }
}

module.exports = {
  applyPatch,
  transform,
  verifyPatch,
  __testing: { isJustDoRunProgressSession },
};
