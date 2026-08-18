'use strict';

// Capability: preserve parent Gateway identity and suppress racing announces after a managed join starts.
// Target: pristine openclaw@2026.7.1-2 plus patches 018-020's managed join state machine.
// Scope: immutable identity evidence, delivery-state preservation and a final pre-delivery race fence.
// Safety: no sessionId assignment is introduced; failed joins use patch 020 to restore native push delivery.
// Remove when: upstream same-run joins preserve logical identity and fence in-flight announce delivery.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUnique, writeIfChanged } = require('./_patch-utils.js');

function shouldSuppressJustDoManagedJoinAnnounce(entry) {
  const state = entry?.delivery?.justDoManagedJoin?.state;
  return (
    state === 'waiting' ||
    state === 'presented' ||
    state === 'tool_result_committed' ||
    state === 'consumed'
  );
}

function transformTools(content, filePath) {
  if (content.includes('gatewaySessionId: opts.sessionId')) return content;
  if (!content.includes('function waitForJustDoManagedSubagents('))
    throw new Error(`${filePath}: same-run join prerequisite is missing`);
  return replaceUnique(
    content,
    '\t\t\t\t\tcontrollerSessionKey,\n\t\t\t\t\toriginalCleanup:',
    '\t\t\t\t\tcontrollerSessionKey,\n\t\t\t\t\tgatewaySessionId: opts.sessionId,\n\t\t\t\t\toriginalCleanup:',
    `${filePath}: managed join immutable Gateway identity evidence`,
  );
}

function transformState(content, filePath) {
  if (content.includes('const justDoManagedJoin = entry.delivery?.justDoManagedJoin;'))
    return content;
  return replaceUnique(
    content,
    `function clearDeliveryState(entry) {
\tentry.delivery = { status: entry.expectsCompletionMessage === false ? "not_required" : "pending" };
}`,
    `function clearDeliveryState(entry) {
\tconst justDoManagedJoin = entry.delivery?.justDoManagedJoin;
\tentry.delivery = {
\t\tstatus: entry.expectsCompletionMessage === false ? "not_required" : "pending",
\t\t...justDoManagedJoin ? { justDoManagedJoin } : {}
\t};
}`,
    `${filePath}: managed join delivery state preservation`,
  );
}

function transformAnnounce(content, filePath) {
  const hasHelper = content.includes('function shouldSuppressJustDoManagedJoinAnnounce(entry)');
  const hasFence = content.includes(
    'shouldSuppressJustDoManagedJoinAnnounce(justDoManagedJoinRun)',
  );
  if (hasHelper && hasFence) return content;
  if (hasHelper || hasFence)
    throw new Error(`${filePath}: partial managed join announce fence detected`);
  let updated = replaceUnique(
    content,
    'async function runSubagentAnnounceFlow(params) {',
    `${shouldSuppressJustDoManagedJoinAnnounce.toString()}
async function runSubagentAnnounceFlow(params) {`,
    `${filePath}: managed join announce predicate`,
  );
  updated = replaceUnique(
    updated,
    '\t\tconst completionDirectOrigin = expectsCompletionMessage && !requesterIsSubagent ? await resolveSubagentCompletionOrigin({',
    `\t\tconst justDoManagedJoinRun = (subagentRegistryRuntime ?? await loadSubagentRegistryRuntime()).getLatestSubagentRunByChildSessionKey(params.childSessionKey);
\t\tif (shouldSuppressJustDoManagedJoinAnnounce(justDoManagedJoinRun)) {
\t\t\tshouldDeleteChildSession = false;
\t\t\treturn true;
\t\t}
\t\tconst completionDirectOrigin = expectsCompletionMessage && !requesterIsSubagent ? await resolveSubagentCompletionOrigin({`,
    `${filePath}: managed join in-flight announce fence`,
  );
  return updated;
}

function locateTargets(runtimeDir) {
  const tools = findFilesContaining(runtimeDir, [
    'function waitForJustDoManagedSubagents(',
    'function createSessionsYieldTool(opts)',
  ]);
  const state = findFilesContaining(runtimeDir, [
    'function clearDeliveryState(entry)',
    'function ensureDeliveryState(entry)',
  ]);
  const announce = findFilesContaining(runtimeDir, [
    'async function runSubagentAnnounceFlow(params)',
    'const completionDirectOrigin = expectsCompletionMessage',
  ]);
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  if (tools.length !== expected || state.length !== expected || announce.length !== expected)
    throw new Error(
      `managed join identity target counts are tools=${tools.length}, state=${state.length}, announce=${announce.length}; expected ${expected} each`,
    );
  return { tools, state, announce };
}

function applyPatch(runtimeDir) {
  const targets = locateTargets(runtimeDir);
  const transforms = new Map();
  for (const filePath of targets.tools)
    transforms.set(filePath, [...(transforms.get(filePath) ?? []), transformTools]);
  for (const filePath of targets.state)
    transforms.set(filePath, [...(transforms.get(filePath) ?? []), transformState]);
  for (const filePath of targets.announce)
    transforms.set(filePath, [...(transforms.get(filePath) ?? []), transformAnnounce]);
  const staged = [];
  for (const [filePath, fileTransforms] of transforms) {
    const original = fs.readFileSync(filePath, 'utf8');
    const updated = fileTransforms.reduce(
      (value, transform) => transform(value, filePath),
      original,
    );
    staged.push({ filePath, original, updated });
  }
  const changed = [];
  for (const { filePath, original, updated } of staged)
    if (writeIfChanged(filePath, original, updated))
      changed.push(path.relative(runtimeDir, filePath));
  return changed;
}

function verifyPatch(runtimeDir) {
  const targets = locateTargets(runtimeDir);
  for (const filePath of targets.tools) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (!content.includes('gatewaySessionId: opts.sessionId'))
      throw new Error(`${filePath}: managed join Gateway identity evidence is missing`);
    if (!content.includes('controllerSessionKey'))
      throw new Error(`${filePath}: managed join controller identity is missing`);
  }
  for (const filePath of targets.state)
    if (
      !fs
        .readFileSync(filePath, 'utf8')
        .includes('...justDoManagedJoin ? { justDoManagedJoin } : {}')
    )
      throw new Error(`${filePath}: managed join delivery state preservation is missing`);
  for (const filePath of targets.announce) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const expected of [
      'function shouldSuppressJustDoManagedJoinAnnounce(entry)',
      'getLatestSubagentRunByChildSessionKey(params.childSessionKey)',
      'shouldSuppressJustDoManagedJoinAnnounce(justDoManagedJoinRun)',
      'shouldDeleteChildSession = false;',
      'return true;',
    ])
      if (!content.includes(expected))
        throw new Error(`${filePath}: managed join announce fence is missing ${expected}`);
  }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: { shouldSuppressJustDoManagedJoinAnnounce },
};
