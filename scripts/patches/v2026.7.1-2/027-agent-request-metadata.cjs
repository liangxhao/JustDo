'use strict';

// Capability: attach LiteLLM agent session/parent metadata and one-shot user initiation evidence.
// Target: pristine openclaw@2026.7.1-2, which emits no equivalent provider payload metadata.
// Scope: adds chat.send schema/registration plus builtin_models agent egress only.
// Safety: strict compatible/custom providers receive no OpenClaw request metadata; their one-shot run
// bookkeeping is discarded. Missing identity is logged and egress continues unmodified.
// user_initiated is consumed once and stable IDs are never rewritten.
// Remove when: upstream supports session_id, parent_session_id and initiation metadata natively.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUniquePattern, writeIfChanged } = require('./_patch-utils');

const CAPABILITY = 'openclaw-agent-request-metadata';
const SUPPORTED_APIS = 'new Set(["openai-completions"])';
const LITELLM_PROVIDERS = 'new Set(["builtin_models"])';
const AGENT_METADATA_INSTALLATION_PATTERN =
  /\n[ \t]*activeSession\.agent\.streamFn = wrapJustDoAgentRequestMetadata\(activeSession\.agent\.streamFn, \{\s*sessionId: activeSession\.sessionId \|\| params\.sessionId,\s*runId: params\.runId,\s*sessionKey: params\.sessionKey,\s*spawnedBy: params\.spawnedBy,\s*storePath: params\.storePath,\s*config: params\.config,\s*modelApi: params\.model\.api,\s*modelProvider: params\.model\.provider\s*\}\);/g;
const AGENT_METADATA_SEMANTIC_CONTRACTS = [
  'const childEntry = params.sessionKey && childStorePath ? loadSessionEntry({',
  'const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";',
  'const storedSessionId = typeof childEntry?.sessionId === "string" ? childEntry.sessionId.trim() : "";',
  'const isSubagentSession = Boolean(',
  'typeof params.spawnedBy === "string" && params.spawnedBy.trim()',
  'typeof params.sessionKey === "string" && /:subagent:/i.test(params.sessionKey)',
  '[openclaw-agent-request-metadata] missing session_id; continuing without request metadata',
  '[openclaw-agent-request-metadata] missing parent_session_id; continuing without parent metadata',
  'const childEntryMatchesSession = storedSessionId === sessionId;',
  'const persistedParentSessionId = childEntryMatchesSession && typeof childEntry?.parentSessionId === "string"',
  'const parentSessionId = persistedParentSessionId && persistedParentSessionId !== sessionId',
  'session_id: sessionId,',
  'request_purpose: "agent"',
  'if (parentSessionId) payload.metadata.parent_session_id = parentSessionId;',
  'else delete payload.metadata.parent_session_id;',
  'if (firstRequest && userRuns?.delete(params.runId)) payload.metadata.user_initiated = true;',
  'else delete payload.metadata.user_initiated;',
];
const AGENT_METADATA_WRAPPER_PATTERN =
  /function wrapJustDoAgentRequestMetadata\(streamFn, params\) \{[\s\S]*?firstRequest = false;\s*\}\);\s*\}/g;

function extractAgentMetadataWrapper(content, filePath) {
  const matches = [...content.matchAll(AGENT_METADATA_WRAPPER_PATTERN)];
  if (matches.length !== 1) {
    throw new Error(`${filePath}: agent metadata wrapper body count is ${matches.length}`);
  }
  return matches[0][0];
}

function installAgentMetadataWrapperAfterProviderSetup(content, filePath) {
  const installations = [...content.matchAll(AGENT_METADATA_INSTALLATION_PATTERN)];
  if (installations.length > 1) {
    throw new Error(`${filePath}: agent metadata installation count is ${installations.length}`);
  }
  const withoutEarlyInstallation = content.replace(AGENT_METADATA_INSTALLATION_PATTERN, '');
  return replaceUniquePattern(
    withoutEarlyInstallation,
    /(applyExtraParamsToAgent\(activeSession\.agent, params\.config,[\s\S]*?nativeWebSearchPolicyContext\s*\n\s*\}\);)(\s*if \(codeModeControlsEnabledForRun\))/,
    `$1
      activeSession.agent.streamFn = wrapJustDoAgentRequestMetadata(activeSession.agent.streamFn, {
        sessionId: activeSession.sessionId || params.sessionId,
        runId: params.runId,
        sessionKey: params.sessionKey,
        spawnedBy: params.spawnedBy,
        storePath: params.storePath,
        config: params.config,
        modelApi: params.model.api,
        modelProvider: params.model.provider
      });$2`,
    `${filePath}: final agent metadata stream boundary`,
  );
}

