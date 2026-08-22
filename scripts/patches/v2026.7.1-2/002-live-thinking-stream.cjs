'use strict';

// Capability: keep live Thinking enabled for every visible Gateway agent run,
// including subagent completion announce turns.
// Target: pristine openclaw@2026.7.1-2, whose streamReasoning state is callback-gated
// and whose direct agent-command path drops the session/agent reasoning preference.
// Scope: removes only the optional callback eligibility term and forwards the
// already-configured reasoning level through direct embedded-agent execution.
// Safety: model thinking effort remains independently gated by thinkLevel; the
// callback invocation guard and all native reasoning visibility choices remain intact.
// Remove when: upstream direct agent execution resolves/forwards reasoningLevel and
// reasoning event publication no longer depends on callback presence.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUniquePattern, writeIfChanged } = require('./_patch-utils.js');

const TARGET_CONTEXT = 'function subscribeEmbeddedAgentSession(params) {';
const AGENT_COMMAND_CONTEXT =
  'const requestedThinkLevel = thinkOnce ?? thinkOverride ?? persistedThinking;';
const ATTEMPT_EXECUTION_CONTEXT = 'function runAgentAttempt(params) {';
const PRISTINE_PATTERN =
  /streamReasoning:\s*\(params\.streamReasoningInNonStreamModes === true \? reasoningMode !== "on" : reasoningMode === "stream"\) && canShowReasoning && typeof params\.onReasoningStream === "function",/g;
const PATCHED_PATTERN =
  /streamReasoning:\s*\(params\.streamReasoningInNonStreamModes === true \? reasoningMode !== "on" : reasoningMode === "stream"\) && canShowReasoning,/g;
