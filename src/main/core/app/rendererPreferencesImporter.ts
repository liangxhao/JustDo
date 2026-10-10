import { pathToFileURL } from 'node:url';

import { BrowserWindow } from 'electron';

import {
  isRendererPreferenceKey,
  RENDERER_PREFERENCE_FIXED_KEYS,
  RENDERER_PREFERENCE_LIMITS,
  RENDERER_PREFERENCES_KEY,
} from '../../../shared/app/rendererPreferences';

const READ_TIMEOUT_MS = 3000;

export interface RendererPreferenceStore {
  get(key: string): unknown;
  set(key: string, value: Record<string, string>): void;
}

type PreferenceImporterOptions = {
  resourcePath: string;
  session: Electron.Session;
  store: RendererPreferenceStore;
  isCurrent: () => boolean;
};

// Serialized into the blank reader page. Keep this function independent of Main closures.
function readFileOriginPreferences(
  fixedKeys: readonly string[],
  limits: { entries: number; valueBytes: number; totalBytes: number; browserKeys: number },
): Record<string, string> {
  const storage = window.localStorage;
  const snapshot: Record<string, string> = {};
  const encoder = new TextEncoder();
  let entries = 0;
  let total = 0;
  const add = (key: string): void => {
    const value = storage.getItem(key);
    if (value === null || entries >= limits.entries) return;
    const bytes = encoder.encode(value).byteLength;
    if (bytes > limits.valueBytes || total + bytes > limits.totalBytes) return;
    snapshot[key] = value;
    entries += 1;
    total += bytes;
  };
  for (const key of fixedKeys) add(key);
  for (let index = 0; index < Math.min(storage.length, limits.browserKeys); index++) {
    if (entries >= limits.entries) break;
    const key = storage.key(index);
    if (key && /^justdo:goal-completion-feedback:[a-zA-Z0-9:_-]{1,256}$/u.test(key)) add(key);
  }
  return snapshot;
}

export const sanitizeRendererPreferenceImport = (input: unknown): Record<string, string> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const source = input as Record<string, unknown>;
  const snapshot: Record<string, string> = {};
  let total = 0;
  let entries = 0;
  const add = (key: string): void => {
    const value = source[key];
    if (!isRendererPreferenceKey(key) || typeof value !== 'string') return;
    const bytes = Buffer.byteLength(value, 'utf8');
    if (
      entries >= RENDERER_PREFERENCE_LIMITS.entries ||
      bytes > RENDERER_PREFERENCE_LIMITS.valueBytes ||
      total + bytes > RENDERER_PREFERENCE_LIMITS.totalBytes
    )
      return;
    snapshot[key] = value;
    total += bytes;
    entries += 1;
  };
  for (const key of RENDERER_PREFERENCE_FIXED_KEYS) add(key);
  for (const key of Object.keys(source).slice(0, RENDERER_PREFERENCE_LIMITS.browserKeys)) {
    if (!(RENDERER_PREFERENCE_FIXED_KEYS as readonly string[]).includes(key)) add(key);
  }
  return snapshot;
};

/** First adoption only: read named UI preferences without starting the old app or its preload. */
export const importFileOriginRendererPreferences = async ({
  resourcePath,
  session,
  store,
  isCurrent,
}: PreferenceImporterOptions): Promise<void> => {
  let reader: BrowserWindow | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectClosed: (() => void) | undefined;
  try {
    if (!isCurrent() || store.get(RENDERER_PREFERENCES_KEY) !== undefined) return;
    const entryUrl = pathToFileURL(resourcePath).href;
    reader = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      webPreferences: {
        session,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
        devTools: false,
        backgroundThrottling: false,
        navigateOnDragDrop: false,
        disableDialogs: true,
      },
    });
    reader.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    reader.webContents.on('will-navigate', event => {
      if (event.url !== entryUrl) event.preventDefault();
    });
    reader.webContents.on('will-frame-navigate', event => {
      if (!event.isMainFrame || event.url !== entryUrl) event.preventDefault();
    });
    reader.webContents.on('will-redirect', event => event.preventDefault());
    const window = reader;
    const reading = (async () => {
      await window.loadFile(resourcePath);
      if (!isCurrent() || window.isDestroyed()) return undefined;
      return window.webContents.executeJavaScript(
        `(${readFileOriginPreferences.toString()})(${JSON.stringify(RENDERER_PREFERENCE_FIXED_KEYS)},${JSON.stringify(RENDERER_PREFERENCE_LIMITS)})`,
      );
    })();
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectClosed = () => reject(new Error('Preference reader closed'));
      window.once('closed', rejectClosed);
      timer = setTimeout(() => reject(new Error('Preference reader timed out')), READ_TIMEOUT_MS);
    });
    const snapshot = await Promise.race([reading, interrupted]);
    if (
      snapshot !== undefined &&
      isCurrent() &&
      !window.isDestroyed() &&
      store.get(RENDERER_PREFERENCES_KEY) === undefined
    )
      store.set(RENDERER_PREFERENCES_KEY, sanitizeRendererPreferenceImport(snapshot));
  } catch {
    // Content-free diagnostics only; failure never overwrites an unknown/existing record.
    console.warn('[RendererPreferences] File-origin preference import unavailable.');
  } finally {
    if (timer) clearTimeout(timer);
    if (reader && rejectClosed) reader.removeListener('closed', rejectClosed);
    if (reader && !reader.isDestroyed()) reader.destroy();
  }
};
