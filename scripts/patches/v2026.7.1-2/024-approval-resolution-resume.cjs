'use strict';

// Capability: resume a JustDo webchat approval as a hidden follow-up agent turn.
// Target: pristine openclaw@2026.7.1-2 exec approval routing and follow-up arguments.
// Scope: persisted JustDo ancestry on webchat only; native non-JustDo channels stay inline.
// Safety: depends on patch 023's trusted ancestry helper and upstream prompt-persistence guard.
// Remove when: upstream can resume webchat approvals without persisting the synthetic user prompt.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUnique, writeIfChanged } = require('./_patch-utils');

const CAPABILITY = 'justdo-approval-resolution-resume';

function expectedCopies(runtimeDir) {
  return fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
}

function findTargets(runtimeDir) {
  const files = findFilesContaining(runtimeDir, [
    'function shouldAwaitGatewayApprovalInline(params)',
    'function buildAgentFollowupArgs(params)',
  ]);
  const expected = expectedCopies(runtimeDir);
  if (files.length !== expected) {
    throw new Error(`approval resume target count is ${files.length}, expected ${expected}`);
  }
  return files;
}

function transform(content, filePath) {
  if (
    /channel === "webchat" && isJustDoManagedApprovalSessionKey\d*\(params\.sessionKey\)/.test(
      content,
    ) &&
    content.includes('{ suppressPromptPersistence: true }')
  ) {
    return content;
  }
  if (!content.includes('function isJustDoManagedApprovalSessionKey(sessionKey)')) {
    throw new Error(`${filePath}: patch 023 trusted ancestry helper is missing`);
  }
  let updated = replaceUnique(
    content,
    `function shouldAwaitGatewayApprovalInline(params) {
\tif (params.approvalFollowupMode !== void 0) return false;
\treturn isNativeApprovalChannel(normalizeMessageChannel(params.turnSourceChannel));
}`,
    `function shouldAwaitGatewayApprovalInline(params) {
\tif (params.approvalFollowupMode !== void 0) return false;
\tconst channel = normalizeMessageChannel(params.turnSourceChannel);
\t// ${CAPABILITY}: webchat async resume
\tif (channel === "webchat" && isJustDoManagedApprovalSessionKey(params.sessionKey)) return false;
\treturn isNativeApprovalChannel(channel);
}`,
    `${filePath}: webchat async approval routing`,
  );
  updated = replaceUnique(
    updated,
    `\t\tidempotencyKey: params.idempotencyKey ?? buildExecApprovalFollowupIdempotencyKey({ approvalId: params.approvalId }),
\t\t...params.expectedSessionId ? { execApprovalFollowupExpectedSessionId: params.expectedSessionId } : {},`,
    `\t\tidempotencyKey: params.idempotencyKey ?? buildExecApprovalFollowupIdempotencyKey({ approvalId: params.approvalId }),
\t\t// ${CAPABILITY}: hidden synthetic prompt
\t\t...normalizeMessageChannel(params.turnSourceChannel) === "webchat" && isJustDoManagedApprovalSessionKey(params.sessionKey) ? { suppressPromptPersistence: true } : {},
\t\t...params.expectedSessionId ? { execApprovalFollowupExpectedSessionId: params.expectedSessionId } : {},`,
    `${filePath}: hidden approval follow-up prompt`,
  );
  return updated;
}

function applyPatch(runtimeDir) {
  const staged = findTargets(runtimeDir).map(filePath => {
    const original = fs.readFileSync(filePath, 'utf8');
    return { filePath, original, updated: transform(original, filePath) };
  });
  const changed = [];
  for (const { filePath, original, updated } of staged) {
    if (writeIfChanged(filePath, original, updated)) changed.push(filePath);
  }
  return changed;
}

function verifyPatch(runtimeDir) {
  for (const filePath of findTargets(runtimeDir)) {
    const content = fs.readFileSync(filePath, 'utf8');
    const required = [
      /channel === "webchat" && isJustDoManagedApprovalSessionKey\d*\(params\.sessionKey\)/,
      '{ suppressPromptPersistence: true }',
    ];
    for (const needle of required) {
      const present = needle instanceof RegExp ? needle.test(content) : content.includes(needle);
      if (!present) throw new Error(`${filePath}: missing ${needle}`);
    }
    if (!content.includes('return isNativeApprovalChannel(channel);')) {
      throw new Error(`${filePath}: upstream native-channel inline routing is missing`);
    }
    if (!content.includes('requestedPromptPersistenceSuppression')) {
      // This symbol is in another bundle; the source-side contract is verified by runtime packaging tests.
      const runtimeFiles = findFilesContaining(runtimeDir, [
        'requestedPromptPersistenceSuppression',
        'suppressPromptPersistence',
      ]);
      if (runtimeFiles.length < expectedCopies(runtimeDir)) {
        throw new Error(`${filePath}: upstream suppressPromptPersistence consumer is missing`);
      }
    }
  }
}

module.exports = { applyPatch, transform, verifyPatch };
