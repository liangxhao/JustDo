'use strict';

// Capability: distinguish session compaction and model-backed exec review requests.
// Target: pristine openclaw@2026.8.1, which sends both as ordinary model completions.
// Scope: only streams already authenticated by patch 006 as builtin_models agent streams, plus
// builtin_models/openai-completions simple completions used by the exec reviewer.
// Safety: no third-party payload is widened; reviewer session identity is read via the native
// SQLite accessor, and user_initiated is always removed from maintenance/reviewer calls.
// Remove when: upstream exposes equivalent provider request-purpose metadata.

const fs = require('fs');
const path = require('path');
const {
  findFilesContaining,
  findMatchingDelimiter,
  replaceUniquePattern,
  writeIfChanged,
} = require('./_patch-utils.js');

const CONTRACT = 'JUSTDO_REQUEST_PURPOSE_METADATA_V2026_8_1';
const COMPACTION_HELPER = 'wrapJustDoCompactionRequestMetadata';
const SIMPLE_HELPER = 'prepareJustDoPurposeSimpleCompletionModel';
const REVIEWER_SESSION_HELPER = 'resolveJustDoReviewerSessionId';

const COMPACTION_BLOCK = `// ${CONTRACT}: context compaction requests.
function ${COMPACTION_HELPER}(streamFn) {
\tconst metadataStreams = globalThis[Symbol.for("justdo.builtin-models.metadata-streams")];
\tif (!streamFn || !(metadataStreams instanceof WeakSet) || !metadataStreams.has(streamFn)) return streamFn;
\treturn (model, context, options) => streamWithPayloadPatch(streamFn, model, context, options, (payload) => {
\t\tconst metadata = payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
\t\t\t? payload.metadata
\t\t\t: {};
\t\tif (typeof metadata.session_id !== "string" || !metadata.session_id.trim()) return;
\t\tpayload.metadata = { ...metadata, request_purpose: "context_compaction" };
\t\tdelete payload.metadata.user_initiated;
\t});
}`;

const SIMPLE_BLOCK = `// ${CONTRACT}: model-backed reviewer requests.
function ${SIMPLE_HELPER}(model, originalModel, purpose, sessionId) {
\tif (purpose !== "exec_review" || typeof sessionId !== "string" || !sessionId.trim()) return model;
\tif (originalModel?.provider !== "builtin_models" || originalModel?.api !== "openai-completions") return model;
\tconst runtime = getModelLlmRuntime(model);
\tconst registry = runtime?.registry ?? defaultApiRegistry;
\tconst sourceApi = model.api;
\tconst sourceProvider = registry.getApiProvider(sourceApi);
\tif (!sourceProvider) return model;
\tconst api = "justdo-purpose:" + encodeURIComponent(purpose) + ":" + encodeURIComponent(sessionId) + ":" + encodeURIComponent(sourceApi);
\tif (!registry.getApiProvider(api)) {
\t\tconst sourceStreamFn = (runtimeModel, context, options) => sourceProvider.streamSimple({ ...runtimeModel, api: sourceApi }, context, options);
\t\tconst streamFn = (runtimeModel, context, options) => streamWithPayloadPatch(sourceStreamFn, runtimeModel, context, options, (payload) => {
\t\t\tconst metadata = payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
\t\t\t\t? payload.metadata
\t\t\t\t: {};
\t\t\tpayload.metadata = { ...metadata, session_id: sessionId.trim(), request_purpose: purpose };
\t\t\tdelete payload.metadata.user_initiated;
\t\t});
\t\tregistry.registerApiProvider({ api, stream: streamFn, streamSimple: streamFn }, "justdo-request-purpose");
\t}
\tconst prepared = { ...model, api };
\treturn runtime ? bindModelLlmRuntime(prepared, runtime) : prepared;
}`;

const REVIEWER_SESSION_BLOCK = `// ${CONTRACT}: reviewer session lookup through v8.1 SQLite state.
function ${REVIEWER_SESSION_HELPER}(input, agentId) {
\tconst sessionKey = typeof input?.agent?.sessionKey === "string" ? input.agent.sessionKey.trim() : "";
\tif (!sessionKey) return;
\ttry {
\t\tconst entry = loadJustDoReviewerSessionEntry({ agentId, sessionKey, readConsistency: "latest" });
\t\treturn typeof entry?.sessionId === "string" && entry.sessionId.trim() ? entry.sessionId.trim() : void 0;
\t} catch {
\t\treturn;
\t}
}`;

