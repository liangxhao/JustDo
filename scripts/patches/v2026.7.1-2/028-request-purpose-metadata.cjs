'use strict';

// Capability: isolate session-scoped compaction and exec-review provider metadata.
// Contract: native/safeguard compaction use context_compaction; reviewers use exec_review.
// Target: pristine openclaw@2026.7.1-2; patches real runtime call chains, not API aliases.
// Scope: only model.provider builtin_models over the OpenAI Chat Completions transport.
// Safety: custom/strict-compatible providers keep native egress; unrelated completions are untouched.
// Remove when: upstream supports session-scoped per-purpose metadata for all three paths.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUniquePattern, writeIfChanged } = require('./_patch-utils');

const COMPACTION_HELPER = 'wrapJustDoCompactionRequestMetadata';
const SIMPLE_HELPER = 'prepareJustDoMetadataSimpleCompletionModel';
const PROVIDERS = '["builtin_models"]';
const APIS = '["openai-completions"]';

function narrowMetadataAllowlist(content) {
  return content
    .replaceAll('["openai-completions", "openai-responses", "azure-openai-responses"]', APIS)
    .replaceAll('["builtin_models", "justdo"]', PROVIDERS);
}

function replaceExactCount(content, pattern, replacement, expected, label) {
  const matches = [...content.matchAll(pattern)];
  if (matches.length !== expected) {
    throw new Error(`${label}: target count is ${matches.length}, expected ${expected}`);
  }
  return content.replace(pattern, replacement);
}

function patchNativeCompaction(content, filePath) {
  if (content.includes(`function ${COMPACTION_HELPER}(`)) {
    for (const contract of [
      `${COMPACTION_HELPER}(streamFn, model, justDoSessionId)`,
      `${COMPACTION_HELPER}(this.agent.streamFn, this.model, this.sessionManager.getSessionId())`,
      'session_id: sessionId',
      'wrapJustDoCompactionTextStream',
    ]) {
      if (!content.includes(contract)) {
        throw new Error(`${filePath}: partial native compaction metadata patch (${contract})`);
      }
    }
    return narrowMetadataAllowlist(content);
  }
  let updated = replaceUniquePattern(
    content,
    /(import \{ i as streamSimple \} from "\.\/stream-[^"]+\.js";)/,
    '$1\nimport { N as streamWithPayloadPatch } from "./provider-stream-shared-B4Hm1tKd.js";',
    `${filePath}: compaction payload patch import`,
  );
  updated = replaceUniquePattern(
    updated,
    /(\/\*\* Converts agent-core Result values back to the legacy session compaction API shape\. \*\/)/,
    `const justDoLiteLLMCompactionProviders = new Set(${PROVIDERS});
const justDoLiteLLMCompactionApis = new Set(${APIS});
const justDoCompactionStreamListenerSymbol = Symbol.for("justdo.compaction-stream-listeners");
function wrapJustDoCompactionTextStream(stream, sessionId) {
\tif (!stream) return stream;
\tconst observeEvent = (event) => {
\t\tif (event?.type !== "text_delta" || typeof event.delta !== "string" || !event.delta) return;
\t\tconst listeners = globalThis[justDoCompactionStreamListenerSymbol];
\t\tconst listener = listeners instanceof Map ? listeners.get(sessionId) : void 0;
\t\tif (typeof listener === "function") listener(event.delta);
\t};
\tif (typeof stream.push === "function") {
\t\tconst originalPush = stream.push.bind(stream);
\t\ttry {
\t\t\tstream.push = (event) => {
\t\t\t\tobserveEvent(event);
\t\t\t\treturn originalPush(event);
\t\t\t};
\t\t} catch {}
\t\treturn stream;
\t}
\tif (typeof stream[Symbol.asyncIterator] !== "function") return stream;
\tconst originalIterator = stream[Symbol.asyncIterator].bind(stream);
\tconst observedIterator = async function* () {
\t\tfor await (const event of { [Symbol.asyncIterator]: originalIterator }) {
\t\t\tobserveEvent(event);
\t\t\tyield event;
\t\t}
\t};
\ttry { stream[Symbol.asyncIterator] = observedIterator; } catch { return stream; }
\treturn stream;
}
// justdo-compaction-request-metadata: shared native/safeguard egress wrapper.
function ${COMPACTION_HELPER}(streamFn, model, sessionId) {
\tif (!sessionId || !justDoLiteLLMCompactionProviders.has(model?.provider) || !justDoLiteLLMCompactionApis.has(model?.api)) return streamFn;
\tconst baseStreamFn = streamFn ?? streamSimple;
\treturn (runtimeModel, context, options) => wrapJustDoCompactionTextStream(streamWithPayloadPatch(baseStreamFn, runtimeModel, context, options, (payload) => {
\t\tconst metadata = payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata) ? payload.metadata : {};
\t\tpayload.metadata = { ...metadata, session_id: sessionId, request_purpose: "context_compaction" };
\t\tdelete payload.metadata.user_initiated;
\t}), sessionId);
}
$1`,
    `${filePath}: compaction metadata helper`,
  );
  updated = replaceUniquePattern(
    updated,
    /async function generateSummary\(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn\) \{\n\treturn unwrapCompactionResult\(await generateSummary\$1\(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, openClawAgentCoreRuntime\)\);\n\}/,
    `async function generateSummary(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, streamFn, justDoSessionId) {
\treturn unwrapCompactionResult(await generateSummary$1(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, thinkingLevel, ${COMPACTION_HELPER}(streamFn, model, justDoSessionId), openClawAgentCoreRuntime));
}`,
    `${filePath}: safeguard summary metadata entry`,
  );
  updated = replaceUniquePattern(
    updated,
    /compactionResult \?\?= unwrapCoreResult\(await compact\$1\(preparation, this\.model, auth\.apiKey, auth\.headers, options\.customInstructions, options\.signal, this\.thinkingLevel, this\.agent\.streamFn\)\);/,
    `compactionResult ??= unwrapCoreResult(await compact$1(preparation, this.model, auth.apiKey, auth.headers, options.customInstructions, options.signal, this.thinkingLevel, ${COMPACTION_HELPER}(this.agent.streamFn, this.model, this.sessionManager.getSessionId())));`,
    `${filePath}: native AgentSession compact metadata`,
  );
  return updated;
}

