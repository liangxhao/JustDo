import type { WebContents } from 'electron';

import { redactLogText } from '../logRedaction';

/** Observe real window failures in both the normal and in-memory startup shell. */
export function registerWindowDiagnostics(webContents: WebContents, label: string): void {
  webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error(`[${label}] Preload failed:`, preloadPath, error);
  });
  webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (code === -3) return; // Electron reports cancelled navigation as ERR_ABORTED.
    console.error(`[${label}] Page failed to load:`, {
      code,
      description,
      url: redactLogText(url),
      isMainFrame,
    });
  });
  webContents.on('console-message', details => {
    // External browser/preview frames are not application diagnostic sources.
    if (details.frame !== webContents.mainFrame) return;
    if (details.level !== 'error' && details.level !== 'warning') return;
    const write = details.level === 'error' ? console.error : console.warn;
    write(`[${label}] Renderer ${details.level}:`, {
      source: redactLogText(details.sourceId),
      line: details.lineNumber,
      message: redactLogText(details.message),
    });
  });
}