function isMonolith(filePath) {
  return (
    path.basename(filePath) === 'gateway-bundle.mjs' ||
    filePath.endsWith(path.join('worker', 'worker.mjs'))
  );
}

function expectedCount(runtimeDir) {
  return fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 3 : 2;
}

function resolveProviderStreamChunk(runtimeDir) {
  const files = findFilesContaining(runtimeDir, ['streamWithPayloadPatch as I', 'export {'], {
    includeBundle: false,
  }).filter(filePath => !filePath.endsWith(path.join('worker', 'worker.mjs')));
  if (files.length !== 1)
    throw new Error(`provider payload utility target count is ${files.length}, expected 1`);
  return path.basename(files[0]);
}

function resolveSessionAccessorChunk(runtimeDir) {
  const files = findFilesContaining(
    runtimeDir,
    ['function loadSessionEntry(scope)', 'loadSessionEntry as d'],
    { includeBundle: false },
  ).filter(filePath => !filePath.endsWith(path.join('worker', 'worker.mjs')));
  if (files.length !== 1)
    throw new Error(`reviewer SQLite accessor target count is ${files.length}, expected 1`);
  return path.basename(files[0]);
}

function findNamedFunctionRange(content, functionName, filePath) {
  const signature = `function ${functionName}(`;
  const signatureIndex = content.indexOf(signature);
  if (signatureIndex < 0 || content.indexOf(signature, signatureIndex + signature.length) >= 0)
    throw new Error(`${filePath}: ${functionName} target is missing or ambiguous`);
  const parameterStart = signatureIndex + signature.length - 1;
  const parameterEnd = findMatchingDelimiter(
    content,
    parameterStart,
    '(',
    ')',
    `${filePath}: ${functionName} parameters`,
  );
  let bodyStart = parameterEnd + 1;
  while (/\s/.test(content[bodyStart] ?? '')) bodyStart += 1;
  const bodyEnd = findMatchingDelimiter(
    content,
    bodyStart,
    '{',
    '}',
    `${filePath}: ${functionName} body`,
  );
  return {
    signatureIndex,
    parameterStart,
    parameterEnd,
    bodyStart,
    bodyEnd,
    parameter: content.slice(parameterStart + 1, parameterEnd).trim(),
    body: content.slice(bodyStart + 1, bodyEnd),
  };
}

function installPayloadHelper(content, runtimeDir, filePath, targetIndex, block) {
  let updated = content;
  if (!isMonolith(filePath)) {
    const chunk = resolveProviderStreamChunk(runtimeDir);
    updated = `import { I as streamWithPayloadPatch } from "./${chunk}";\n${updated}`;
    targetIndex = updated.indexOf(content.slice(targetIndex, targetIndex + 80));
  }
  return `${updated.slice(0, targetIndex)}${block}\n${updated.slice(targetIndex)}`;
}

