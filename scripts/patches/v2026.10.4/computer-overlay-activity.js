'use strict';

// Serialized into the native Gateway service. Keep this function self-contained.
async function computerOverlayInvoke(request, desktopTarget, invoke, id, execution) {
  if (
    process.platform !== 'win32' ||
    desktopTarget !== 'native' ||
    typeof request.onComputerActivity !== 'function'
  )
    return await invoke();
  // This identity belongs only to presentation, never to the native execution.
  const slot = Symbol.for('computer-overlay.activity');
  if (!execution[slot]) {
    const state = { id, closed: false, publish: request.onComputerActivity };
    const ownerSignal = request.ownerSignal;
    const close = () => {
      if (state.closed) return;
      state.closed = true;
      ownerSignal?.removeEventListener('abort', close);
      try {
        state.publish({
          v: 2,
          id: state.id,
          execution: state.id,
          phase: 'close',
          cursor: false,
          click: false,
        });
      } catch {
        /* Presentation cannot interfere with native cleanup. */
      }
    };
    const release = execution.releaseOwner;
    execution.releaseOwner = () => {
      close();
      return release();
    };
    execution[slot] = state;
    ownerSignal?.addEventListener('abort', close, { once: true });
    if (ownerSignal?.aborted) close();
  }
  const state = execution[slot];
  const input = request.params;
  const desktop =
    request.command === 'computer.act' &&
    !input.windowRef &&
    !input.elementRef &&
    !input.browserRef &&
    !input.pageRef;
  const clicks = ['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click'];
  const cursor =
    desktop && [...clicks, 'mouse_move', 'left_click_drag', 'scroll'].includes(input.action);
  const emit = (phase, click = false) => {
    try {
      if (!state.closed)
        request.onComputerActivity({ v: 2, id, execution: state.id, phase, cursor, click });
    } catch {
      /* Presentation must never change native execution. */
    }
  };
  emit('start');
  const heartbeat = setInterval(() => emit('start'), 5_000);
  heartbeat.unref?.();
  let click = false;
  try {
    const result = await invoke();
    if (desktop && clicks.includes(input.action) && result && typeof result === 'object') {
      try {
        click =
          result.ok === true &&
          result.details?.scope === 'desktop' &&
          result.effect !== 'suspected_noop' &&
          !result.escalation;
      } catch {
        /* Unknown outcomes have no click confirmation. */
      }
    }
    return result;
  } finally {
    clearInterval(heartbeat);
    emit('end', click);
  }
}

module.exports = { computerOverlayInvoke };