function buildAgentMetadataWrapperFunction() {
  return `function wrapJustDoAgentRequestMetadata(streamFn, params) {
  const userRuns = globalThis[Symbol.for("justdo.litellm.user-runs")];
  if (!justDoLiteLLMProviderIds.has(params.modelProvider) || !justDoLiteLLMMetadataApis.has(params.modelApi)) {
    userRuns?.delete(params.runId);
    return streamFn;
  }
  const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
  const isSubagentSession = Boolean(
    typeof params.spawnedBy === "string" && params.spawnedBy.trim()
    || typeof params.sessionKey === "string" && /:subagent:/i.test(params.sessionKey)
  );
  if (!sessionId) {
    userRuns?.delete(params.runId);
    try {
      log$2.error(
        "[openclaw-agent-request-metadata] missing session_id; continuing without request metadata kind="
        + (isSubagentSession ? "subagent" : "agent")
        + " runId=" + (params.runId ?? "unknown")
        + " sessionKey=" + (params.sessionKey ?? "unknown")
      );
    } catch {}
    return streamFn;
  }
  const childAgentId = params.sessionKey
    ? resolveSessionAgentIds({ sessionKey: params.sessionKey, config: params.config }).sessionAgentId
    : void 0;
  const childStorePath = childAgentId ? resolveStorePath(params.config?.session?.store, { agentId: childAgentId }) : void 0;
  const childEntry = params.sessionKey && childStorePath ? loadSessionEntry({
    storePath: childStorePath,
    sessionKey: params.sessionKey
  }) : void 0;
  const storedSessionId = typeof childEntry?.sessionId === "string" ? childEntry.sessionId.trim() : "";
  const childEntryMatchesSession = storedSessionId === sessionId;
  const persistedParentSessionId = childEntryMatchesSession && typeof childEntry?.parentSessionId === "string"
    ? childEntry.parentSessionId.trim()
    : "";
  const parentSessionId = persistedParentSessionId && persistedParentSessionId !== sessionId
    ? persistedParentSessionId
    : void 0;
  if (isSubagentSession && !parentSessionId) {
    try {
      log$2.error(
        "[openclaw-agent-request-metadata] missing parent_session_id; continuing without parent metadata runId="
        + (params.runId ?? "unknown")
        + " sessionKey=" + (params.sessionKey ?? "unknown")
        + " sessionId=" + sessionId
      );
    } catch {}
  }
  let firstRequest = true;
  return (model, context, options) => streamWithPayloadPatch(streamFn, model, context, options, (payload) => {
    const existing = payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
      ? payload.metadata
      : {};
    payload.metadata = {
      ...existing,
      session_id: sessionId,
      request_purpose: "agent"
    };
    if (parentSessionId) payload.metadata.parent_session_id = parentSessionId;
    else delete payload.metadata.parent_session_id;
    if (firstRequest && userRuns?.delete(params.runId)) payload.metadata.user_initiated = true;
    else delete payload.metadata.user_initiated;
    firstRequest = false;
  });
}`;
}

function buildAgentMetadataWrapperBlock() {
  return `const justDoLiteLLMMetadataApis = ${SUPPORTED_APIS};
const justDoLiteLLMProviderIds = ${LITELLM_PROVIDERS};
// ${CAPABILITY}: provider payload
${buildAgentMetadataWrapperFunction()}
`;
}

