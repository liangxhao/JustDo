/** Ephemeral presentation only: exact message objects own their one-shot motion. */
export interface SendMotionOrigin {
  left: number;
  top: number;
  width: number;
  height: number;
  document: Document;
}

const SEND_MOTION_DURATION = 520;
const SEND_MOTION_ADMISSION_WINDOW = 2_000;
const origins = new WeakMap<object, { origin: SendMotionOrigin; expiresAt: number }>();
const cleanups = new WeakMap<object, () => void>();
const refs = new WeakMap<object, (row: Element | undefined) => void>();

export function captureSendMotionOrigin(element: HTMLElement | null): SendMotionOrigin | undefined {
  if (!element?.isConnected) return undefined;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return undefined;
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    document: element.ownerDocument,
  };
}

export function registerSendMotion(message: object, origin?: SendMotionOrigin): void {
  if (origin) origins.set(message, { origin, expiresAt: Date.now() + SEND_MOTION_ADMISSION_WINDOW });
}

/** Stable callbacks prevent an unrelated streaming render from restarting a flight. */
export function sendMotionRef(message: object): (row: Element | undefined) => void {
  let callback = refs.get(message);
  if (!callback) {
    callback = row => playSendMotion(row, message);
    refs.set(message, callback);
  }
  return callback;
}

export function playSendMotion(row: Element | undefined, message: object): void {
  cleanups.get(message)?.();
  if (!row) return;
  const pending = origins.get(message);
  origins.delete(message);
  const origin = pending?.origin;
  const view = row.ownerDocument.defaultView;
  if (!origin || !pending || pending.expiresAt < Date.now() || origin.document !== row.ownerDocument || !view) return;
  row.setAttribute('data-send-motion-pending', '');
  row.setAttribute('data-send-motion-active', '');

  let frame = 0;
  let animation: Animation | undefined;
  let restore: (() => void) | undefined;
  let observer: MutationObserver | undefined;
  let timer = 0;
  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    view.cancelAnimationFrame(frame);
    view.clearTimeout(timer);
    animation?.cancel();
    restore?.();
    row.removeAttribute('data-send-motion-pending');
    row.removeAttribute('data-send-motion-active');
    observer?.disconnect();
    view.removeEventListener('resize', cleanup);
    row.ownerDocument.removeEventListener('scroll', cleanup, true);
    cleanups.delete(message);
  };
  cleanups.set(message, cleanup);

  // Lit refs run before children commit. Scroll anchoring also needs one layout frame.
  frame = view.requestAnimationFrame(() => {
    frame = view.requestAnimationFrame(() => {
      const bubble = row.querySelector<HTMLElement>('.chat-bubble--user');
      const parent = bubble?.parentElement;
      if (!row.isConnected || !bubble || !parent || typeof bubble.animate !== 'function') {
        cleanup();
        return;
      }
      const target = bubble.getBoundingClientRect();
      if (target.width <= 0 || target.height <= 0 || target.bottom < 0 || target.top > view.innerHeight) {
        cleanup();
        return;
      }
      const properties = ['position', 'left', 'top', 'width', 'height', 'margin', 'z-index', 'transform-origin', 'box-sizing', 'pointer-events'] as const;
      const saved = properties.map(name => [name, bubble.style.getPropertyValue(name), bubble.style.getPropertyPriority(name)] as const);
      const minHeight = parent.style.minHeight;
      parent.style.minHeight = `${parent.getBoundingClientRect().height}px`;
      Object.assign(bubble.style, {
        position: 'fixed', left: `${target.left}px`, top: `${target.top}px`,
        width: `${target.width}px`, height: `${target.height}px`, margin: '0',
        zIndex: '100', transformOrigin: 'top right',
        boxSizing: 'border-box', pointerEvents: 'none',
      });
      restore = () => {
        for (const [name, value, priority] of saved) {
          if (value) bubble.style.setProperty(name, value, priority);
          else bubble.style.removeProperty(name);
        }
        parent.style.minHeight = minHeight;
      };
      const startLeft = Math.max(origin.left, Math.min(origin.left + origin.width - target.width, target.left));
      const dx = startLeft - target.left;
      const dy = origin.top - target.top;
      const move = (x: number, y: number, scale = 1) => `translate(${x}px, ${y}px) scale(${scale})`;
      try {
        row.removeAttribute('data-send-motion-pending');
        // Explicit WAAPI timing keeps this feature active under reduced-motion preferences.
        animation = bubble.animate([
          { transform: move(dx, dy, 0.96), opacity: 0.45, offset: 0 },
          { transform: move(dx, dy - 12), opacity: 1, offset: 100 / SEND_MOTION_DURATION },
          { transform: move(dx * 0.28, dy * 0.42 - 12), opacity: 1, offset: 0.62 },
          { transform: move(0, -3), opacity: 1, offset: 440 / SEND_MOTION_DURATION },
          { transform: move(0, 0), opacity: 1, offset: 1 },
        ], { duration: SEND_MOTION_DURATION, easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)', fill: 'both' });
        animation.finished.then(cleanup, cleanup);
        timer = view.setTimeout(cleanup, SEND_MOTION_DURATION + 100);
        view.addEventListener('resize', cleanup);
        row.ownerDocument.addEventListener('scroll', cleanup, true);
        observer = new view.MutationObserver(() => {
          if (!row.isConnected || !bubble.isConnected) cleanup();
        });
        observer.observe(row.getRootNode(), { childList: true, subtree: true });
      } catch {
        cleanup();
      }
    });
  });
}
