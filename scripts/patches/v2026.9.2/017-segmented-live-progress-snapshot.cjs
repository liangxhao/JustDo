'use strict';

// Capability: retain bounded, display-safe Thinking/Content segments in native run recovery.
// Target: openclaw@2026.9.2 progress snapshots and their Gateway visibility boundary.
// Scope: live text segment identity and bounded native in-flight history replay.
// Safety: no durable transcript cache; native limits and Tool ownership remain authoritative.
// Remove when: upstream progress replay retains independently identified live text segments.

const fs = require('fs');
const path = require('path');
const { transformSync } = require('esbuild');
const {
  findFilesContaining,
  findMatchingDelimiter,
  stableFunctionSource,
  writeIfChanged,
} = require('./_patch-utils.js');

const MARKER = 'JUSTDO_SEGMENTED_LIVE_PROGRESS_V2026_9_2';
const HELPER = 'justdoRetainLiveProgressSegment';

function justdoRetainLiveProgressSegment(progressSnapshot, progressEvent) {
  const progressContract = 'JUSTDO_SEGMENTED_LIVE_PROGRESS_V2026_9_2';
  const progressNext = progressSnapshot ?? { events: [], byteLength: 0, lastSeq: 0 };
  if (progressEvent.seq <= progressNext.lastSeq) return progressNext;
  progressNext.lastSeq = progressEvent.seq;
  const progressData = progressEvent.data ?? {};
  const progressPreamble = progressEvent.stream === 'item' && progressData.kind === 'preamble';
  const progressItemId = typeof progressData.itemId === 'string' ? progressData.itemId : '';
  const progressPreambleOwner =
    progressPreamble && progressItemId
      ? progressNext.events.find(
          progressCandidate =>
            progressCandidate.stream === 'item' &&
            progressCandidate.data?.kind === 'preamble' &&
            progressCandidate.data.itemId === progressItemId,
        )
      : undefined;
  const progressPrevious = progressPreambleOwner
    ? {
        id: progressPreambleOwner.data.progressSegmentId,
        stream: 'item',
        sourceItemId: progressItemId,
        commentary: false,
        firstSeq: progressPreambleOwner.data.progressSegmentFirstSeq,
        rawText: progressPreambleOwner.data.progressText,
        ts: progressPreambleOwner.data.progressSegmentStartedAt,
      }
    : progressNext.justdoTextSegment;
  const progressSameLane =
    progressPrevious?.stream === progressEvent.stream &&
    progressPrevious.sourceItemId === progressItemId &&
    progressPrevious.commentary === (progressData.phase === 'commentary') &&
    progressData.progressMessageStart !== true;
  const progressText = progressPreamble
    ? typeof progressData.progressText === 'string'
      ? progressData.progressText
      : null
    : typeof progressData.text === 'string'
      ? progressData.text
      : null;
  const progressDelta = typeof progressData.delta === 'string' ? progressData.delta : '';
  const progressRaw =
    progressText !== null && progressText.trim()
      ? progressText
      : progressSameLane && progressPrevious.rawText === null
        ? null
        : (progressSameLane ? progressPrevious.rawText : '') + progressDelta;
  const progressContinues = progressSameLane;
  const progressFirstSeq = progressContinues ? progressPrevious.firstSeq : progressEvent.seq;
  const progressIdentity = `${progressEvent.runId}:${progressEvent.stream}:${progressFirstSeq}`;
  const progressRemove = progressPredicate => {
    progressNext.events = progressNext.events.filter(
      progressCandidate => !progressPredicate(progressCandidate),
    );
    progressNext.byteLength = progressNext.events.reduce(
      (progressTotal, progressCandidate) => progressTotal + jsonUtf8Bytes(progressCandidate),
      0,
    );
  };
  const progressPreviousIdentity = progressContinues ? progressPrevious.id : null;
  const progressProjected =
    progressRaw === null
      ? { text: '', suppress: false }
      : progressEvent.stream === 'assistant' || progressPreamble
        ? projectLiveAssistantBufferedText(normalizeLiveAssistantBufferedText(progressRaw), {
            suppressLeadFragments: true,
          })
        : { text: progressRaw, suppress: !progressRaw.trim() };
  if (progressRaw === null || (!progressProjected.suppress && progressProjected.text.trim())) {
    // agentPayload is the caller's client-facing copy. Rebind its data instead
    // of mutating the original producer event's shared data object.
    progressEvent.data = {
      ...progressData,
      progressSegmentFirstSeq: progressFirstSeq,
      progressSegmentId: progressIdentity,
      progressSegmentStartedAt: progressContinues ? progressPrevious.ts : progressEvent.ts,
    };
  }
  // Keep bounded pending raw text privately, so delta-only NO_REPLY prefixes
  // can be suppressed as a whole without entering the public events array.
  const progressSegmentState = {
    contract: progressContract,
    id: progressIdentity,
    stream: progressEvent.stream,
    sourceItemId: progressItemId,
    commentary: progressData.phase === 'commentary',
    firstSeq: progressFirstSeq,
    rawText: progressRaw !== null && jsonUtf8Bytes(progressRaw) <= 65536 ? progressRaw : null,
    ts: progressContinues ? progressPrevious.ts : progressEvent.ts,
  };
  if (
    !progressNext.justdoTextSegment ||
    progressFirstSeq >= progressNext.justdoTextSegment.firstSeq
  ) {
    progressNext.justdoTextSegment = progressSegmentState;
  }
  if (progressPreviousIdentity)
    progressRemove(
      progressCandidate => progressCandidate.data?.progressSegmentId === progressPreviousIdentity,
    );
  if (progressSegmentState.rawText === null) return progressNext;
  if (progressProjected.suppress || !progressProjected.text.trim()) return progressNext;
  const progressStored = {
    runId: progressEvent.runId,
    seq: progressEvent.seq,
    stream: progressEvent.stream,
    ts: progressEvent.ts,
    data: {
      ...(progressPreamble
        ? { kind: 'preamble', progressText: progressProjected.text }
        : { text: progressProjected.text }),
      replace: true,
      progressSegmentFirstSeq: progressFirstSeq,
      progressSegmentId: progressIdentity,
      progressSegmentStartedAt: progressSegmentState.ts,
      ...(progressItemId ? { itemId: progressItemId } : {}),
      ...(typeof progressData.phase === 'string' ? { phase: progressData.phase } : {}),
    },
    ...(progressEvent.sessionKey ? { sessionKey: progressEvent.sessionKey } : {}),
    ...(progressEvent.agentId ? { agentId: progressEvent.agentId } : {}),
  };
  const progressBytes = jsonUtf8Bytes(progressStored);
  if (progressBytes > 65536) return progressNext;
  progressNext.events.push(progressStored);
  progressNext.byteLength += progressBytes;
  while (progressNext.events.length > 50 || progressNext.byteLength > 131072) {
    const progressOldest = progressNext.events.find(
      progressCandidate => progressCandidate.stream !== 'usage',
    );
    if (!progressOldest) break;
    const progressToolId =
      progressOldest.stream === 'tool' ? progressOldest.data?.toolCallId : null;
    progressRemove(progressCandidate =>
      progressToolId
        ? progressCandidate.stream === 'tool' &&
          progressCandidate.data?.toolCallId === progressToolId
        : progressCandidate === progressOldest,
    );
  }
  return progressNext;
}

