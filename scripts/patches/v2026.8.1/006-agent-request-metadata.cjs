'use strict';

// Capability: attach stable agent session/parent metadata and one-shot human initiation evidence.
// Target: pristine openclaw@2026.8.1, which does not publish these fields to provider payloads.
// Scope: chat.send admission plus the builtin_models/openai-completions provider boundary only.
// Safety: parent identity is read through v8.1's SQLite session accessor. Third-party providers
// receive no added metadata, and a human-run marker is consumed by its first model request only.
// Remove when: upstream exposes equivalent authenticated provider request metadata.

const fs = require('fs');
const path = require('path');
const {
  findFilesContaining,
  findMatchingDelimiter,
  replaceUniquePattern,
  writeIfChanged,
} = require('./_patch-utils.js');

const CONTRACT = 'JUSTDO_AGENT_REQUEST_METADATA_V2026_8_1';
const ACCESSOR_ALIAS = 'loadJustDoSessionEntry';
const TRANSPORT_FUNCTION = 'prepareEmbeddedAttemptTransport';
const SUPPORTED_APIS = 'new Set(["openai-completions"])';
const SUPPORTED_PROVIDERS = 'new Set(["builtin_models"])';
const HUMAN_RUN_ADMISSION_PATTERN =
  /if\s*\(\s*[A-Za-z_$][\w$]*\.justdoUserInitiated\s*===\s*true\s*\)\s*\{[\s\S]*?humanRuns\.add\(clientRunId\);[\s\S]*?\}/;

const WRAPPER = `const justDoAgentMetadataApis = ${SUPPORTED_APIS};
const justDoAgentMetadataProviders = ${SUPPORTED_PROVIDERS};
// ${CONTRACT}: built-in model service payload only.
function wrapJustDoAgentRequestMetadata(streamFn, params) {
\tconst humanRuns = globalThis[Symbol.for("justdo.builtin-models.human-runs")];
\tif (!justDoAgentMetadataProviders.has(params.modelProvider) || !justDoAgentMetadataApis.has(params.modelApi)) {
\t\thumanRuns?.delete(params.runId);
\t\treturn streamFn;
\t}
\tconst sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
\tif (!sessionId) {
\t\thumanRuns?.delete(params.runId);
\t\treturn streamFn;
\t}
\tlet childEntry;
\tif (params.sessionKey) try {
\t\tchildEntry = ${ACCESSOR_ALIAS}({
\t\t\tagentId: params.agentId,
\t\t\tsessionKey: params.sessionKey,
\t\t\tstorePath: params.storePath,
\t\t\treadConsistency: "latest"
\t\t});
\t} catch {}
\tconst storedSessionId = typeof childEntry?.sessionId === "string" ? childEntry.sessionId.trim() : "";
\tconst persistedParentSessionId = storedSessionId === sessionId && typeof childEntry?.parentSessionId === "string"
\t\t? childEntry.parentSessionId.trim()
\t\t: "";
\tconst parentSessionId = persistedParentSessionId && persistedParentSessionId !== sessionId
\t\t? persistedParentSessionId
\t\t: void 0;
\tlet firstRequest = true;
\tconst wrapped = (model, context, options) => streamWithPayloadPatch(streamFn, model, context, options, (payload) => {
\t\tconst existing = payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
\t\t\t? payload.metadata
\t\t\t: {};
\t\tpayload.metadata = { ...existing, session_id: sessionId, request_purpose: "agent" };
\t\tif (parentSessionId) payload.metadata.parent_session_id = parentSessionId;
\t\telse delete payload.metadata.parent_session_id;
\t\tif (firstRequest && humanRuns?.delete(params.runId)) payload.metadata.user_initiated = true;
\t\telse delete payload.metadata.user_initiated;
\t\tfirstRequest = false;
\t});
\tconst metadataStreams = globalThis[Symbol.for("justdo.builtin-models.metadata-streams")] ??= new WeakSet();
\tmetadataStreams.add(wrapped);
\treturn wrapped;
}`;

function expectedCounts(runtimeDir) {
  const withBundle = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs'));
  return {
    schema: withBundle ? 3 : 2,
    registration: withBundle ? 2 : 1,
    stream: withBundle ? 3 : 2,
  };
}

function patchSchema(content, filePath) {
  if (content.includes('justdoUserInitiated:')) return content;
  const objectPattern =
    /(systemInputProvenance:\s*([A-Za-z_$][\w$]*)\.Optional\(InputProvenanceSchema\),\s*)(systemProvenanceReceipt:)/;
  if (objectPattern.test(content)) {
    return replaceUniquePattern(
      content,
      objectPattern,
      (_match, prefix, typebox, suffix) =>
        `${prefix}justdoUserInitiated: ${typebox}.Optional(${typebox}.Boolean()),\n${suffix}`,
      `${filePath}: chat.send human initiation schema`,
    );
  }
  return replaceUniquePattern(
    content,
    /(systemInputProvenance:\s*([A-Za-z_$][\w$]*)\(InputProvenanceSchema\),\s*)(systemProvenanceReceipt:[\s\S]*?suppressCommandInterpretation:\s*\2\(([A-Za-z_$][\w$]*)\(\)\))/,
    (_match, prefix, optional, suffix, boolean) =>
      `${prefix}justdoUserInitiated:${optional}(${boolean}()),${suffix}`,
    `${filePath}: worker chat.send human initiation schema`,
  );
}

