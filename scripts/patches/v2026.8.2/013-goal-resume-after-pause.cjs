'use strict';

// Capability: resume a paused Goal whose preceding run was intentionally aborted.
// Target: openclaw@2026.8.2 restart-safe chat admission for native Goal resume.
// Scope: Goal resume only; new Goals and ordinary chat retain the native abort guard.
// Safety: all native idle, freshness, routing, hierarchy, and active-work checks remain required.
// Remove when: upstream Goal resume admits an idle paused session after its run is aborted.

const fs = require('fs');
const path = require('path');
const {
  countOccurrences,
  findFilesContaining,
  findMatchingDelimiter,
  isGatewayBundlePath,
  writeIfChanged,
} = require('./_patch-utils.js');

const MARKERS = {
  admission: 'JUSTDO_GOAL_RESUME_ABORTED_ADMISSION_V2026_8_2',
  guard: 'JUSTDO_GOAL_RESUME_ABORTED_GUARD_V2026_8_2',
};
const ERROR_TEXT = 'Goal start or resume requires an idle local session with recoverable history.';

function expectedCount(runtimeDir) {
  return fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 3 : 2;
}

function targets(runtimeDir) {
  return findFilesContaining(runtimeDir, [
    'function isRestartSafeChatSession(',
    'function resolveRestartSafeChatAdmission(',
    'async function admitChatSend(',
    ERROR_TEXT,
  ]);
}