function patchSafeguardSummaryPipeline(content, filePath) {
  if (content.includes('params.justDoCompactionSessionId')) {
    if (
      !content.includes('void 0, void 0, justDoCompactionSessionId)') ||
      !content.includes('summary, params.justDoCompactionSessionId)')
    ) {
      throw new Error(`${filePath}: partial safeguard summary metadata patch`);
    }
    return content;
  }
  let updated = replaceUniquePattern(
    content,
    /summary = await retryAsync\(\(\) => generateSummary\(chunk, params\.model, params\.reserveTokens, params\.apiKey, params\.headers, params\.signal, effectiveInstructions, summary\),/,
    'summary = await retryAsync(() => generateSummary(chunk, params.model, params.reserveTokens, params.apiKey, params.headers, params.signal, effectiveInstructions, summary, params.justDoCompactionSessionId),',
    `${filePath}: every chunk and retry receives session identity`,
  );
  updated = replaceUniquePattern(
    updated,
    /function generateSummary\(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary\) \{\n\tif \(generateSummary\$1\.length >= 8\) return generateSummaryCompat\(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary\);\n\treturn generateSummaryCompat\(currentMessages, model, reserveTokens, apiKey, signal, customInstructions, previousSummary\);\n\}/,
    `function generateSummary(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, justDoCompactionSessionId) {
\tif (generateSummary$1.length >= 8) return generateSummaryCompat(currentMessages, model, reserveTokens, apiKey, headers, signal, customInstructions, previousSummary, void 0, void 0, justDoCompactionSessionId);
\treturn generateSummaryCompat(currentMessages, model, reserveTokens, apiKey, signal, customInstructions, previousSummary);
}`,
    `${filePath}: safeguard-to-native metadata contract`,
  );
  return updated;
}

function patchSafeguardCaller(content, filePath) {
  if (content.includes('justDoCompactionSessionId: params.justDoCompactionSessionId')) {
    const requestSites = content.match(/^\s*justDoCompactionSessionId,$/gm) ?? [];
    if (
      !content.includes('const justDoCompactionSessionId = ctx.sessionManager.getSessionId();') ||
      requestSites.length !== 3
    ) {
      throw new Error(`${filePath}: partial safeguard caller metadata patch`);
    }
    return content;
  }
  let updated = replaceUniquePattern(
    content,
    /(summarizationInstructions: params\.summarizationInstructions,\n\t\tpreviousSummary: void 0)/,
    '$1,\n\t\tjustDoCompactionSessionId: params.justDoCompactionSessionId',
    `${filePath}: summarizeInStages metadata propagation`,
  );
  updated = replaceUniquePattern(
    updated,
    /(const runtime = getCompactionSafeguardRuntime\(ctx\.sessionManager\);)/,
    '$1\n\t\tconst justDoCompactionSessionId = ctx.sessionManager.getSessionId();',
    `${filePath}: safeguard stable session identity`,
  );
  updated = replaceExactCount(
    updated,
    /(messages: [^\n]+,\n\s+model,\n)(\s+)apiKey,/g,
    '$1$2apiKey,\n$2justDoCompactionSessionId,',
    3,
    `${filePath}: safeguard summary request sites`,
  );
  return updated;
}

function patchSimpleCompletion(content, filePath) {
  if (content.includes(`function ${SIMPLE_HELPER}(`)) {
    for (const contract of [
      'justDoLiteLLMSimpleCompletionProviders.has(model?.provider)',
      'session_id: sessionId',
      '}), params.requestPurpose, params.sessionId);',
    ]) {
      if (!content.includes(contract)) {
        throw new Error(`${filePath}: partial exec-review simple completion patch (${contract})`);
      }
    }
    return narrowMetadataAllowlist(content);
  }
  let updated = replaceUniquePattern(
    content,
    /async function completeWithPreparedSimpleCompletionModel\(params\) \{/,
    `const justDoLiteLLMSimpleCompletionProviders = new Set(${PROVIDERS});
const justDoLiteLLMSimpleCompletionApis = new Set(${APIS});
// justdo-exec-review-request-metadata: isolate reviewer egress from generic completions.
function ${SIMPLE_HELPER}(model, purpose, sessionId) {
\tif (!purpose || !sessionId || !justDoLiteLLMSimpleCompletionProviders.has(model?.provider) || !justDoLiteLLMSimpleCompletionApis.has(model?.api)) return model;
\tconst provider = getApiProvider(model.api);
\tif (!provider) return model;
\tconst sourceApi = model.api;
\tconst sourceStreamFn = (runtimeModel, context, options) => provider.streamSimple({ ...runtimeModel, api: sourceApi }, context, options);
\tconst streamFn = (runtimeModel, context, options) => streamWithPayloadPatch(sourceStreamFn, runtimeModel, context, options, (payload) => {
\t\tconst metadata = payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata) ? payload.metadata : {};
\t\tpayload.metadata = { ...metadata, session_id: sessionId, request_purpose: purpose };
\t\tdelete payload.metadata.user_initiated;
\t});
\tconst api = "justdo-purpose:" + encodeURIComponent(purpose) + ":" + encodeURIComponent(sourceApi);
\tensureCustomApiRegistered(api, streamFn);
\treturn { ...model, api };
}
async function completeWithPreparedSimpleCompletionModel(params) {`,
    `${filePath}: exec-review simple completion helper`,
  );
  updated = replaceUniquePattern(
    updated,
    /const completionModel = prepareModelForSimpleCompletion\(\{\n\t\tmodel: params\.model,\n\t\tcfg: params\.cfg\n\t\}\);/,
    `const completionModel = ${SIMPLE_HELPER}(prepareModelForSimpleCompletion({
\t\tmodel: params.model,
\t\tcfg: params.cfg
\t}), params.requestPurpose, params.sessionId);`,
    `${filePath}: simple completion metadata installation`,
  );
  return updated;
}

function patchExecReviewer(content, filePath) {
  if (content.includes('requestPurpose: "exec_review"')) {
    if (!content.includes('sessionId: params.sessionId')) {
      throw new Error(`${filePath}: partial exec-review request metadata patch`);
    }
    return content;
  }
  return replaceUniquePattern(
    content,
    /(const result = await raceWithReviewerTimeout\(complete\(\{\n\t\t\t\tmodel: prepared\.model,\n\t\t\t\tauth: prepared\.auth,\n\t\t\t\tcfg,)/,
    '$1\n\t\t\t\tsessionId: params.sessionId,\n\t\t\t\trequestPurpose: "exec_review",',
    `${filePath}: exec-review request metadata`,
  );
}

function patchExecToolFactory(content, filePath) {
  if (
    content.includes('sessionId: defaults?.sessionId,\n\t\treviewer: resolveExecReviewerDefaults')
  )
    return content;
  return replaceUniquePattern(
    content,
    /(const autoReviewer = defaults\?\.autoReviewer \?\? createModelExecAutoReviewer\(\{\n\t\tcfg: defaults\?\.config,\n\t\tagentId,)/,
    '$1\n\t\tsessionId: defaults?.sessionId,',
    `${filePath}: agent exec reviewer session identity`,
  );
}

function patchHarnessFactory(content, filePath) {
  if (content.includes('sessionId: params.sessionId,\n\t\treviewer: params.reviewer'))
    return content;
  return replaceUniquePattern(
    content,
    /(return createModelExecAutoReviewer\(\{\n\t\tcfg: params\.cfg,\n\t\tagentId: params\.agentId,)/,
    '$1\n\t\tsessionId: params.sessionId,',
    `${filePath}: harness reviewer session identity`,
  );
}

function patchHarnessCaller(content, filePath) {
  if (content.includes('sessionId: params.paramsForRun.sessionId,\n\t\t\treviewer: reviewerConfig'))
    return content;
  return replaceUniquePattern(
    content,
    /(promise: reviewExecRequestWithConfiguredModel\(\{\n\t\t\tcfg: params\.paramsForRun\.config,\n\t\t\tagentId: params\.agentId \?\? params\.paramsForRun\.agentId,)/,
    '$1\n\t\t\tsessionId: params.paramsForRun.sessionId,',
    `${filePath}: app-server reviewer session identity`,
  );
}

function patchNodeReviewer(content, filePath) {
  if (content.includes('sessionId: parsed.execution.sessionId,')) return content;
  let updated = replaceUniquePattern(
    content,
    /(return createModelExecAutoReviewer\(\{\n\t\tcfg: params\.cfg,\n\t\tagentId: params\.agentId,)/,
    '$1\n\t\tsessionId: params.sessionId,',
    `${filePath}: node reviewer factory session identity`,
  );
  updated = replaceUniquePattern(
    updated,
    /(const decision = await \(await resolveSystemRunAutoReviewer\(\{\n\t\t\t\topts,\n\t\t\t\tcfg,\n\t\t\t\tagentId: parsed\.agentId,)/,
    '$1\n\t\t\t\tsessionId: parsed.execution.sessionId,',
    `${filePath}: node reviewer caller session identity`,
  );
  return updated;
}

function locateOne(runtimeDir, needles, label) {
  const files = findFilesContaining(runtimeDir, needles).filter(
    filePath => !filePath.endsWith('gateway-bundle.mjs'),
  );
  if (files.length !== 1)
    throw new Error(`${label} metadata target count is ${files.length}, expected 1`);
  return files[0];
}

function applyPatch(runtimeDir) {
  const targets = [
    [
      locateOne(
        runtimeDir,
        [
          'async function generateSummary(currentMessages, model, reserveTokens',
          'var AgentSession = class',
        ],
        'native compaction',
      ),
      patchNativeCompaction,
    ],
    [
      locateOne(
        runtimeDir,
        [
          'async function summarizeChunks(params)',
          'const generateSummaryCompat = generateSummary$1',
        ],
        'safeguard summary pipeline',
      ),
      patchSafeguardSummaryPipeline,
    ],
    [
      locateOne(
        runtimeDir,
        ['function compactionSafeguardExtension(api)', 'async function summarizeViaLLM(params)'],
        'safeguard caller',
      ),
      patchSafeguardCaller,
    ],
    [
      locateOne(
        runtimeDir,
        [
          'async function completeWithPreparedSimpleCompletionModel(params)',
          'ensureCustomApiRegistered',
        ],
        'simple completion',
      ),
      patchSimpleCompletion,
    ],
    [
      locateOne(
        runtimeDir,
        ['function createModelExecAutoReviewer(params)', 'EXEC_REVIEWER_MAX_TOKENS'],
        'exec reviewer',
      ),
      patchExecReviewer,
    ],
    [
      locateOne(
        runtimeDir,
        ['function createExecTool(defaults)', 'const autoReviewer = defaults?.autoReviewer'],
        'agent exec factory',
      ),
      patchExecToolFactory,
    ],
    [
      locateOne(
        runtimeDir,
        [
          'async function reviewExecRequestWithConfiguredModel(params)',
          'createModelExecAutoReviewer',
        ],
        'harness reviewer factory',
      ),
      patchHarnessFactory,
    ],
    [
      locateOne(
        runtimeDir,
        [
          'async function runInternalExecAutoReviewForApprovalRequest(params)',
          'reviewExecRequestWithConfiguredModel',
        ],
        'harness reviewer caller',
      ),
      patchHarnessCaller,
    ],
    [
      locateOne(
        runtimeDir,
        ['async function resolveSystemRunAutoReviewer(params)', 'parsed.execution'],
        'node reviewer',
      ),
      patchNodeReviewer,
    ],
  ];
  const transforms = new Map();
  for (const [filePath, transform] of targets)
    transforms.set(filePath, [...(transforms.get(filePath) ?? []), transform]);
  const staged = [];
  for (const [filePath, fileTransforms] of transforms) {
    const original = fs.readFileSync(filePath, 'utf8');
    const updated = fileTransforms.reduce(
      (current, transform) => transform(current, filePath),
      original,
    );
    staged.push({ filePath, original, updated });
  }
  return staged
    .filter(item => writeIfChanged(item.filePath, item.original, item.updated))
    .map(item => path.relative(runtimeDir, item.filePath));
}

function verifyPatch(runtimeDir) {
  const contracts = [
    [
      'native compaction',
      `function ${COMPACTION_HELPER}(`,
      [
        'session_id: sessionId',
        'request_purpose: "context_compaction"',
        'this.sessionManager.getSessionId()',
        'wrapJustDoCompactionTextStream',
      ],
    ],
    [
      'safeguard pipeline',
      'params.justDoCompactionSessionId',
      ['generateSummaryCompat(currentMessages', 'justDoCompactionSessionId'],
    ],
    [
      'safeguard caller',
      'justDoCompactionSessionId: params.justDoCompactionSessionId',
      ['ctx.sessionManager.getSessionId()', 'justDoCompactionSessionId,'],
    ],
    [
      'simple completion',
      `function ${SIMPLE_HELPER}(`,
      [
        'justDoLiteLLMSimpleCompletionProviders.has(model?.provider)',
        'session_id: sessionId',
        'request_purpose: purpose',
      ],
    ],
    ['exec reviewer', 'requestPurpose: "exec_review"', ['sessionId: params.sessionId']],
    [
      'agent exec factory',
      'sessionId: defaults?.sessionId,\n\t\treviewer: resolveExecReviewerDefaults',
      [],
    ],
    ['harness reviewer factory', 'sessionId: params.sessionId,\n\t\treviewer: params.reviewer', []],
    [
      'harness reviewer caller',
      'sessionId: params.paramsForRun.sessionId,\n\t\t\treviewer: reviewerConfig',
      [],
    ],
    [
      'node reviewer caller',
      'sessionId: parsed.execution.sessionId,',
      ['sessionId: params.sessionId'],
    ],
  ];
  for (const [label, marker, required] of contracts) {
    const files = findFilesContaining(runtimeDir, [marker]);
    if (files.length === 0) throw new Error(`${label} metadata contract is missing`);
    const combined = files.map(filePath => fs.readFileSync(filePath, 'utf8')).join('\n');
    for (const value of required)
      if (!combined.includes(value))
        throw new Error(`${label} metadata field is missing: ${value}`);
  }
  const isolationFiles = new Set([
    ...findFilesContaining(runtimeDir, [`function ${COMPACTION_HELPER}(`]),
    ...findFilesContaining(runtimeDir, [`function ${SIMPLE_HELPER}(`]),
  ]);
  const combined = [...isolationFiles]
    .map(filePath => fs.readFileSync(filePath, 'utf8'))
    .join('\n');
  for (const value of ['"builtin_models"', 'delete payload.metadata.user_initiated']) {
    if (!combined.includes(value))
      throw new Error(`LiteLLM metadata isolation is missing: ${value}`);
  }
  for (const unsupportedAllowlist of [
    '["builtin_models", "justdo"]',
    '["openai-completions", "openai-responses", "azure-openai-responses"]',
  ]) {
    if (combined.includes(unsupportedAllowlist))
      throw new Error(
        `LiteLLM metadata still includes unsupported allowlist: ${unsupportedAllowlist}`,
      );
  }
}

module.exports = {
  applyPatch,
  patchNativeCompaction,
  patchSafeguardCaller,
  patchSafeguardSummaryPipeline,
  patchSimpleCompletion,
  verifyPatch,
};