function hasCanonicalAgentMetadataSemantics(content, filePath) {
  const wrapper = extractAgentMetadataWrapper(content, filePath);
  return AGENT_METADATA_SEMANTIC_CONTRACTS.every(contract => wrapper.includes(contract));
}

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
    if (!hasCanonicalAgentMetadataSemantics(content, filePath)) {
      throw new Error(
        `${filePath}: legacy agent metadata wrapper requires a clean runtime rebuild`,
      );
    }
    const normalized = installAgentMetadataWrapperAfterProviderSetup(content, filePath);
    for (const contract of [
      'resolveSessionAgentIds({ sessionKey: params.sessionKey, config: params.config }).sessionAgentId',
    ]) {
      if (!normalized.includes(contract)) {
        throw new Error(`${filePath}: partial agent metadata session scope (${contract})`);
      }
    }
    return normalized;
  }
  const updated = replaceUniquePattern(
    content,
    /async function loadAttemptSessionEntryAfterQuotaMaintenance\(params\) \{/,
    `${buildAgentMetadataWrapperBlock()}async function loadAttemptSessionEntryAfterQuotaMaintenance(params) {`,
    `${filePath}: metadata wrapper`,
  );

  return installAgentMetadataWrapperAfterProviderSetup(updated, filePath);
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
  const schemaFiles = findFilesContaining(runtimeDir, [
    'ChatSendParamsSchema',
    'systemInputProvenance:',
    'systemProvenanceReceipt:',
  ]);
  const registrationFiles = findFilesContaining(runtimeDir, ['userRuns.add(clientRunId)']);
  const wrapperFiles = findFilesContaining(runtimeDir, [
    'function wrapJustDoAgentRequestMetadata(',
  ]);
  const withBundle = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs'));
  const expected = withBundle ? 2 : 1;
  for (const [label, files] of [
    ['schema', schemaFiles],
    ['registration', registrationFiles],
    ['wrapper', wrapperFiles],
  ]) {
    if (files.length !== expected) {
      throw new Error(`${label} metadata target count is ${files.length}, expected ${expected}`);
    }
  }

  for (const filePath of schemaFiles) {
    if (
      !/justdoUserInitiated:\s*\w+\.Optional\(\w+\.Boolean\(\)\)/.test(
        fs.readFileSync(filePath, 'utf8'),
      )
    ) {
      throw new Error(`${filePath}: chat.send user initiation schema is missing`);
    }
  }

  for (const filePath of wrapperFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    const wrapper = extractAgentMetadataWrapper(content, filePath);
    for (const required of [
      'justDoLiteLLMProviderIds.has(params.modelProvider)',
      'userRuns?.delete(params.runId)',
      ...AGENT_METADATA_SEMANTIC_CONTRACTS,
      'resolveSessionAgentIds({ sessionKey: params.sessionKey, config: params.config }).sessionAgentId',
    ]) {
      if (!wrapper.includes(required)) {
        throw new Error(`${filePath}: agent metadata field is missing: ${required}`);
      }
    }
    for (const [label, contract] of [
      [
        'provider and API gate',
        /if \(!justDoLiteLLMProviderIds\.has\(params\.modelProvider\) \|\| !justDoLiteLLMMetadataApis\.has\(params\.modelApi\)\)\s*\{\s*userRuns\?\.delete\(params\.runId\);\s*return streamFn;\s*\}/,
      ],
      [
        'missing session fail-open log',
        /if \(!sessionId\)\s*\{[\s\S]*?try\s*\{\s*log[\w$]*\.error\([\s\S]*?missing session_id; continuing without request metadata[\s\S]*?\);\s*\}\s*catch\s*\{\s*\}\s*return streamFn;\s*\}/,
      ],
      [
        'missing parent fail-open log',
        /if \(isSubagentSession && !parentSessionId\)\s*\{\s*try\s*\{\s*log[\w$]*\.error\([\s\S]*?missing parent_session_id; continuing without parent metadata[\s\S]*?\);\s*\}\s*catch\s*\{\s*\}\s*\}/,
      ],
    ]) {
      if (!contract.test(wrapper)) {
        throw new Error(`${filePath}: agent metadata ${label} is missing`);
      }
    }
    const providerSetupIndex = content.indexOf(
      'applyExtraParamsToAgent(activeSession.agent, params.config',
    );
    const installationIndex = content.indexOf(
      'activeSession.agent.streamFn = wrapJustDoAgentRequestMetadata(activeSession.agent.streamFn',
    );
    const nextWrapperIndex = content.indexOf(
      'if (codeModeControlsEnabledForRun)',
      installationIndex,
    );
    if (
      [...content.matchAll(AGENT_METADATA_INSTALLATION_PATTERN)].length !== 1 ||
      providerSetupIndex < 0 ||
      installationIndex <= providerSetupIndex ||
      nextWrapperIndex <= installationIndex
    ) {
      throw new Error(`${filePath}: agent metadata is not the final provider setup boundary`);
    }
    for (const [label, lookup] of [
      [
        'child',
        /const childStorePath = childAgentId\s*\?\s*resolveStorePath[\w$]*\(params\.config\?\.session\?\.store,\s*\{\s*agentId:\s*childAgentId\s*\}\)\s*:\s*void 0/,
      ],
    ]) {
      if (!lookup.test(wrapper)) {
        throw new Error(`${filePath}: agent metadata ${label} session store lookup is missing`);
      }
    }
    for (const unsupported of [
      'resolveSessionAgentIds(params.sessionKey).agentId',
      'resolveSessionAgentIds(params.spawnedBy).agentId',
    ]) {
      if (wrapper.includes(unsupported)) {
        throw new Error(
          `${filePath}: agent metadata still includes unsupported code: ${unsupported}`,
        );
      }
    }
    for (const [label, allowlist] of [
      [
        'provider',
        /\bjustDoLiteLLMProviderIds\s*=\s*(?:\/\*[\s\S]*?\*\/\s*)?new Set\(\["builtin_models"\]\)/,
      ],
      [
        'API',
        /\bjustDoLiteLLMMetadataApis\s*=\s*(?:\/\*[\s\S]*?\*\/\s*)?new Set\(\["openai-completions"\]\)/,
      ],
    ]) {
      if (!allowlist.test(content)) {
        throw new Error(`${filePath}: agent metadata ${label} allowlist is not exact`);
      }
    }
  }
}

module.exports = { applyPatch, patchAgentStream, verifyPatch };