function findNamedFunctionRange(content, functionName, filePath, isAsync = false) {
  const signature = `${isAsync ? 'async ' : ''}function ${functionName}(`;
  const signatureIndex = content.indexOf(signature);
  if (signatureIndex < 0 || content.indexOf(signature, signatureIndex + signature.length) >= 0) {
    throw new Error(`${filePath}: ${functionName} target is missing or ambiguous`);
  }
  const parameterStart = signatureIndex + signature.length - 1;
  const parameterEnd = findMatchingDelimiter(
    content,
    parameterStart,
    '(',
    ')',
    `${filePath}: ${functionName} parameters`,
  );
  const parameterName = content.slice(parameterStart + 1, parameterEnd).trim();
  if (!/^[A-Za-z_$][\w$]*$/u.test(parameterName)) {
    throw new Error(`${filePath}: ${functionName} parameter shape is unsupported`);
  }
  let bodyStart = parameterEnd + 1;
  while (/\s/u.test(content[bodyStart] ?? '')) bodyStart += 1;
  const bodyEnd = findMatchingDelimiter(
    content,
    bodyStart,
    '{',
    '}',
    `${filePath}: ${functionName} body`,
  );
  return {
    parameterName,
    bodyStart,
    bodyEnd,
    body: content.slice(bodyStart + 1, bodyEnd),
  };
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function matchCount(content, pattern) {
  return [...content.matchAll(pattern)].length;
}

function transformRestartSafeGuard(content, filePath) {
  const isBundle = isGatewayBundlePath(filePath);
  const range = findNamedFunctionRange(content, 'isRestartSafeChatSession', filePath);
  const parameter = escaped(range.parameterName);
  const entryMatch = new RegExp(
    `\\b(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${parameter}\\.entry\\s*;`,
    'u',
  ).exec(range.body);
  const entryName = entryMatch?.[1];
  if (!entryName) throw new Error(`${filePath}: restart-safe entry alias is unknown`);
  const entry = escaped(entryName);
  const originalPattern = new RegExp(`${entry}\\.abortedLastRun\\s*!==\\s*(?:true|!0)`, 'gu');
  const patchedPattern = new RegExp(
    `\\(\\s*${entry}\\.abortedLastRun\\s*!==\\s*(?:true|!0)\\s*\\|\\|\\s*` +
      `${parameter}\\.allowAbortedLastRun\\s*===\\s*(?:true|!0)\\s*\\)`,
    'gu',
  );
  const patchedCount = matchCount(range.body, patchedPattern);
  const markerCount = countOccurrences(range.body, MARKERS.guard);
  if (patchedCount === 1) {
    if ((isBundle && markerCount === 0) || (!isBundle && markerCount === 1)) return content;
    throw new Error(`${filePath}: historical or partial Goal resume abort guard detected`);
  }
  if (patchedCount > 0 || markerCount > 0 || range.body.includes('allowAbortedLastRun')) {
    throw new Error(`${filePath}: historical or partial Goal resume abort guard detected`);
  }
  const originalCount = matchCount(range.body, originalPattern);
  if (originalCount !== 1) {
    throw new Error(
      `${filePath}: Goal resume abort guard target count is ${originalCount}, expected 1`,
    );
  }
  const patchedBody = range.body.replace(
    originalPattern,
    match =>
      `(${match} || ${range.parameterName}.allowAbortedLastRun === true)` +
      (isBundle ? '' : `/*${MARKERS.guard}*/`),
  );
  return `${content.slice(0, range.bodyStart + 1)}${patchedBody}${content.slice(range.bodyEnd)}`;
}

function transformAdmissionCall(content, filePath) {
  const isBundle = isGatewayBundlePath(filePath);
  const range = findNamedFunctionRange(content, 'admitChatSend', filePath, true);
  const requestBinding = /\{\s*request(?:\s*:\s*([A-Za-z_$][\w$]*))?\s*,\s*session\b/u.exec(
    range.body,
  );
  if (!requestBinding) throw new Error(`${filePath}: Goal admission request alias is unknown`);
  const requestName = requestBinding[1] ?? 'request';
  const request = escaped(requestName);
  const patchedPattern = new RegExp(
    `allowAbortedLastRun\\s*:\\s*${request}\\.goalOperation\\?\\.action\\s*===\\s*` +
      `(?:"resume"|'resume'|\x60resume\x60)`,
    'gu',
  );
  const patchedCount = matchCount(range.body, patchedPattern);
  const markerCount = countOccurrences(range.body, MARKERS.admission);
  if (patchedCount === 1) {
    if ((isBundle && markerCount === 0) || (!isBundle && markerCount === 1)) return content;
    throw new Error(`${filePath}: historical or partial Goal resume admission patch detected`);
  }
  if (patchedCount > 0 || markerCount > 0 || range.body.includes('allowAbortedLastRun')) {
    throw new Error(`${filePath}: historical or partial Goal resume admission patch detected`);
  }
  const callPattern = /resolveRestartSafeChatAdmission\s*\(\s*\{/gu;
  const callCount = matchCount(range.body, callPattern);
  if (callCount !== 1) {
    throw new Error(`${filePath}: Goal resume admission target count is ${callCount}, expected 1`);
  }
  const patchedBody = range.body.replace(
    callPattern,
    match =>
      `${match}\n\t\t\tallowAbortedLastRun: ${requestName}.goalOperation?.action === "resume"` +
      (isBundle ? ',' : `/*${MARKERS.admission}*/,`),
  );
  return `${content.slice(0, range.bodyStart + 1)}${patchedBody}${content.slice(range.bodyEnd)}`;
}

function transform(content, filePath) {
  const guardMarkerCount = countOccurrences(content, MARKERS.guard);
  const admissionMarkerCount = countOccurrences(content, MARKERS.admission);
  const validMarkerState = isGatewayBundlePath(filePath)
    ? guardMarkerCount === 0 && admissionMarkerCount === 0
    : (guardMarkerCount === 0 && admissionMarkerCount === 0) ||
      (guardMarkerCount === 1 && admissionMarkerCount === 1);
  if (!validMarkerState) {
    throw new Error(`${filePath}: partial Goal resume admission patch detected`);
  }
  return transformAdmissionCall(transformRestartSafeGuard(content, filePath), filePath);
}

function assertContracts(content, filePath) {
  const guarded = transformRestartSafeGuard(content, filePath);
  if (guarded !== content) throw new Error(`${filePath}: missing Goal resume abort guard`);
  const admitted = transformAdmissionCall(content, filePath);
  if (admitted !== content) throw new Error(`${filePath}: missing Goal resume admission`);
}

function applyPatch(runtimeDir) {
  const files = targets(runtimeDir);
  const expected = expectedCount(runtimeDir);
  if (files.length !== expected) {
    throw new Error(`Goal resume admission target count is ${files.length}, expected ${expected}`);
  }
  const changed = [];
  for (const filePath of files) {
    const original = fs.readFileSync(filePath, 'utf8');
    const updated = transform(original, filePath);
    if (writeIfChanged(filePath, original, updated)) {
      changed.push(path.relative(runtimeDir, filePath));
    }
  }
  return changed;
}

function verifyPatch(runtimeDir) {
  const files = targets(runtimeDir);
  const expected = expectedCount(runtimeDir);
  if (files.length !== expected) {
    throw new Error(`Goal resume admission target count is ${files.length}, expected ${expected}`);
  }
  for (const filePath of files) assertContracts(fs.readFileSync(filePath, 'utf8'), filePath);
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: {
    ERROR_TEXT,
    MARKERS,
    transform,
  },
};
