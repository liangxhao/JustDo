import type { BrowserWindow } from 'electron';

/** The Chromium error document can paint before the application's first successful load. */
export function registerStartupWindowPresentation(
  window: BrowserWindow,
  onReady: (window: BrowserWindow) => void,
): () => void {
  let painted = false;
  let loaded = false;
  const present = () => {
    if (painted && loaded && !window.isDestroyed()) onReady(window);
  };
  window.once('ready-to-show', () => {
    painted = true;
    present();
  });
  return () => {
    if (loaded) return;
    loaded = true;
    present();
  };
}
