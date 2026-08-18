'use strict';

// Capability: attach LiteLLM agent session/parent metadata and one-shot user initiation evidence.
// Target: pristine openclaw@2026.7.1-2, which emits no equivalent provider payload metadata.
// Scope: adds chat.send schema/registration plus builtin_models/justdo agent egress only.
// Safety: strict compatible/custom providers receive no JustDo metadata; their one-shot run
// bookkeeping is discarded. user_initiated is consumed once and stable IDs are never rewritten.
// Remove when: upstream supports session_id, parent_session_id and initiation metadata natively.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUniquePattern, writeIfChanged } = require('./_patch-utils');

const CAPABILITY = 'justdo-agent-request-metadata';
const SUPPORTED_APIS =
  'new Set(["openai-completions", "openai-responses", "azure-openai-responses"])';
const LITELLM_PROVIDERS = 'new Set(["builtin_models", "justdo"])';

function patchSchema(content, filePath) {
  if (content.includes('justdoUserInitiated:')) return content;
  return replaceUniquePattern(
    content,
    /(systemInputProvenance:\s*(\w+)\.Optional\(InputProvenanceSchema\),\s*)(systemProvenanceReceipt:)/,
    (_match, prefix, typeboxName, suffix) =>
      `${prefix}justdoUserInitiated: ${typeboxName}.Optional(${typeboxName}.Boolean()),\n      ${suffix}`,
    `${filePath}: chat.send user initiation schema`,
  );
}

