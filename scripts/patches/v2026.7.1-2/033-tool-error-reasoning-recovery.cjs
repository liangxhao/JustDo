'use strict';

// Capability: retry a reasoning-only response after a tool error with a request-only instruction.
// Target: pristine openclaw@2026.7.1-2, whose generic reasoning retry excludes this failure shape.
// Scope: at most two retries; skips abort/timeout/client-tool/yield/approval states.
// Safety: committed delivery, accepted child spawn and async-started tool work make replay unsafe.
// Safety: recovery input is not persisted as a visible user message and exhaustion stays terminal.
// Remove when: upstream provides an equivalent bounded request-only tool-error recovery policy.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUniquePattern, writeIfChanged } = require('./_patch-utils');

const HELPER = 'isJustDoToolErrorReasoningRecoveryCandidate';
const MESSAGE =
  'Immediately fix the previous tool error. Your next response must call a tool. Do not only describe the plan, and do not output a final summary.';
const DELIVERY_IMPORT_ANCHOR =
  'import { c as hasMessagingToolDeliveryEvidence, l as hasOutboundDeliveryEvidence } from "./delivery-evidence-Du4oIHR6.js";';
const DELIVERY_IMPORT_REPLACEMENT =
  'import { a as hasCommittedMessagingToolDeliveryEvidence, c as hasMessagingToolDeliveryEvidence, l as hasOutboundDeliveryEvidence, p as hasAcceptedSessionSpawn } from "./delivery-evidence-Du4oIHR6.js";';

