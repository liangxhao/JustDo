// Minimal pristine structural seams. Real parser semantics are exercised against
// the locked npm dependency separately, without copying its bundled Markdown code.
export const PRISTINE_REASONING_PARSER = `
function reduceReasoningText(text, codeSpans, state, options) {
  const output = [];
  const append = value => output.push(value);
  const start = options.start ?? 0;
  const scan = scanReasoningTags(text.slice(start), options.final);
  const tag = { text: '</think>' };
  if (options.mode === 'visible') append(tag.text);
  else output.length = 0;
  if (options.final && state.depth > 0 && state.pending) {
    const pending = state.pending;
    if ((options.mode === 'static-preserve' || options.mode === 'static-strict' &&
        !pending.visibleBefore && !pending.protectedClose ||
        options.mode === 'visible' && !pending.protectedClose) && options.recoverUnclosed !== false) append(pending.content);
  }
  return output;
}
function createReasoningTagTextPartitioner() {
  const reduction = { depth: 0, visibleEver: false };
  let strictMode = false;
  let holdStart;
  let emitted = 0;
  const reduceSafePrefix = text => reduceReasoningText(text, [], reduction, {
    final: false, mode: 'visible', scope: 'all'
  });
  const processBlock = text => {
    const finalizePending = () => reduceReasoningText('', [], reduction, {
      final: true, mode: strictMode ? 'hide' : 'visible', scope: 'all'
    });
    return reduceReasoningText(text, [], reduction, {
      final: true, mode: strictMode ? 'hide' : 'visible', scope: 'all'
    });
  };
  return {
    markStrict() { strictMode = true; holdStart ??= emitted; },
    pushVisible(text) { return reduceSafePrefix(text); },
    flush() { return processBlock(''); }
  };
}
`;