function patchChatRegistration(content, filePath) {
  if (content.includes('userRuns.add(clientRunId)')) return content;
  const anchorIndex = content.search(/context\w*\.addChatRun\(clientRunId, \{/);
  if (anchorIndex < 0) throw new Error(`${filePath}: chat.send run registration anchor is missing`);
  const prefix = content.slice(0, anchorIndex);
  const paramMatches = [...prefix.matchAll(/const (p\d*) = controlUiReconnectResume\.params;/g)];
  if (paramMatches.length === 0)
    throw new Error(`${filePath}: validated chat.send params are missing`);
  const paramsName = paramMatches.at(-1)[1];
  return replaceUniquePattern(
    content,
    /(context\w*\.addChatRun\(clientRunId, \{\s*sessionKey,)/,
    `// ${CAPABILITY}: register an explicit human-originated run only.
      if (${paramsName}.justdoUserInitiated === true) {
        const userRuns = globalThis[Symbol.for("justdo.litellm.user-runs")] ??= new Set();
        userRuns.add(clientRunId);
        if (userRuns.size > 4096) userRuns.delete(userRuns.values().next().value);
      }
      $1`,
    `${filePath}: chat.send run registration`,
  );
}

function patchAgentStream(content, filePath) {
  if (content.includes('function wrapJustDoAgentRequestMetadata(')) {
    for (const contract of [
      'justDoLiteLLMProviderIds.has(params.modelProvider)',
      'userRuns?.delete(params.runId)',
      'modelProvider: params.model.provider',
    ]) {
      if (!content.includes(contract)) {
        throw new Error(`${filePath}: partial agent metadata patch (${contract})`);
      }
    }
    return content;
  }
  let updated = replaceUniquePattern(
    content,
    /async function loadAttemptSessionEntryAfterQuotaMaintenance\(params\) \{/,
    `const justDoLiteLLMMetadataApis = ${SUPPORTED_APIS};
const justDoLiteLLMProviderIds = ${LITELLM_PROVIDERS};
// ${CAPABILITY}: provider payload
function wrapJustDoAgentRequestMetadata(streamFn, params) {
  const userRuns = globalThis[Symbol.for("justdo.litellm.user-runs")];
  if (!params.sessionId || !justDoLiteLLMProviderIds.has(params.modelProvider) || !justDoLiteLLMMetadataApis.has(params.modelApi)) {
    userRuns?.delete(params.runId);
    return streamFn;
  }
  const childAgentId = params.sessionKey ? resolveSessionAgentIds(params.sessionKey).agentId : void 0;
  const childStorePath = childAgentId ? resolveStorePath(params.config?.session?.store, { agentId: childAgentId }) : void 0;
  const childEntry = params.sessionKey && childStorePath ? loadSessionEntry({
    storePath: childStorePath,
    sessionKey: params.sessionKey
  }) : void 0;
  const parentAgentId = params.spawnedBy ? resolveSessionAgentIds(params.spawnedBy).agentId : void 0;
  const parentStorePath = parentAgentId ? resolveStorePath(params.config?.session?.store, { agentId: parentAgentId }) : void 0;
  const parentEntry = params.spawnedBy && parentStorePath ? loadSessionEntry({
    storePath: parentStorePath,
    sessionKey: params.spawnedBy
  }) : void 0;
  const persistedParentSessionId = typeof childEntry?.parentSessionId === "string"
    ? childEntry.parentSessionId
    : void 0;
  const legacyParentSessionId = typeof parentEntry?.sessionId === "string"
    ? parentEntry.sessionId
    : void 0;
  const parentSessionId = (persistedParentSessionId || legacyParentSessionId) !== params.sessionId
    ? persistedParentSessionId || legacyParentSessionId
    : void 0;
  if (!persistedParentSessionId && parentSessionId && params.sessionKey && childStorePath) {
    void updateSessionEntry({ storePath: childStorePath, sessionKey: params.sessionKey }, (entry) => {
      if (entry.sessionId !== params.sessionId || entry.parentSessionId) return null;
      return { parentSessionId };
    }, { skipMaintenance: true, takeCacheOwnership: true });
  }
  let firstRequest = true;
  return (model, context, options) => streamWithPayloadPatch(streamFn, model, context, options, (payload) => {
    const existing = payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
      ? payload.metadata
      : {};
    payload.metadata = {
      ...existing,
      session_id: params.sessionId,
      request_purpose: "agent"
    };
    if (parentSessionId) payload.metadata.parent_session_id = parentSessionId;
    else delete payload.metadata.parent_session_id;
    if (firstRequest && userRuns?.delete(params.runId)) payload.metadata.user_initiated = true;
    else delete payload.metadata.user_initiated;
    firstRequest = false;
  });
}
async function loadAttemptSessionEntryAfterQuotaMaintenance(params) {`,
    `${filePath}: metadata wrapper`,
  );

  updated = replaceUniquePattern(
    updated,
    /(activeSession\.agent\.streamFn = resolveEmbeddedAgentStreamFn\(\{[\s\S]*?authStorage: params\.authStorage\s*\}\);)(\s*const providerTextTransforms)/,
    `$1
      activeSession.agent.streamFn = wrapJustDoAgentRequestMetadata(activeSession.agent.streamFn, {
        sessionId: params.sessionId,
        runId: params.runId,
        sessionKey: params.sessionKey,
        spawnedBy: params.spawnedBy,
        storePath: params.storePath,
        config: params.config,
        modelApi: params.model.api,
        modelProvider: params.model.provider
      });$2`,
    `${filePath}: agent stream installation`,
  );
  return updated;
}

function applyPatch(runtimeDir) {
  const schemaFiles = findFilesContaining(runtimeDir, [
    'ChatSendParamsSchema',
    'systemInputProvenance:',
    'systemProvenanceReceipt:',
  ]);
  const chatFiles = findFilesContaining(runtimeDir, [
    'addChatRun(clientRunId, {',
    'chatSendReceivedAtMs',
  ]);
  const streamFiles = findFilesContaining(runtimeDir, [
    'activeSession.agent.streamFn = resolveEmbeddedAgentStreamFn({',
    'loadAttemptSessionEntryAfterQuotaMaintenance',
    'streamWithPayloadPatch',
  ]);
  const withBundle = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs'));
  const expected = withBundle ? 2 : 1;
  for (const [label, files] of [
    ['schema', schemaFiles],
    ['chat', chatFiles],
    ['stream', streamFiles],
  ]) {
    if (files.length !== expected)
      throw new Error(`${label} metadata target count is ${files.length}, expected ${expected}`);
  }
  const transforms = new Map();
  const addTransform = (filePath, transform) => {
    const existing = transforms.get(filePath) ?? [];
    existing.push(transform);
    transforms.set(filePath, existing);
  };
  for (const filePath of schemaFiles) addTransform(filePath, patchSchema);
  for (const filePath of chatFiles) addTransform(filePath, patchChatRegistration);
  for (const filePath of streamFiles) addTransform(filePath, patchAgentStream);
  const staged = [];
  for (const [filePath, fileTransforms] of transforms) {
    const original = fs.readFileSync(filePath, 'utf8');
    const updated = fileTransforms.reduce(
      (current, transform) => transform(current, filePath),
      original,
    );
    staged.push({ filePath, original, updated });
  }
  const changed = [];
  for (const item of staged) {
    if (writeIfChanged(item.filePath, item.original, item.updated)) changed.push(item.filePath);
  }
  return changed;
}

function verifyPatch(runtimeDir) {
  const schemaFiles = findFilesContaining(runtimeDir, ['ChatSendParamsSchema']);
  if (
    !schemaFiles.some(filePath =>
      /justdoUserInitiated:\s*\w+\.Optional\(\w+\.Boolean\(\)\)/.test(
        fs.readFileSync(filePath, 'utf8'),
      ),
    )
  ) {
    throw new Error('chat.send user initiation schema is missing');
  }
  const registrationFiles = findFilesContaining(runtimeDir, ['userRuns.add(clientRunId)']);
  const wrapperFiles = findFilesContaining(runtimeDir, [
    'function wrapJustDoAgentRequestMetadata(',
  ]);
  if (registrationFiles.length === 0 || wrapperFiles.length === 0) {
    throw new Error('agent metadata registration or provider wrapper is missing');
  }
  const combined = wrapperFiles.map(filePath => fs.readFileSync(filePath, 'utf8')).join('\n');
  for (const required of [
    'session_id: params.sessionId',
    'request_purpose: "agent"',
    'justDoLiteLLMProviderIds.has(params.modelProvider)',
    'userRuns?.delete(params.runId)',
    'parent_session_id',
    'resolveStorePath(params.config?.session?.store',
    'entry.parentSessionId',
    'user_initiated',
  ]) {
    if (!combined.includes(required))
      throw new Error(`agent metadata field is missing: ${required}`);
  }
}

module.exports = { applyPatch, patchAgentStream, verifyPatch };