function transform(content, filePath) {
  if (content.includes(`function ${HELPER}(`)) {
    for (const contract of [
      DELIVERY_IMPORT_REPLACEMENT,
      'hasCommittedMessagingToolDeliveryEvidence(params.attempt)',
      'hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns)',
      'entry.asyncStarted === true',
    ]) {
      if (!content.includes(contract))
        throw new Error(`${filePath}: partial tool-error reasoning recovery patch detected`);
    }
    return content;
  }
  let updated = replaceUniquePattern(
    content,
    new RegExp(DELIVERY_IMPORT_ANCHOR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    DELIVERY_IMPORT_REPLACEMENT,
    `${filePath}: delivery evidence imports`,
  );
  updated = replaceUniquePattern(
    updated,
    /const maxReasoningOnlyRetryAttempts = 2;\n\t\t\tconst maxEmptyResponseRetryAttempts = 1;/,
    `const maxReasoningOnlyRetryAttempts = 2;\n\t\t\tconst maxEmptyResponseRetryAttempts = 1;\n\t\t\tconst maxJustDoToolErrorRecoveryAttempts = 2;`,
    `${filePath}: bounded recovery limit`,
  );
  updated = replaceUniquePattern(
    updated,
    /let reasoningOnlyRetryAttempts = 0;\n\t\t\tlet emptyResponseRetryAttempts = 0;/,
    `let reasoningOnlyRetryAttempts = 0;\n\t\t\tlet justDoToolErrorRecoveryAttempts = 0;\n\t\t\tlet emptyResponseRetryAttempts = 0;`,
    `${filePath}: recovery counter`,
  );
  updated = replaceUniquePattern(
    updated,
    /async function runEmbeddedAttemptWithBackend\(params\) \{/,
    `const JUSTDO_TOOL_ERROR_RECOVERY_INSTRUCTION = ${JSON.stringify(MESSAGE)};\nfunction ${HELPER}(params) {\n\tif (params.aborted || params.timedOut || params.attempt.clientToolCalls || params.attempt.yieldDetected || params.attempt.didSendDeterministicApprovalPrompt) return false;\n\tif (hasCommittedMessagingToolDeliveryEvidence(params.attempt)) return false;\n\tif (hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns)) return false;\n\tif ((params.attempt.toolMetas ?? []).some((entry) => entry.asyncStarted === true)) return false;\n\tif (!params.attempt.lastToolError && params.recoveryAttempts === 0) return false;\n\tconst assistant = params.attempt.currentAttemptAssistant ?? params.attempt.lastAssistant;\n\treturn !params.finalAssistantVisibleText && Boolean(assistant && hasOnlyAssistantReasoningContent(assistant));\n}\nasync function runEmbeddedAttemptWithBackend(params) {`,
    `${filePath}: recovery classifier`,
  );
  updated = replaceUniquePattern(
    updated,
    /(const nextReasoningOnlyRetryInstruction = emptyAssistantReplyIsSilent \? null : resolveReasoningOnlyRetryInstruction\(\{)/,
    `const justDoToolErrorRecoveryCandidate = ${HELPER}({\n\t\t\t\t\t\taborted,\n\t\t\t\t\t\ttimedOut,\n\t\t\t\t\t\tattempt,\n\t\t\t\t\t\tfinalAssistantVisibleText,\n\t\t\t\t\t\trecoveryAttempts: justDoToolErrorRecoveryAttempts\n\t\t\t\t\t});\n\t\t\t\t\tif (justDoToolErrorRecoveryCandidate && justDoToolErrorRecoveryAttempts < maxJustDoToolErrorRecoveryAttempts) {\n\t\t\t\t\t\tjustDoToolErrorRecoveryAttempts += 1;\n\t\t\t\t\t\treasoningOnlyRetryInstruction = JUSTDO_TOOL_ERROR_RECOVERY_INSTRUCTION;\n\t\t\t\t\t\temptyResponseRetryInstruction = null;\n\t\t\t\t\t\tsuppressNextUserMessagePersistence = true;\n\t\t\t\t\t\tlog$$1.warn(\`reasoning-only response after tool error: runId=\${params.runId} attempt=\${justDoToolErrorRecoveryAttempts}/\${maxJustDoToolErrorRecoveryAttempts} — retrying with request-only recovery instruction\`);\n\t\t\t\t\t\tcontinue;\n\t\t\t\t\t}\n\t\t\t\t\t$1`,
    `${filePath}: recovery decision`,
  );
  return updated;
}

function applyPatch(runtimeDir) {
  const files = findFilesContaining(runtimeDir, [
    'async function runEmbeddedAttemptWithBackend(params)',
    'const nextReasoningOnlyRetryInstruction = emptyAssistantReplyIsSilent',
  ]).filter(filePath => path.basename(filePath) !== 'gateway-bundle.mjs');
  if (files.length !== 1)
    throw new Error(`tool-error recovery target count is ${files.length}, expected 1`);
  const filePath = files[0];
  const original = fs.readFileSync(filePath, 'utf8');
  const updated = transform(original, filePath);
  return writeIfChanged(filePath, original, updated) ? [path.relative(runtimeDir, filePath)] : [];
}

function verifyPatch(runtimeDir) {
  const files = findFilesContaining(runtimeDir, [`function ${HELPER}(`]);
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  if (files.length !== expected)
    throw new Error(
      `tool-error reasoning recovery target count is ${files.length}, expected ${expected}`,
    );
  const combined = files.map(filePath => fs.readFileSync(filePath, 'utf8')).join('\n');
  for (const contract of [
    'maxJustDoToolErrorRecoveryAttempts = 2',
    'suppressNextUserMessagePersistence = true',
    'request-only recovery instruction',
    'hasOnlyAssistantReasoningContent(assistant)',
    'hasCommittedMessagingToolDeliveryEvidence(params.attempt)',
    'hasAcceptedSessionSpawn(params.attempt.acceptedSessionSpawns)',
    'entry.asyncStarted === true',
  ]) {
    if (!combined.includes(contract))
      throw new Error(`tool-error recovery contract is missing: ${contract}`);
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  MESSAGE,
  __testing: { DELIVERY_IMPORT_ANCHOR, DELIVERY_IMPORT_REPLACEMENT, HELPER },
};