function functionRange(content, name, filePath) {
  const matches = [...content.matchAll(new RegExp(`function ${name}\\(([^)]*)\\)\\s*\\{`, 'gu'))];
  if (matches.length !== 1)
    throw new Error(`${filePath}: ${name} target count is ${matches.length}, expected 1`);
  const match = matches[0];
  const bodyStart = match.index + match[0].lastIndexOf('{');
  const bodyEnd = findMatchingDelimiter(content, bodyStart, '{', '}', `${filePath}: ${name}`);
  return {
    start: match.index,
    bodyStart,
    bodyEnd,
    parameters: match[1],
    text: content.slice(match.index, bodyEnd + 1),
  };
}

function canonicalFunction(content) {
  return transformSync(content, { minifyWhitespace: true, minifySyntax: true }).code;
}

function transformProducer(content, filePath) {
  const range = functionRange(content, 'updateChatRunProgressSnapshot', filePath);
  const [snapshotName, eventName] = range.parameters.split(',').map(value => value.trim());
  const prefix =
    `if (${eventName}.stream === "thinking" || ${eventName}.stream === "assistant" || (${eventName}.stream === "item" && ${eventName}.data?.kind === "preamble")) return ${HELPER}(${snapshotName}, ${eventName});\n` +
    `if (${snapshotName} && (${eventName}.stream === "tool" || ${eventName}.stream === "item" || ${eventName}.stream === "lifecycle")) delete ${snapshotName}.justdoTextSegment;`;
  const helperSource = stableFunctionSource(justdoRetainLiveProgressSegment);
  if (content.includes(HELPER) || content.includes('JUSTDO_SEGMENTED_LIVE_PROGRESS')) {
    const helperRange = functionRange(content, HELPER, filePath);
    const body = content.slice(range.bodyStart + 1, range.bodyEnd).trimStart();
    const expectedPrefix = canonicalFunction(
      `function check(${snapshotName}, ${eventName}) { ${prefix} }`,
    );
    const markerCount = content.split(MARKER).length - 1;
    const prefixEnd = body.indexOf('.justdoTextSegment;') + '.justdoTextSegment;'.length;
    if (
      markerCount !== 1 ||
      canonicalFunction(helperRange.text) !== canonicalFunction(helperSource) ||
      prefixEnd < '.justdoTextSegment;'.length ||
      canonicalFunction(
        `function check(${snapshotName}, ${eventName}) { ${body.slice(0, prefixEnd)} }`,
      ) !== expectedPrefix
    ) {
      throw new Error(`${filePath}: historical or partial segmented progress patch detected`);
    }
    return content;
  }
  if (
    !range.text.includes('CHAT_RUN_PROGRESS_MAX_EVENTS') ||
    !range.text.includes('matchesPreamble') ||
    !range.text.includes('approvalReviewOutcome')
  ) {
    throw new Error(`${filePath}: pristine native progress snapshot contract missing`);
  }
  return (
    content.slice(0, range.start) +
    helperSource +
    '\n' +
    content.slice(range.start, range.bodyStart + 1) +
    '\n' +
    prefix +
    '\n' +
    content.slice(range.bodyStart + 1)
  );
}