function patchCompaction(content, runtimeDir, filePath) {
  if (content.includes(`function ${COMPACTION_HELPER}(`)) return content;
  const classPattern =
    /(?:var\s+)?AgentSessionCompaction\s*=\s*class\s+extends\s+[A-Za-z_$][\w$]*\s*\{/;
  const classMatch = classPattern.exec(content);
  if (!classMatch) throw new Error(`${filePath}: AgentSessionCompaction class is missing`);
  let updated = installPayloadHelper(
    content,
    runtimeDir,
    filePath,
    classMatch.index,
    COMPACTION_BLOCK,
  );
  const nextClassMatch = classPattern.exec(updated);
  const classBodyStart = nextClassMatch.index + nextClassMatch[0].lastIndexOf('{');
  const classBodyEnd = findMatchingDelimiter(
    updated,
    classBodyStart,
    '{',
    '}',
    `${filePath}: AgentSessionCompaction body`,
  );
  const classBody = updated.slice(classBodyStart + 1, classBodyEnd);
  const nativeCount = classBody.split('this.agent.streamFn').length - 1;
  if (nativeCount !== 2)
    throw new Error(`${filePath}: compaction stream target count is ${nativeCount}, expected 2`);
  const patchedBody = classBody.replace(
    /this\.agent\.streamFn/g,
    `${COMPACTION_HELPER}(this.agent.streamFn)`,
  );
  return `${updated.slice(0, classBodyStart + 1)}${patchedBody}${updated.slice(classBodyEnd)}`;
}

function patchSimpleCompletion(content, runtimeDir, filePath) {
  const functionName = 'completeWithPreparedSimpleCompletionModel';
  let range = findNamedFunctionRange(content, functionName, filePath);
  let updated = content;
  if (!updated.includes(`function ${SIMPLE_HELPER}(`)) {
    updated = installPayloadHelper(
      updated,
      runtimeDir,
      filePath,
      range.signatureIndex - 6,
      SIMPLE_BLOCK,
    );
    range = findNamedFunctionRange(updated, functionName, filePath);
  }
  if (range.body.includes(`${SIMPLE_HELPER}(`)) return updated;
  if (!/^[A-Za-z_$][\w$]*$/.test(range.parameter))
    throw new Error(`${filePath}: simple completion parameter is unknown`);
  const completionModel = /\b([A-Za-z_$][\w$]*)\s*=\s*prepareModelForSimpleCompletion\(/.exec(
    range.body,
  )?.[1];
  if (!completionModel) throw new Error(`${filePath}: prepared simple completion model is unknown`);
  const patchedBody = replaceUniquePattern(
    range.body,
    /\b(?:const|let)\s*\{\s*reasoning:/,
    match =>
      `${completionModel} = ${SIMPLE_HELPER}(${completionModel}, ${range.parameter}.model, ${range.parameter}.requestPurpose, ${range.parameter}.sessionId);\n${match}`,
    `${filePath}: reviewer purpose model boundary`,
  );
  return `${updated.slice(0, range.bodyStart + 1)}${patchedBody}${updated.slice(range.bodyEnd)}`;
}

function patchExecReviewer(content, runtimeDir, filePath) {
  const functionName = 'createModelExecAutoReviewer';
  let range = findNamedFunctionRange(content, functionName, filePath);
  let updated = content;
  if (!updated.includes(`function ${REVIEWER_SESSION_HELPER}(`)) {
    if (isMonolith(filePath)) {
      updated = `${updated.slice(0, range.signatureIndex)}const loadJustDoReviewerSessionEntry = loadSessionEntry;\n${REVIEWER_SESSION_BLOCK}\n${updated.slice(range.signatureIndex)}`;
    } else {
      const chunk = resolveSessionAccessorChunk(runtimeDir);
      updated = `import { d as loadJustDoReviewerSessionEntry } from "./${chunk}";\n${updated}`;
      const index = updated.indexOf(`function ${functionName}(`);
      updated = `${updated.slice(0, index)}${REVIEWER_SESSION_BLOCK}\n${updated.slice(index)}`;
    }
    range = findNamedFunctionRange(updated, functionName, filePath);
  }
  if (
    range.body.includes('requestPurpose: "exec_review"') ||
    range.body.includes('requestPurpose:`exec_review`')
  )
    return updated;
  if (!/^[A-Za-z_$][\w$]*$/.test(range.parameter))
    throw new Error(`${filePath}: exec reviewer parameter is unknown`);
  const escapedParameter = range.parameter.replace(/[$]/g, '\\$&');
  const cfg = new RegExp(`\\b([A-Za-z_$][\\w$]*)\\s*=\\s*${escapedParameter}\\.cfg\\b`).exec(
    range.body,
  )?.[1];
  const agentId = new RegExp(
    `\\b([A-Za-z_$][\\w$]*)\\s*=\\s*${escapedParameter}\\.agentId\\s*\\?\\?`,
  ).exec(range.body)?.[1];
  const reviewerInput = /return\s+async\s+(?:\(\s*)?([A-Za-z_$][\w$]*)(?:\s*\))?\s*=>/.exec(
    range.body,
  )?.[1];
  if (!cfg || !agentId || !reviewerInput)
    throw new Error(`${filePath}: exec reviewer variables are unknown`);
  const escapedCfg = cfg.replace(/[$]/g, '\\$&');
  const callPattern = new RegExp(`\\b${escapedCfg},\\s*context:`);
  const patchedBody = replaceUniquePattern(
    range.body,
    callPattern,
    `${cfg}, sessionId: ${REVIEWER_SESSION_HELPER}(${reviewerInput}, ${agentId}), requestPurpose: "exec_review", context:`,
    `${filePath}: exec reviewer request purpose`,
  );
  return `${updated.slice(0, range.bodyStart + 1)}${patchedBody}${updated.slice(range.bodyEnd)}`;
}

function targets(runtimeDir) {
  return {
    compaction: findFilesContaining(runtimeDir, [
      'AgentSessionCompaction',
      'this.agent.streamFn',
      'session_before_compact',
    ]),
    simple: findFilesContaining(runtimeDir, [
      'function completeWithPreparedSimpleCompletionModel(',
      'prepareModelForSimpleCompletion',
      'completeSimple',
    ]),
    reviewer: findFilesContaining(runtimeDir, [
      'function createModelExecAutoReviewer(',
      'EXEC_REVIEWER_MAX_TOKENS',
    ]),
  };
}

function assertTargets(runtimeDir, files) {
  const expected = expectedCount(runtimeDir);
  for (const key of ['compaction', 'simple', 'reviewer']) {
    if (files[key].length !== expected)
      throw new Error(`${key} purpose target count is ${files[key].length}, expected ${expected}`);
  }
}

function applyPatch(runtimeDir) {
  const files = targets(runtimeDir);
  assertTargets(runtimeDir, files);
  const transforms = new Map();
  const add = (filePath, transform) =>
    transforms.set(filePath, [...(transforms.get(filePath) ?? []), transform]);
  for (const filePath of files.compaction) add(filePath, patchCompaction);
  for (const filePath of files.simple) add(filePath, patchSimpleCompletion);
  for (const filePath of files.reviewer) add(filePath, patchExecReviewer);
  const changed = [];
  for (const [filePath, fileTransforms] of transforms) {
    const original = fs.readFileSync(filePath, 'utf8');
    const updated = fileTransforms.reduce(
      (current, transform) => transform(current, runtimeDir, filePath),
      original,
    );
    if (writeIfChanged(filePath, original, updated))
      changed.push(path.relative(runtimeDir, filePath));
  }
  return changed;
}

function verifyPatch(runtimeDir) {
  const files = targets(runtimeDir);
  assertTargets(runtimeDir, files);
  for (const filePath of files.compaction) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const required of [
      `function ${COMPACTION_HELPER}(`,
      'metadataStreams.has(streamFn)',
      'request_purpose: "context_compaction"',
    ])
      if (!content.includes(required)) throw new Error(`${filePath}: missing ${required}`);
    if (!/delete\s+[A-Za-z_$][\w$]*\.metadata\.user_initiated/.test(content))
      throw new Error(`${filePath}: compaction request retains user initiation metadata`);
    if (
      (content.match(new RegExp(`${COMPACTION_HELPER}\\(this\\.agent\\.streamFn\\)`, 'g')) ?? [])
        .length !== 2
    )
      throw new Error(`${filePath}: both compaction stream paths are not isolated`);
  }
  for (const filePath of files.simple) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const required of [
      `function ${SIMPLE_HELPER}(`,
      'originalModel?.provider !== "builtin_models"',
      'originalModel?.api !== "openai-completions"',
      'session_id: sessionId.trim()',
      'request_purpose: purpose',
    ])
      if (!content.includes(required)) throw new Error(`${filePath}: missing ${required}`);
  }
  for (const filePath of files.reviewer) {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const required of [
      `function ${REVIEWER_SESSION_HELPER}(`,
      'readConsistency: "latest"',
      'requestPurpose: "exec_review"',
    ])
      if (!content.includes(required)) throw new Error(`${filePath}: missing ${required}`);
    const helperStart = content.indexOf(`function ${REVIEWER_SESSION_HELPER}(`);
    const reviewerStart = content.indexOf('function createModelExecAutoReviewer(', helperStart);
    if (content.slice(helperStart, reviewerStart).includes('sessions.json'))
      throw new Error(
        `${filePath}: reviewer purpose patch contains a legacy sessions.json dependency`,
      );
  }
}

module.exports = {
  applyPatch,
  patchCompaction,
  patchExecReviewer,
  patchSimpleCompletion,
  verifyPatch,
  __testing: { COMPACTION_BLOCK, CONTRACT, REVIEWER_SESSION_BLOCK, SIMPLE_BLOCK },
};