const CALLBACK_GUARD_PATTERN =
  /\bstate(?:\d+)?\.streamReasoning\s*&&[^\n]{0,240}\bparams\.onReasoningStream\b[^\n]{0,80}\bparams\.onReasoningStream\s*\(/g;
const PRISTINE_REASONING_RESOLUTION_PATTERN =
  /(const requestedThinkLevel = thinkOnce \?\? thinkOverride \?\? persistedThinking;\r?\n)(\s*)(const resolvedVerboseLevel =)/g;
const PATCHED_REASONING_RESOLUTION_PATTERN =
  /const resolvedReasoningLevel = sessionEntry\?\.reasoningLevel \?\? resolveAgentConfig\(cfg, sessionAgentId\)\?\.reasoningDefault \?\? agentCfg\?\.reasoningDefault \?\? "off";/g;
const PRISTINE_REASONING_FORWARD_PATTERN =
  /(resolvedThinkLevel: candidateThinkLevel,\r?\n)(\s*)(fastMode,)/g;
const PATCHED_REASONING_FORWARD_PATTERN =
  /resolvedThinkLevel: candidateThinkLevel,\r?\n\s*resolvedReasoningLevel,\r?\n\s*fastMode,/g;
const PRISTINE_EMBEDDED_REASONING_PATTERN =
  /(return runEmbeddedAgent\(\{[\s\S]{0,8000}?thinkLevel: params\.resolvedThinkLevel,\r?\n)(\s*)(fastMode: params\.fastMode,)/g;
const PATCHED_EMBEDDED_REASONING_PATTERN =
  /thinkLevel: params\.resolvedThinkLevel,\r?\n\s*reasoningLevel: params\.resolvedReasoningLevel,\r?\n\s*fastMode: params\.fastMode,/g;

function countPattern(content, pattern) {
  pattern.lastIndex = 0;
  return [...content.matchAll(pattern)].length;
}

function locateTargets(runtimeDir) {
  return findFilesContaining(runtimeDir, [TARGET_CONTEXT, 'streamReasoning:']);
}

function locateAgentCommandTargets(runtimeDir) {
  return findFilesContaining(runtimeDir, [AGENT_COMMAND_CONTEXT, 'resolvedThinkLevel:']);
}

function locateAttemptExecutionTargets(runtimeDir) {
  return findFilesContaining(runtimeDir, [ATTEMPT_EXECUTION_CONTEXT, 'return runEmbeddedAgent({']);
}

function assertTargetCount(label, targets, expected) {
  if (targets.length !== expected) {
    throw new Error(`${label} target count ${targets.length}, expected ${expected}`);
  }
}

function stageFile(staged, filePath, transform) {
  const existing = staged.get(filePath);
  const original = existing?.original ?? fs.readFileSync(filePath, 'utf8');
  const current = existing?.updated ?? original;
  staged.set(filePath, { original, updated: transform(current) });
}

function applyPatch(runtimeDir) {
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  const targets = locateTargets(runtimeDir);
  const agentCommandTargets = locateAgentCommandTargets(runtimeDir);
  const attemptExecutionTargets = locateAttemptExecutionTargets(runtimeDir);
  assertTargetCount('reasoning stream', targets, expected);
  assertTargetCount('direct agent reasoning resolution', agentCommandTargets, expected);
  assertTargetCount('embedded reasoning forwarding', attemptExecutionTargets, expected);

  const staged = new Map();
  for (const filePath of targets) {
    stageFile(staged, filePath, content => {
      const pristineCount = countPattern(content, PRISTINE_PATTERN);
      const patchedCount = countPattern(content, PATCHED_PATTERN);
      if (pristineCount === 0 && patchedCount === 1) return content;
      if (pristineCount !== 1 || patchedCount !== 0) {
        throw new Error(
          `${filePath}: reasoning eligibility is neither pristine nor completely patched ` +
            `(pristine=${pristineCount}, patched=${patchedCount})`,
        );
      }
      return replaceUniquePattern(
        content,
        PRISTINE_PATTERN,
        'streamReasoning: (params.streamReasoningInNonStreamModes === true ? reasoningMode !== "on" : reasoningMode === "stream") && canShowReasoning,',
        `${filePath}: callback-independent reasoning eligibility`,
      );
    });
  }

  for (const filePath of agentCommandTargets) {
    stageFile(staged, filePath, content => {
      const pristineResolution = countPattern(content, PRISTINE_REASONING_RESOLUTION_PATTERN);
      const patchedResolution = countPattern(content, PATCHED_REASONING_RESOLUTION_PATTERN);
      const pristineForward = countPattern(content, PRISTINE_REASONING_FORWARD_PATTERN);
      const patchedForward = countPattern(content, PATCHED_REASONING_FORWARD_PATTERN);
      if (
        pristineResolution === 0 &&
        patchedResolution === 1 &&
        pristineForward === 0 &&
        patchedForward === 1
      ) {
        return content;
      }
      if (
        pristineResolution !== 1 ||
        patchedResolution !== 0 ||
        pristineForward !== 1 ||
        patchedForward !== 0
      ) {
        throw new Error(`${filePath}: direct agent reasoning propagation is incomplete`);
      }
      const withResolution = replaceUniquePattern(
        content,
        PRISTINE_REASONING_RESOLUTION_PATTERN,
        '$1$2const resolvedReasoningLevel = sessionEntry?.reasoningLevel ?? resolveAgentConfig(cfg, sessionAgentId)?.reasoningDefault ?? agentCfg?.reasoningDefault ?? "off";\n$2$3',
        `${filePath}: direct agent reasoning resolution`,
      );
      return replaceUniquePattern(
        withResolution,
        PRISTINE_REASONING_FORWARD_PATTERN,
        '$1$2resolvedReasoningLevel,\n$2$3',
        `${filePath}: direct agent reasoning forwarding`,
      );
    });
  }

  for (const filePath of attemptExecutionTargets) {
    stageFile(staged, filePath, content => {
      const pristineCount = countPattern(content, PRISTINE_EMBEDDED_REASONING_PATTERN);
      const patchedCount = countPattern(content, PATCHED_EMBEDDED_REASONING_PATTERN);
      if (pristineCount === 0 && patchedCount === 1) return content;
      if (pristineCount !== 1 || patchedCount !== 0) {
        throw new Error(`${filePath}: embedded direct-agent reasoning forwarding is incomplete`);
      }
      return replaceUniquePattern(
        content,
        PRISTINE_EMBEDDED_REASONING_PATTERN,
        '$1$2reasoningLevel: params.resolvedReasoningLevel,\n$2$3',
        `${filePath}: embedded direct-agent reasoning forwarding`,
      );
    });
  }

  const changed = [...staged.entries()]
    .map(([filePath, entry]) => ({ filePath, ...entry }))
    .filter(entry => writeIfChanged(entry.filePath, entry.original, entry.updated))
    .map(entry => path.relative(runtimeDir, entry.filePath));
  verifyPatch(runtimeDir);
  return changed;
}

function verifyPatch(runtimeDir) {
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  const targets = locateTargets(runtimeDir);
  const agentCommandTargets = locateAgentCommandTargets(runtimeDir);
  const attemptExecutionTargets = locateAttemptExecutionTargets(runtimeDir);
  assertTargetCount('reasoning stream verification', targets, expected);
  assertTargetCount('direct agent reasoning verification', agentCommandTargets, expected);
  assertTargetCount('embedded reasoning verification', attemptExecutionTargets, expected);
  for (const filePath of targets) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (
      countPattern(content, PRISTINE_PATTERN) !== 0 ||
      countPattern(content, PATCHED_PATTERN) !== 1
    ) {
      throw new Error(`${filePath}: callback-independent reasoning eligibility is incomplete`);
    }
    if (countPattern(content, CALLBACK_GUARD_PATTERN) !== 1) {
      throw new Error(`${filePath}: optional reasoning callback invocation guard is missing`);
    }
    if (!content.includes('emitAgentEvent({') || !content.includes('stream: "thinking"')) {
      throw new Error(`${filePath}: native reasoning event publication is missing`);
    }
  }
  for (const filePath of agentCommandTargets) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (
      countPattern(content, PRISTINE_REASONING_RESOLUTION_PATTERN) !== 0 ||
      countPattern(content, PATCHED_REASONING_RESOLUTION_PATTERN) !== 1 ||
      countPattern(content, PRISTINE_REASONING_FORWARD_PATTERN) !== 0 ||
      countPattern(content, PATCHED_REASONING_FORWARD_PATTERN) !== 1
    ) {
      throw new Error(`${filePath}: direct agent reasoning propagation is incomplete`);
    }
  }
  for (const filePath of attemptExecutionTargets) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (
      countPattern(content, PRISTINE_EMBEDDED_REASONING_PATTERN) !== 0 ||
      countPattern(content, PATCHED_EMBEDDED_REASONING_PATTERN) !== 1
    ) {
      throw new Error(`${filePath}: embedded direct-agent reasoning forwarding is incomplete`);
    }
  }
  return true;
}

module.exports = { applyPatch, verifyPatch };
