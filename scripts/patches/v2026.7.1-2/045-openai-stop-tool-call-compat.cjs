'use strict';

// Capability: preserve complete structured tool calls from noncompliant stop+text chat responses.
// Target: openclaw@2026.7.1-2 transport source and the post-install fresh gateway bundle.
// Scope: OpenAI-compatible Chat Completions parsers after final payload/tool projection.
// Safety: only strict JSON object calls with nonempty id/name and an actually advertised tool are promoted.
// Remove when: upstream safely accepts structured tool_calls alongside visible text and finish_reason=stop.

const fs = require('fs');
const path = require('path');
const { findFilesContaining, replaceUnique, writeIfChanged } = require('./_patch-utils.js');

const MARKER = 'JUSTDO_OPENAI_STOP_TOOL_CALL_COMPAT_V2026_7_1_2';

function isJustDoDispatchableStructuredToolCall(block, rawArguments, allowedToolNames) {
  if (
    block?.type !== 'toolCall' ||
    typeof block.id !== 'string' ||
    !block.id.trim() ||
    typeof block.name !== 'string' ||
    !block.name.trim() ||
    !(allowedToolNames instanceof Set) ||
    !allowedToolNames.has(block.name)
  )
    return false;
  if (typeof rawArguments !== 'string' || !rawArguments.trim()) return false;
  try {
    const parsed = JSON.parse(rawArguments);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function shouldPromoteJustDoStructuredToolCalls(
  stopReason,
  hasToolCalls,
  hasDispatchableStructuredToolCalls,
  hasVisibleText,
  sawStopFinishReason = true,
) {
  return Boolean(
    sawStopFinishReason &&
    stopReason === 'stop' &&
    hasToolCalls &&
    (!hasVisibleText || hasDispatchableStructuredToolCalls),
  );
}

const TRANSPORT_HELPERS = `// ${MARKER}
${isJustDoDispatchableStructuredToolCall.toString()}
${shouldPromoteJustDoStructuredToolCalls.toString()}
`;

function transformTransport(content, filePath) {
  const isBundle = path.basename(filePath) === 'gateway-bundle.mjs';
  const contracts = [
    'function isJustDoDispatchableStructuredToolCall(',
    'function shouldPromoteJustDoStructuredToolCalls(',
    'allowedToolNames: new Set((params.tools ?? [])',
    'hasJustDoDispatchableStructuredToolCalls',
  ];
  const appliedCount = contracts.filter(contract => content.includes(contract)).length;
  const hasMarker = content.includes(`// ${MARKER}`);
  if (appliedCount === contracts.length && (isBundle || hasMarker)) return content;
  if (appliedCount > 0 || hasMarker) {
    const missing = contracts.filter(contract => !content.includes(contract));
    throw new Error(
      `${filePath}: partial OpenAI transport compatibility patch; missing ${missing.join(', ') || 'stable source marker'}`,
    );
  }
  let updated = replaceUnique(
    content,
    isBundle
      ? 'async function processOpenAICompletionsStream(responseStream, output, model, stream4, options) {'
      : 'async function processOpenAICompletionsStream(responseStream, output, model, stream, options) {',
    `${TRANSPORT_HELPERS}${
      isBundle
        ? 'async function processOpenAICompletionsStream(responseStream, output, model, stream4, options) {'
        : 'async function processOpenAICompletionsStream(responseStream, output, model, stream, options) {'
    }`,
    `${filePath}: OpenAI transport compatibility helper`,
  );
  updated = replaceUnique(
    updated,
    isBundle
      ? '          onFirstEventTimeout: getFirstStreamEventTimeoutHandler(options)\n        });'
      : 'onFirstEventTimeout: getFirstStreamEventTimeoutHandler(options)\n\t\t\t\t});',
    isBundle
      ? '          onFirstEventTimeout: getFirstStreamEventTimeoutHandler(options),\n          allowedToolNames: new Set((params.tools ?? []).map((tool) => tool?.function?.name).filter((name) => typeof name === "string" && name))\n        });'
      : 'onFirstEventTimeout: getFirstStreamEventTimeoutHandler(options),\n\t\t\t\t\tallowedToolNames: new Set((params.tools ?? []).map((tool) => tool?.function?.name).filter((name) => typeof name === "string" && name))\n\t\t\t\t});',
    `${filePath}: advertised transport tool names`,
  );
  return replaceUnique(
    updated,
    isBundle
      ? 'const hasVisibleText = output.content.some((block3) => block3.type === "text" && typeof block3.text === "string" && block3.text.trim().length > 0);\n  if (output.stopReason === "toolUse" && !hasToolCalls) output.stopReason = "stop";\n  if (sawStopFinishReason && output.stopReason === "stop" && hasToolCalls && !hasVisibleText) output.stopReason = "toolUse";'
      : 'const hasVisibleText = output.content.some((block) => block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0);\n\tif (output.stopReason === "toolUse" && !hasToolCalls) output.stopReason = "stop";\n\tif (sawStopFinishReason && output.stopReason === "stop" && hasToolCalls && !hasVisibleText) output.stopReason = "toolUse";',
    isBundle
      ? 'const hasVisibleText = output.content.some((block3) => block3.type === "text" && typeof block3.text === "string" && block3.text.trim().length > 0);\n  const hasJustDoDispatchableStructuredToolCalls = hasToolCalls && output.content.filter((block3) => block3.type === "toolCall").every((block3) => isJustDoDispatchableStructuredToolCall(block3, block3.partialArgs, options?.allowedToolNames));\n  if (output.stopReason === "toolUse" && !hasToolCalls) output.stopReason = "stop";\n  if (shouldPromoteJustDoStructuredToolCalls(output.stopReason, hasToolCalls, hasJustDoDispatchableStructuredToolCalls, hasVisibleText, sawStopFinishReason)) output.stopReason = "toolUse";'
      : 'const hasVisibleText = output.content.some((block) => block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0);\n\tconst hasJustDoDispatchableStructuredToolCalls = hasToolCalls && output.content.filter((block) => block.type === "toolCall").every((block) => isJustDoDispatchableStructuredToolCall(block, block.partialArgs, options?.allowedToolNames));\n\tif (output.stopReason === "toolUse" && !hasToolCalls) output.stopReason = "stop";\n\tif (shouldPromoteJustDoStructuredToolCalls(output.stopReason, hasToolCalls, hasJustDoDispatchableStructuredToolCalls, hasVisibleText, sawStopFinishReason)) output.stopReason = "toolUse";',
    `${filePath}: promote safe stop+text transport tool calls`,
  );
}

function transformBundledAiParser(content, filePath) {
  const contracts = [
    'const justDoAiAllowedToolNames = new Set((params.tools ?? [])',
    'const justDoAiStructuredToolCallArguments = /* @__PURE__ */ new WeakMap();',
    'recordJustDoAiStructuredToolCallArguments(block3);',
    'hasJustDoAiDispatchableStructuredToolCalls',
  ];
  const appliedCount = contracts.filter(contract => content.includes(contract)).length;
  if (appliedCount === contracts.length) return content;
  if (appliedCount > 0)
    throw new Error(`${filePath}: partial bundled @openclaw/ai compatibility patch detected`);
  let updated = replaceUnique(
    content,
    '          if (nextParams !== void 0) params = nextParams;\n          firstEventAbort = createFirstStreamEventAbortController(options?.signal);',
    '          if (nextParams !== void 0) params = nextParams;\n          const justDoAiAllowedToolNames = new Set((params.tools ?? []).map((tool) => tool?.function?.name).filter((name) => typeof name === "string" && name));\n          firstEventAbort = createFirstStreamEventAbortController(options?.signal);',
    `${filePath}: advertised bundled AI tool names`,
  );
  updated = replaceUnique(
    updated,
    '          const finishedBlocks = /* @__PURE__ */ new Set();\n          const contentIndices = /* @__PURE__ */ new WeakMap();',
    '          const finishedBlocks = /* @__PURE__ */ new Set();\n          const justDoAiStructuredToolCallArguments = /* @__PURE__ */ new WeakMap();\n          const recordJustDoAiStructuredToolCallArguments = (block3) => {\n            if (typeof block3?.partialArgs === "string") justDoAiStructuredToolCallArguments.set(block3, block3.partialArgs);\n          };\n          const contentIndices = /* @__PURE__ */ new WeakMap();',
    `${filePath}: bundled AI structured tool-call evidence`,
  );
  updated = replaceUnique(
    updated,
    '            else if (block3.type === "toolCall") {\n              block3.arguments = parseStreamingJson(block3.partialArgs);',
    '            else if (block3.type === "toolCall") {\n              recordJustDoAiStructuredToolCallArguments(block3);\n              block3.arguments = parseStreamingJson(block3.partialArgs);',
    `${filePath}: record bundled AI tool-call evidence`,
  );
  return replaceUnique(
    updated,
    '          const hasVisibleText = output.content.some((block3) => block3.type === "text" && block3.text.trim().length > 0);\n          if (output.stopReason === "toolUse" && !hasToolCalls) output.stopReason = "stop";\n          if (output.stopReason === "stop" && hasToolCalls && !hasVisibleText) output.stopReason = "toolUse";',
    '          const hasVisibleText = output.content.some((block3) => block3.type === "text" && block3.text.trim().length > 0);\n          const hasJustDoAiDispatchableStructuredToolCalls = hasToolCalls && output.content.filter((block3) => block3.type === "toolCall").every((block3) => block3.partialArgs === void 0 && isJustDoDispatchableStructuredToolCall(block3, justDoAiStructuredToolCallArguments.get(block3), justDoAiAllowedToolNames));\n          if (output.stopReason === "toolUse" && !hasToolCalls) output.stopReason = "stop";\n          if (shouldPromoteJustDoStructuredToolCalls(output.stopReason, hasToolCalls, hasJustDoAiDispatchableStructuredToolCalls, hasVisibleText)) output.stopReason = "toolUse";',
    `${filePath}: promote safe stop+text bundled AI tool calls`,
  );
}

function locateTargets(runtimeDir) {
  const unique = files => [...new Set(files)];
  const transport = unique([
    ...findFilesContaining(runtimeDir, [
      'async function processOpenAICompletionsStream(responseStream, output, model,',
      'sawStopFinishReason && output.stopReason === "stop"',
    ]),
    ...findFilesContaining(runtimeDir, [MARKER, 'hasJustDoDispatchableStructuredToolCalls']),
    ...findFilesContaining(runtimeDir, [
      'allowedToolNames: new Set((params.tools ?? [])',
      'hasJustDoDispatchableStructuredToolCalls',
    ]),
  ]);
  const bundledAi = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs'))
    ? unique([
        ...findFilesContaining(runtimeDir, [
          'let hasFinishReason = false;',
          'if (output.stopReason === "stop" && hasToolCalls && !hasVisibleText)',
          'Stream ended without finish_reason',
        ]),
        ...findFilesContaining(runtimeDir, [
          'justDoAiAllowedToolNames',
          'hasJustDoAiDispatchableStructuredToolCalls',
        ]),
      ]).filter(filePath => path.basename(filePath) === 'gateway-bundle.mjs')
    : [];
  const expectedTransport = fs.existsSync(path.join(runtimeDir, 'gateway-bundle.mjs')) ? 2 : 1;
  if (transport.length !== expectedTransport || bundledAi.length !== expectedTransport - 1)
    throw new Error(
      `OpenAI stop tool-call targets are transport=${transport.length}/${expectedTransport}, bundledAi=${bundledAi.length}/${expectedTransport - 1}`,
    );
  return { transport, bundledAi };
}

function applyPatch(runtimeDir) {
  const targets = locateTargets(runtimeDir);
  const transforms = new Map();
  for (const [name, transform] of [
    ['transport', transformTransport],
    ['bundledAi', transformBundledAiParser],
  ])
    for (const filePath of targets[name])
      transforms.set(filePath, [...(transforms.get(filePath) ?? []), transform]);
  const staged = [];
  for (const [filePath, fileTransforms] of transforms) {
    const original = fs.readFileSync(filePath, 'utf8');
    const updated = fileTransforms.reduce(
      (value, transform) => transform(value, filePath),
      original,
    );
    staged.push({ filePath, original, updated });
  }
  return staged
    .filter(item => writeIfChanged(item.filePath, item.original, item.updated))
    .map(item => path.relative(runtimeDir, item.filePath));
}

function verifyPatch(runtimeDir) {
  const targets = locateTargets(runtimeDir);
  for (const [name, files, contracts] of [
    [
      'transport',
      targets.transport,
      [
        'function isJustDoDispatchableStructuredToolCall(',
        'function shouldPromoteJustDoStructuredToolCalls(',
        'hasJustDoDispatchableStructuredToolCalls',
        'allowedToolNames: new Set((params.tools ?? [])',
      ],
    ],
    [
      'bundledAi',
      targets.bundledAi,
      ['hasJustDoAiDispatchableStructuredToolCalls', 'justDoAiAllowedToolNames'],
    ],
  ])
    for (const filePath of files) {
      const content = fs.readFileSync(filePath, 'utf8');
      for (const contract of contracts)
        if (!content.includes(contract))
          throw new Error(
            `${filePath}: OpenAI stop tool-call ${name} contract is missing ${contract}`,
          );
      if (
        name === 'transport' &&
        path.basename(filePath) !== 'gateway-bundle.mjs' &&
        !content.includes(`// ${MARKER}`)
      )
        throw new Error(`${filePath}: OpenAI transport source marker is missing`);
    }
}

module.exports = {
  applyPatch,
  verifyPatch,
  __testing: {
    isJustDoDispatchableStructuredToolCall,
    shouldPromoteJustDoStructuredToolCalls,
    transformTransport,
    transformBundledAiParser,
  },
};