function transformCaller(content, filePath) {
  const pattern =
    /if\s*\(recordsInFlightProgress && (!isAborted\d*) && !suppressHeartbeatToolEvents(?: && (\([^;]+?\)))?\)\s*(chatRunState\.recordProgressEvent\(clientRunId, agentPayload, recordsEmbeddedProgress \? "summary" : "full"\);)/gu;
  const matches = [...content.matchAll(pattern)];
  if (matches.length !== 1)
    throw new Error(
      `${filePath}: native progress visibility target count is ${matches.length}, expected 1`,
    );
  const match = matches[0];
  const guard =
    '((evt.stream !== "thinking" && evt.stream !== "assistant") || (isControlUiVisible && !shouldHideHeartbeatChatOutput(clientRunId, evt.runId)))';
  if (match[2]) {
    // esbuild removes redundant parentheses while bundling the current patch.
    // Compare parsed output, preserving all free identifiers and operators.
    if (
      canonicalFunction(`function check() { return ${match[2]}; }`) !==
      canonicalFunction(`function check() { return ${guard}; }`)
    )
      throw new Error(`${filePath}: historical or partial progress visibility guard detected`);
    return content;
  }
  return content.replace(
    pattern,
    `if (recordsInFlightProgress && ${match[1]} && !suppressHeartbeatToolEvents && ${guard}) ${match[3]}`,
  );
}

