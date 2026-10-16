import { DEFAULT_MAIN_WINDOW_SIZE } from '@shared/app/windowGeometry';

type WindowControls = Pick<Window['electron']['window'], 'isMaximized' | 'onStateChanged'>;

const WIDTH_PROGRESS_PROPERTY = '--chat-content-width-progress';

/** The saved percentage applies at the display's maximized width. */
export const resolveChatContentWidthProgress = (
  windowWidth: number,
  availableWidth: number,
  isMaximized = false,
  reservedWidth = 0,
): number => {
  const reserved = Number.isFinite(reservedWidth) ? Math.max(0, reservedWidth) : 0;
  if (isMaximized && reserved === 0) return 1;
  if (!Number.isFinite(windowWidth) || !Number.isFinite(availableWidth)) return 0;
  const expansionRange = availableWidth - DEFAULT_MAIN_WINDOW_SIZE.width;
  if (expansionRange <= 0) return 0;
  const effectiveWidth = (isMaximized ? availableWidth : windowWidth) - reserved;
  return Math.min(1, Math.max(0, (effectiveWidth - DEFAULT_MAIN_WINDOW_SIZE.width) / expansionRange));
};

export const observeChatContentWidth = (
  root: HTMLElement,
  controls?: WindowControls,
  layoutViewport?: HTMLElement,
) => {
  const view = root.ownerDocument.defaultView;
  let isMaximized = false;
  let stateRevision = 0;
  let disposed = false;
  const update = (): void => {
    if (!view || disposed) return;
    const progress = String(resolveChatContentWidthProgress(
      view.innerWidth,
      view.screen.availWidth,
      isMaximized,
      layoutViewport
        ? layoutViewport.getBoundingClientRect().width - root.getBoundingClientRect().width
        : 0,
    ));
    if (root.style.getPropertyValue(WIDTH_PROGRESS_PROPERTY) !== progress) {
      root.style.setProperty(WIDTH_PROGRESS_PROPERTY, progress);
    }
  };
  const unsubscribe = controls?.onStateChanged(state => {
    stateRevision += 1;
    isMaximized = state.isMaximized || state.isFullscreen;
    update();
  });
  const initialRevision = stateRevision;
  void controls?.isMaximized().then(value => {
    if (disposed || stateRevision !== initialRevision) return;
    isMaximized = value;
    update();
  }).catch(() => undefined);
  const resizeObserver = layoutViewport && view?.ResizeObserver
    ? new view.ResizeObserver(update)
    : undefined;
  if (resizeObserver && layoutViewport) {
    resizeObserver.observe(layoutViewport);
    resizeObserver.observe(root);
  }
  view?.addEventListener('resize', update);
  update();
  return {
    update,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      view?.removeEventListener('resize', update);
      resizeObserver?.disconnect();
      unsubscribe?.();
    },
  };
};
