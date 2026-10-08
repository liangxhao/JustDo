type LayoutEditor = {
  getContainerDomNode(): HTMLElement;
  layout(): void;
  onDidDispose(listener: () => void): { dispose(): void };
};

/** Monaco's built-in observer uses the source realm, which stops painting when minimized. */
export const observeEditorLayout = (editor: LayoutEditor): (() => void) => {
  const container = editor.getContainerDomNode();
  const ownerWindow = (container.ownerDocument.defaultView ?? window) as Window & typeof globalThis;
  let frame: number | null = null;
  const observer = new ownerWindow.ResizeObserver(() => {
    if (frame !== null) return;
    frame = ownerWindow.requestAnimationFrame(() => {
      frame = null;
      editor.layout();
    });
  });
  observer.observe(container);
  editor.layout();
  let subscription: { dispose(): void } | undefined;
  const cleanup = () => {
    observer.disconnect();
    if (frame !== null) ownerWindow.cancelAnimationFrame(frame);
    frame = null;
    subscription?.dispose();
  };
  subscription = editor.onDidDispose(cleanup);
  return cleanup;
};