function transformThinkingBoundary(content, filePath) {
  if (path.basename(filePath) === 'worker.mjs')
    return transformWorkerThinkingBoundary(content, filePath);
  const range = functionRange(content, 'createStreamRendering', filePath);
  const body = range.text;
  const arrow = /const emitReasoningStream = \((\w+)\) => \{/u.exec(body);
  if (!arrow) throw new Error(`${filePath}: native Thinking emitter missing`);
  const arrowStart = arrow.index + arrow[0].lastIndexOf('{');
  const arrowEnd = findMatchingDelimiter(body, arrowStart, '{', '}', 'Thinking emitter');
  const emitter = body.slice(arrowStart + 1, arrowEnd);
  const stateMatch = /(\w+)\.lastStreamedReasoning = (\w+);/u.exec(emitter);
  if (!stateMatch) throw new Error(`${filePath}: native Thinking message state missing`);
  const stateName = stateMatch[1];
  const emitPattern =
    /emitAgentEvent\(\{\s*runId: params.runId,\s*stream: "thinking",\s*data: \{\s*text: (\w+),\s*delta(?:,\s*progressMessageStart: justdoProgressMessageStart)?\s*\}\s*\}\);/gu;
  const matches = [...emitter.matchAll(emitPattern)];
  if (matches.length !== 1)
    throw new Error(
      `${filePath}: native Thinking event target count is ${matches.length}, expected 1`,
    );
  const originalCall = `emitAgentEvent({runId: params.runId, stream: "thinking", data: {text: ${matches[0][1]}, delta}});`;
  const patchedCall =
    `const justdoProgressMessageStart = justdoThinkingMessageIndex !== ${stateName}.assistantMessageIndex;\n` +
    `justdoThinkingMessageIndex = ${stateName}.assistantMessageIndex;\n` +
    `emitAgentEvent({runId: params.runId, stream: "thinking", data: {text: ${matches[0][1]}, delta, progressMessageStart: justdoProgressMessageStart}});`;
  const declaration = 'let justdoThinkingMessageIndex = -1;';
  if (body.includes('justdoThinkingMessageIndex') || body.includes('justdoProgressMessageStart')) {
    const withoutCurrent = body
      .replace(declaration, '')
      .replace(
        new RegExp(
          `const justdoProgressMessageStart = justdoThinkingMessageIndex !== ${stateName}\\.assistantMessageIndex;\\s*justdoThinkingMessageIndex = ${stateName}\\.assistantMessageIndex;\\s*` +
            emitPattern.source,
        ),
        originalCall,
      );
    if (
      withoutCurrent.includes('justdoThinkingMessageIndex') ||
      withoutCurrent.includes('justdoProgressMessageStart')
    ) {
      throw new Error(`${filePath}: historical or partial Thinking boundary patch detected`);
    }
    const rebuilt = transformThinkingBoundary(
      content.slice(0, range.start) + withoutCurrent + content.slice(range.bodyEnd + 1),
      filePath,
    );
    if (
      canonicalFunction(functionRange(rebuilt, 'createStreamRendering', filePath).text) !==
      canonicalFunction(body)
    ) {
      throw new Error(`${filePath}: historical or partial Thinking boundary patch detected`);
    }
    return content;
  }
  const patchedEmitter = emitter.replace(emitPattern, patchedCall);
  const updatedBody =
    body.slice(0, arrow.index) +
    declaration +
    '\n' +
    body.slice(arrow.index, arrowStart + 1) +
    patchedEmitter +
    body.slice(arrowEnd);
  return content.slice(0, range.start) + updatedBody + content.slice(range.bodyEnd + 1);
}

function transformWorkerThinkingBoundary(content, filePath) {
  const range = functionRange(content, 'createStreamRendering', filePath);
  const declaration = 'let justdoThinkingMessageIndex=-1,justdoProgressMessageStart=false;';
  const body = range.text;
  const eventPattern =
    /emitAgentEvent\(\{runId:(\w+)\.runId,stream:`thinking`,data:\{text:(\w+),delta:(\w+)(?:,progressMessageStart:justdoProgressMessageStart)?\}\}\)/gu;
  const events = [...body.matchAll(eventPattern)];
  const stateMatch = /state:(\w+)/u.exec(range.parameters);
  if (events.length !== 1 || !stateMatch)
    throw new Error(`${filePath}: native worker Thinking contract missing`);
  const [match] = events;
  const stateName = stateMatch[1];
  const original = `emitAgentEvent({runId:${match[1]}.runId,stream:\`thinking\`,data:{text:${match[2]},delta:${match[3]}}})`;
  const replacement =
    `justdoProgressMessageStart=justdoThinkingMessageIndex!==${stateName}.assistantMessageIndex,` +
    `justdoThinkingMessageIndex=${stateName}.assistantMessageIndex,` +
    `emitAgentEvent({runId:${match[1]}.runId,stream:\`thinking\`,data:{text:${match[2]},delta:${match[3]},progressMessageStart:justdoProgressMessageStart}})`;
  if (body.includes('justdoThinkingMessageIndex') || body.includes('justdoProgressMessageStart')) {
    const restored = body.replace(declaration, '').replace(replacement, original);
    if (
      restored.includes('justdoThinkingMessageIndex') ||
      restored.includes('justdoProgressMessageStart')
    ) {
      throw new Error(`${filePath}: historical or partial worker Thinking boundary patch detected`);
    }
    return content;
  }
  const localBodyStart = range.bodyStart - range.start;
  const patched =
    body.slice(0, localBodyStart + 1) +
    declaration +
    body.slice(localBodyStart + 1).replace(original, replacement);
  return content.slice(0, range.start) + patched + content.slice(range.bodyEnd + 1);
}

function targets(runtimeDir) {
  return {
    producers: findFilesContaining(runtimeDir, ['function updateChatRunProgressSnapshot(']),
    callers: findFilesContaining(runtimeDir, [
      'recordsInFlightProgress',
      'chatRunState.recordProgressEvent(',
    ]),
    thinking: findFilesContaining(runtimeDir, ['function createStreamRendering(']),
  };
}

function processTargets(runtimeDir, verify) {
  const { producers, callers, thinking } = targets(runtimeDir);
  const expected = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  const expectedText =
    expected + (fs.existsSync(path.join(runtimeDir, 'dist', 'worker', 'worker.mjs')) ? 1 : 0);
  if (
    producers.length !== expectedText ||
    callers.length !== expected ||
    thinking.length !== expectedText
  ) {
    throw new Error(
      `segmented progress targets are ${producers.length}/${callers.length}/${thinking.length}, expected ${expectedText}/${expected}/${expectedText}`,
    );
  }
  const updates = new Map();
  for (const [files, transform] of [
    [producers, transformProducer],
    [callers, transformCaller],
    [thinking, transformThinkingBoundary],
  ]) {
    for (const filePath of files) {
      const original = updates.get(filePath)?.updated ?? fs.readFileSync(filePath, 'utf8');
      const updated = transform(original, filePath);
      updates.set(filePath, { original: updates.get(filePath)?.original ?? original, updated });
    }
  }
  const changed = [];
  const patchStates = [...updates.values()].map(({ original, updated }) => original === updated);
  if (!verify && patchStates.some(Boolean) && patchStates.some(value => !value)) {
    throw new Error(
      'historical or partially applied segmented live progress patch; rebuild the pristine runtime',
    );
  }
  for (const [filePath, { original, updated }] of updates) {
    if (verify && original !== updated)
      throw new Error(`${filePath}: segmented live progress patch missing`);
    if (!verify && writeIfChanged(filePath, original, updated))
      changed.push(path.relative(runtimeDir, filePath));
  }
  return changed;
}

module.exports = {
  applyPatch: runtimeDir => processTargets(runtimeDir, false),
  verifyPatch: runtimeDir => processTargets(runtimeDir, true),
  __testing: {
    MARKER,
    transformProducer,
    transformCaller,
    transformThinkingBoundary,
    justdoRetainLiveProgressSegment,
  },
};
