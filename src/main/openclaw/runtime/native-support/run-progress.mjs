// Display-only observations. Native run admission, tools and terminal ownership stay unchanged.
export function observeRunStreamProgress(state, event, publish, now = Date.now()) {
  const type = event?.type;
  if (!['toolcall_start', 'toolcall_delta', 'toolcall_end', 'text_start', 'text_delta', 'text_end',
    'thinking_start', 'thinking_delta', 'thinking_end'].includes(type)) return;
  const progress = state.runProgressState ??= { calls: new Map(), receivedChars: 0, lastAt: -Infinity };
  const deltaChars = typeof event.delta === 'string' ? event.delta.length : 0;
  progress.receivedChars = Math.min(Number.MAX_SAFE_INTEGER, progress.receivedChars + deltaChars);
  let data = { kind: 'model', receivedChars: progress.receivedChars };
  const toolInput = type.startsWith('toolcall_');
  if (toolInput) {
    const content = event.partial?.content;
    const block = event.toolCall ?? (Number.isSafeInteger(event.contentIndex) && event.contentIndex >= 0 &&
      Array.isArray(content) ? content[event.contentIndex] : undefined);
    const toolCallId = typeof block?.id === 'string' ? block.id : '';
    const name = typeof block?.name === 'string' ? block.name : '';
    if (!toolCallId || toolCallId.length > 256 || !name || name.length > 256) return;
    let call = progress.calls.get(toolCallId);
    if (call?.complete) return;
    if (!call) {
      if (progress.calls.size >= 64) {
        const completed = [...progress.calls].find(([, value]) => value.complete);
        if (!completed) return;
        progress.calls.delete(completed[0]);
      }
      call = { receivedChars: 0, complete: false };
      progress.calls.set(toolCallId, call);
    }
    call.receivedChars = Math.min(Number.MAX_SAFE_INTEGER, call.receivedChars + deltaChars);
    call.complete = type === 'toolcall_end';
    data = { kind: 'tool-input', toolCallId, name,
      receivedChars: call.receivedChars, complete: call.complete };
  }
  // Bound transport work without repeatedly parsing or copying cumulative argument JSON.
  const boundary = type.endsWith('_start') || type.endsWith('_end');
  if (!boundary && now - progress.lastAt < 250) return;
  progress.lastAt = now;
  try { publish(data); } catch { /* Observations must never interrupt execution. */ }
}