function patchChatRegistration(content, filePath) {
  if (HUMAN_RUN_ADMISSION_PATTERN.test(content)) return content;
  return replaceUniquePattern(
    content,
    /(\b[A-Za-z_$][\w$]*\.addChatRun\(clientRunId,\s*\{\s*sessionKey,)/,
    `// ${CONTRACT}: human run admission
\t\tif (p.justdoUserInitiated === true) {
\t\t\tconst humanRuns = globalThis[Symbol.for("justdo.builtin-models.human-runs")] ??= new Set();
\t\t\thumanRuns.add(clientRunId);
\t\t\tif (humanRuns.size > 4096) humanRuns.delete(humanRuns.values().next().value);
\t\t}
\t\t$1`,
    `${filePath}: chat.send human run admission`,
  );
}

function resolveAccessorImport(runtimeDir) {
  const files = findFilesContaining(
    runtimeDir,
    ['function loadSessionEntry(scope)', 'loadSessionEntry as d'],
    { includeBundle: false },
  ).filter(filePath => !filePath.endsWith(path.join('worker', 'worker.mjs')));
  if (files.length !== 1)
    throw new Error(`SQLite session accessor target count is ${files.length}, expected 1`);
  return path.basename(files[0]);
}

function installAccessorAndWrapper(content, runtimeDir, filePath, functionIndex) {
  if (/function\s+wrapJustDoAgentRequestMetadata\(/.test(content)) return content;
  let updated = content;
  if (
    path.basename(filePath) === 'gateway-bundle.mjs' ||
    filePath.endsWith(path.join('worker', 'worker.mjs'))
  ) {
    updated = `${updated.slice(0, functionIndex)}const ${ACCESSOR_ALIAS} = loadSessionEntry;\n${WRAPPER}\n${updated.slice(functionIndex)}`;
  } else {
    const accessorFile = resolveAccessorImport(runtimeDir);
    updated = `import { d as ${ACCESSOR_ALIAS} } from "./${accessorFile}";\n${updated}`;
    const shiftedIndex = updated.indexOf(`async function ${TRANSPORT_FUNCTION}(`);
    updated = `${updated.slice(0, shiftedIndex)}${WRAPPER}\n${updated.slice(shiftedIndex)}`;
  }
  return updated;
}

function patchAgentStream(content, runtimeDir, filePath) {
  const signature = `async function ${TRANSPORT_FUNCTION}(`;
  let functionIndex = content.indexOf(signature);
  if (functionIndex < 0 || content.indexOf(signature, functionIndex + signature.length) >= 0)
    throw new Error(`${filePath}: transport function is missing or ambiguous`);
  let updated = installAccessorAndWrapper(content, runtimeDir, filePath, functionIndex);
  functionIndex = updated.indexOf(signature);
  const parameterStart = functionIndex + signature.length - 1;
  const parameterEnd = findMatchingDelimiter(
    updated,
    parameterStart,
    '(',
    ')',
    `${filePath}: transport parameters`,
  );
  const inputName = updated.slice(parameterStart + 1, parameterEnd).trim();
  if (!/^[A-Za-z_$][\w$]*$/.test(inputName))
    throw new Error(`${filePath}: transport input parameter is unknown`);
  let bodyStart = parameterEnd + 1;
  while (/\s/.test(updated[bodyStart] ?? '')) bodyStart += 1;
  const bodyEnd = findMatchingDelimiter(
    updated,
    bodyStart,
    '{',
    '}',
    `${filePath}: transport body`,
  );
  const body = updated.slice(bodyStart + 1, bodyEnd);
  const attemptName = new RegExp(
    `\\b([A-Za-z_$][\\w$]*)\\s*=\\s*${inputName.replace(/[$]/g, '\\$&')}\\.attempt\\b`,
  ).exec(body)?.[1];
  const sessionName = new RegExp(
    `\\b([A-Za-z_$][\\w$]*)\\s*=\\s*${inputName.replace(/[$]/g, '\\$&')}\\.session\\b`,
  ).exec(body)?.[1];
  if (!attemptName || !sessionName)
    throw new Error(`${filePath}: transport attempt/session variables are unknown`);
  const installationNeedle = `${sessionName}.agent.streamFn = wrapJustDoAgentRequestMetadata(`;
  if (body.includes(installationNeedle)) return updated;
  const installation = `${sessionName}.agent.streamFn = wrapJustDoAgentRequestMetadata(${sessionName}.agent.streamFn, {
\t\tsessionId: ${attemptName}.sessionId,
\t\trunId: ${attemptName}.runId,
\t\tsessionKey: ${attemptName}.sessionKey,
\t\tagentId: ${inputName}.sessionAgentId,
\t\tstorePath: ${attemptName}.sessionTarget?.storePath,
\t\tmodelApi: ${attemptName}.model.api,
\t\tmodelProvider: ${attemptName}.model.provider
\t});`;
  const patchedBody = replaceUniquePattern(
    body,
    /\b(?:const|let)\s+[A-Za-z_$][\w$]*\s*=\s*resolveCacheRetention\(/,
    match => `${installation}\n\t${match}`,
    `${filePath}: final provider metadata boundary`,
  );
  return `${updated.slice(0, bodyStart + 1)}${patchedBody}${updated.slice(bodyEnd)}`;
}

function targetFiles(runtimeDir) {
  return {
    schema: findFilesContaining(runtimeDir, [
      'ChatSendParamsSchema',
      'systemInputProvenance:',
      'systemProvenanceReceipt:',
    ]),
    registration: findFilesContaining(runtimeDir, [
      'addChatRun(clientRunId, {',
      'chatSendReceivedAtMs',
    ]),
    stream: findFilesContaining(runtimeDir, [
      `async function ${TRANSPORT_FUNCTION}(`,
      'streamWithPayloadPatch',
    ]),
  };
}

function assertTargetCounts(runtimeDir, files) {
  const expected = expectedCounts(runtimeDir);
  for (const key of ['schema', 'registration', 'stream']) {
    if (files[key].length !== expected[key])
      throw new Error(
        `${key} metadata target count is ${files[key].length}, expected ${expected[key]}`,
      );
  }
}

function applyPatch(runtimeDir) {
  const files = targetFiles(runtimeDir);
  assertTargetCounts(runtimeDir, files);
  const transforms = new Map();
  const add = (filePath, transform) => {
    transforms.set(filePath, [...(transforms.get(filePath) ?? []), transform]);
  };
  for (const filePath of files.schema) add(filePath, patchSchema);
  for (const filePath of files.registration) add(filePath, patchChatRegistration);
  for (const filePath of files.stream)
    add(filePath, (content, target) => patchAgentStream(content, runtimeDir, target));
  const changed = [];
  for (const [filePath, fileTransforms] of transforms) {
    const original = fs.readFileSync(filePath, 'utf8');
    const updated = fileTransforms.reduce(
      (current, transform) => transform(current, filePath),
      original,
    );
    if (writeIfChanged(filePath, original, updated))
      changed.push(path.relative(runtimeDir, filePath));
  }
  return changed;
}

function verifyPatch(runtimeDir) {
  const files = targetFiles(runtimeDir);
  assertTargetCounts(runtimeDir, files);
  for (const filePath of files.schema) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (
      !/justdoUserInitiated:\s*(?:[A-Za-z_$][\w$]*\.Optional\([A-Za-z_$][\w$]*\.Boolean\(\)\)|[A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\(\)\))/.test(
        content,
      )
    )
      throw new Error(`${filePath}: chat.send human initiation schema is missing`);
  }
  for (const filePath of files.registration) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (!HUMAN_RUN_ADMISSION_PATTERN.test(content))
      throw new Error(`${filePath}: human run admission is missing`);
  }
  for (const filePath of files.stream) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const required of [
      'new Set(["builtin_models"])',
      'new Set(["openai-completions"])',
      'session_id: sessionId',
      'parent_session_id = parentSessionId',
      'user_initiated = true',
      'request_purpose: "agent"',
      'metadataStreams.add(wrapped)',
      '.sessionTarget?.storePath',
      'readConsistency: "latest"',
    ]) {
      if (!content.includes(required)) throw new Error(`${filePath}: missing ${required}`);
    }
    const helperStart = content.indexOf('function wrapJustDoAgentRequestMetadata(');
    const transportStart = content.indexOf(`async function ${TRANSPORT_FUNCTION}(`, helperStart);
    if (content.slice(helperStart, transportStart).includes('sessions.json'))
      throw new Error(`${filePath}: metadata patch contains a legacy sessions.json dependency`);
    const installIndex = content.indexOf('.agent.streamFn = wrapJustDoAgentRequestMetadata(');
    const nextTransportStepIndex = content.indexOf('resolveAgentTransportOverride(', installIndex);
    if (installIndex < 0 || nextTransportStepIndex < installIndex)
      throw new Error(`${filePath}: metadata wrapper is outside the final provider boundary`);
  }
}

module.exports = {
  applyPatch,
  patchAgentStream,
  verifyPatch,
  __testing: { CONTRACT, SUPPORTED_APIS, SUPPORTED_PROVIDERS, WRAPPER },
};
