'use strict';

// Capability: expose the actual native loop exit branch as content-free diagnostics.
// Target: v2026.9.8 core loop, lifecycle subscriber and deferred terminal metadata.
// Scope: event metadata only; never change continuation, retry, tool or settlement decisions.
// Safety: closed values only; only executionSettled establishes the whole-run outcome.
// Remove when: upstream publishes these facts through settled lifecycle events.
const fs = require('node:fs');
const path = require('node:path');
const {
  assertCurrentPatchContract,
  findFilesContaining,
  findMatchingDelimiter,
  isGatewayBundlePath,
  normalizeJustDoGatewayBundle,
  writeIfChanged,
} = require('./_patch-utils.js');
const CONTRACT = 'JUSTDO_LOOP_EXIT_DIAGNOSTICS_V2026_9_8';
const REASONS = [
  'abort_signal',
  'model_aborted',
  'tool_loop_guard',
  'model_error',
  'policy_stop',
  'handoff',
  'no_pending_work',
];
const SHAPES = ['thinking_only', 'empty', 'text', 'tool_call', 'other'];

function editFunction(content, name, edit) {
  const signature = `function ${name}(`;
  const start = content.indexOf(signature);
  if (start < 0 || content.indexOf(signature, start + 1) >= 0)
    throw new Error(`${name}: topology changed`);
  const open = content.indexOf('{', start);
  const end = findMatchingDelimiter(content, open, '{', '}', name);
  return content.slice(0, start) + edit(content.slice(start, end + 1)) + content.slice(end + 1);
}
function transform(content, file = '<runtime>') {
  assertCurrentPatchContract(content, CONTRACT, file, false);
  if (
    content.includes('justDoLoopExit') &&
    !content.includes(CONTRACT) &&
    !isGatewayBundlePath(file)
  )
    throw new Error(`${file}: partial patch without contract`);
  let result = content;
  if (result.includes('function runLoop('))
    result = editFunction(result, 'runLoop', body => {
      const events = [...body.matchAll(/type:\s*"agent_end",/g)];
      const guards = [
        'const stopIfAborted',
        'stopReason === "aborted"',
        'terminateRun)',
        'if (providerFailed)',
        'shouldStopAfterTurn',
        'if (nextTurnSnapshot?.stop)',
        'getFollowUpMessages',
      ];
      if (
        events.length !== 7 ||
        guards.some(
          (guard, i) => !body.slice(i ? events[i - 1].index : 0, events[i].index).includes(guard),
        )
      )
        throw new Error(`${file}: loop exit branches changed`);
      let index = 0;
      if (body.includes('justDoLoopExit')) {
        for (const [i, event] of events.entries())
          if (
            !new RegExp(`^type:\\s*"agent_end",\\s*justDoLoopExit:\\s*"${REASONS[i]}"`).test(
              body.slice(event.index),
            )
          )
            throw new Error(`${file}: partial loop exit patch`);
        return body;
      }
      return body.replace(
        /type:\s*"agent_end",/g,
        match => `${match} justDoLoopExit: "${REASONS[index++]}",`,
      );
    });
  if (result.includes('function handleAgentEnd('))
    result = editFunction(result, 'handleAgentEnd', body => {
      const marker = 'const emitLifecycleTerminal = () => {';
      const projection = `const justDoLoopExit = ${JSON.stringify(REASONS)}.includes(evt?.justDoLoopExit) ? evt.justDoLoopExit : undefined;
      const justDoBlocks = Array.isArray(lastAssistant?.content) ? lastAssistant.content : undefined;
      const justDoResponseShape = !justDoBlocks ? undefined : justDoBlocks.some(justDoResponseBlock => justDoResponseBlock?.type === "toolCall") ? "tool_call" : justDoBlocks.some(justDoResponseBlock => justDoResponseBlock?.type === "text" && typeof justDoResponseBlock.text === "string" && justDoResponseBlock.text.trim()) ? "text" : justDoBlocks.some(justDoResponseBlock => !["text", "thinking", "reasoning", "redacted_thinking"].includes(justDoResponseBlock?.type)) ? "other" : justDoBlocks.some(justDoResponseBlock => justDoResponseBlock?.type === "redacted_thinking" || (justDoResponseBlock?.type === "thinking" && justDoResponseBlock.thinking) || (justDoResponseBlock?.type === "reasoning" && (justDoResponseBlock.text || justDoResponseBlock.reasoning))) ? "thinking_only" : "empty";`;
      if (!body.includes(marker)) throw new Error(`${file}: lifecycle delivery boundary changed`);
      if (body.includes('const justDoLoopExit')) {
        const start = body.indexOf('const justDoLoopExit');
        const end = body.indexOf('finalizeToolActivity(', start);
        const canonical = text =>
          normalizeJustDoGatewayBundle(
            require('esbuild').transformSync(text, { loader: 'js', minifySyntax: true }).code,
          );
        if (end < 0 || canonical(body.slice(start, end)) !== canonical(projection))
          throw new Error(`${file}: partial lifecycle projection`);
        if (!/justDoLoopExit,\s*justDoResponseShape,/.test(body))
          throw new Error(`${file}: missing lifecycle fields`);
        return body;
      }
      if (body.includes('justDoResponseShape')) throw new Error(`${file}: partial projection`);
      const anchor =
        /\.\.\.\(?terminalStopReason\s*\?\s*\{\s*stopReason:\s*terminalStopReason\s*\}\s*:\s*\{\}\)?,/g;
      if ([...body.matchAll(anchor)].length !== 1)
        throw new Error(`${file}: lifecycle stop boundary changed`);
      return body
        .replace(marker, `${marker}\n${projection}`)
        .replace(anchor, match => `${match}\njustDoLoopExit, justDoResponseShape,`);
    });
  if (result.includes('DEFERRED_TERMINAL_METADATA_KEYS')) {
    const pattern = /DEFERRED_TERMINAL_METADATA_KEYS\s*=\s*\[([^\]]*)\]/g;
    const matches = [...result.matchAll(pattern)];
    if (matches.length !== 1 || !matches[0][1].includes('"assistantTranscriptIdempotencyKey"'))
      throw new Error(`${file}: deferred metadata boundary changed`);
    const list = matches[0][1];
    if (list.includes('justDoLoopExit') !== list.includes('justDoResponseShape'))
      throw new Error(`${file}: partial deferred metadata`);
    if (!list.includes('justDoLoopExit'))
      result = result.replace(
        pattern,
        (_all, keys) =>
          `DEFERRED_TERMINAL_METADATA_KEYS = ["justDoLoopExit", "justDoResponseShape",${keys}]`,
      );
  }
  if (result === content) {
    assertCurrentPatchContract(content, CONTRACT, file, !isGatewayBundlePath(file));
    return result;
  }
  if (content.includes(CONTRACT))
    throw new Error(`${file}: partial patch; rebuild pristine runtime`);
  const headerEnd = result.startsWith('#!') ? result.indexOf('\n') + 1 : 0;
  return result.slice(0, headerEnd) + `// ${CONTRACT}\n` + result.slice(headerEnd);
}
function processTargets(root, verify) {
  const signatures = [
    'function runLoop(',
    'function handleAgentEnd(',
    'DEFERRED_TERMINAL_METADATA_KEYS',
  ];
  const groups = signatures.map(signature => findFilesContaining(root, signature));
  const expected = fs.existsSync(path.join(root, 'gateway-bundle.mjs')) ? 3 : 2;
  if (groups.some(files => files.length !== expected))
    throw new Error(
      `Loop diagnostics topology changed: ${groups.map(files => files.length)}, expected ${expected}`,
    );
  return [...new Set(groups.flat())].flatMap(file => {
    const original = fs.readFileSync(file, 'utf8');
    const patched = transform(original, file);
    if (verify && patched !== original) throw new Error(`${file}: loop diagnostics patch missing`);
    return !verify && writeIfChanged(file, original, patched) ? [path.relative(root, file)] : [];
  });
}
module.exports = {
  applyPatch: root => processTargets(root, false),
  verifyPatch: root => processTargets(root, true),
  __testing: { transform, REASONS, SHAPES },
};
