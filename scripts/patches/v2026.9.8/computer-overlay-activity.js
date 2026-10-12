'use strict';

// Serialized into the native Gateway service. Keep this function self-contained.
async function computerOverlayInvoke(request, desktopTarget, invoke, id) {
  if (
    process.platform !== 'win32' ||
    desktopTarget !== 'native' ||
    typeof request.onComputerActivity !== 'function'
  )
    return await invoke();
  const input = request.params;
  const desktop =
    request.command === 'computer.act' &&
    !input.windowRef &&
    !input.elementRef &&
    !input.browserRef &&
    !input.pageRef;
  const clicks = ['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click'];
  const cursor =
    desktop &&
    [...clicks, 'mouse_move', 'left_click_drag', 'scroll', 'type', 'key'].includes(input.action);
  const emit = (phase, click = false) => {
    try {
      request.onComputerActivity({ v: 1, id, phase, cursor, click });
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
