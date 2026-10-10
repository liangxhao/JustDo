import {
  isRendererPreferenceKey,
  RENDERER_PREFERENCE_FIXED_KEYS,
  RENDERER_PREFERENCE_LIMITS,
  RENDERER_PREFERENCES_KEY,
} from '@shared/app/rendererPreferences';

const FIXED_KEYS = new Set<string>(RENDERER_PREFERENCE_FIXED_KEYS);
const MAX_ENTRIES = RENDERER_PREFERENCE_LIMITS.entries;
const MAX_VALUE_BYTES = RENDERER_PREFERENCE_LIMITS.valueBytes;
const MAX_TOTAL_BYTES = RENDERER_PREFERENCE_LIMITS.totalBytes;

interface PreferenceStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

type BrowserPreferenceStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> &
  Partial<Pick<Storage, 'key' | 'length'>>;

const allowedKey = isRendererPreferenceKey;

/** Only UI preferences and unsent goal feedback, never transcripts or credentials. */
export function createRendererPreferences(
  getStore: () => PreferenceStore | undefined,
  getBrowserStorage: () => BrowserPreferenceStorage | undefined,
) {
  const values = new Map<string, string>();
  const dirty = new Map<string, { readonly value: string | null }>();
  let committed = new Map<string, string>();
  let baselineKnown = false;
  let mainOwned = false;
  let initialization: Promise<void> | undefined;
  let persistence = Promise.resolve();

  const markDirty = (key: string, value: string | null) => {
    dirty.delete(key);
    dirty.set(key, { value });
  };

  const size = (value: string) => new TextEncoder().encode(value).byteLength;
  const put = (target: Map<string, string>, key: string, value: string) => {
    if (!allowedKey(key) || size(value) > MAX_VALUE_BYTES) return;
    target.delete(key);
    target.set(key, value);
    const totalBytes = () => [...target.values()].reduce((total, item) => total + size(item), 0);
    while (target.size > MAX_ENTRIES || totalBytes() > MAX_TOTAL_BYTES) {
      const oldest = [...target.keys()].find(item => !FIXED_KEYS.has(item));
      if (!oldest) break;
      target.delete(oldest);
    }
  };
  const decode = (snapshot: unknown) => {
    const decoded = new Map<string, string>();
    if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
      for (const [key, value] of Object.entries(snapshot)) {
        if (typeof value === 'string') put(decoded, key, value);
      }
    }
    return decoded;
  };
  const currentOrigin = () => {
    const imported = new Map<string, string>();
    try {
      const storage = getBrowserStorage();
      if (!storage) return imported;
      const read = (key: string) => {
        const value = storage.getItem(key);
        if (typeof value === 'string') put(imported, key, value);
      };
      for (const key of FIXED_KEYS) read(key);
      // Scan only UI keys. Never copy arbitrary origin storage to the product DB.
      for (
        let index = 0;
        index < Math.min(storage.length ?? 0, RENDERER_PREFERENCE_LIMITS.browserKeys);
        index++
      ) {
        const key = storage.key?.(index);
        if (key && allowedKey(key) && !FIXED_KEYS.has(key)) read(key);
      }
    } catch {
      /* Restricted browser storage does not block startup. */
    }
    return imported;
  };
  const persist = () => {
    const changes = new Map(dirty);
    persistence = persistence
      .then(async () => {
        const store = getStore();
        if (!store) return;
        if (!baselineKnown) {
          // A failed bootstrap read never permits overwriting an unknown snapshot.
          committed = decode(await store.get(RENDERER_PREFERENCES_KEY));
          baselineKnown = true;
          for (const [key, value] of committed) {
            if (!dirty.has(key)) put(values, key, value);
          }
        }
        const next = new Map(committed);
        for (const [key, { value }] of changes) {
          if (value === null) next.delete(key);
          else put(next, key, value);
        }
        await store.set(RENDERER_PREFERENCES_KEY, Object.fromEntries(next));
        committed = next;
        for (const [key, edit] of changes) {
          // A later edit can return to the same value while this save is pending.
          if (dirty.get(key) === edit) dirty.delete(key);
        }
      })
      .then(
        () => undefined,
        () => undefined,
      );
  };

  return {
    initialize(): Promise<void> {
      if (initialization) return initialization;
      const store = getStore();
      mainOwned = Boolean(store);
      initialization = (async () => {
        if (!store) return;
        try {
          const snapshot = await store.get(RENDERER_PREFERENCES_KEY);
          committed = decode(snapshot);
          baselineKnown = true;
          for (const [key, value] of committed) put(values, key, value);
          if (snapshot === undefined || snapshot === null) {
            for (const [key, value] of currentOrigin()) {
              put(values, key, value);
              markDirty(key, value);
            }
            if (dirty.size) persist();
          }
        } catch {
          // Current-window preferences still work when persistent storage is unavailable.
        }
      })();
      return initialization;
    },
    getItem(key: string): string | null {
      if (!allowedKey(key)) return null;
      if (mainOwned || getStore()) return values.get(key) ?? null;
      try {
        return getBrowserStorage()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    setItem(key: string, value: string): void {
      if (!allowedKey(key) || size(value) > MAX_VALUE_BYTES) return;
      if (mainOwned || getStore()) {
        put(values, key, value);
        markDirty(key, value);
        persist();
      } else {
        try {
          getBrowserStorage()?.setItem(key, value);
        } catch {
          /* Memory-only browser context. */
        }
      }
    },
    removeItem(key: string): void {
      if (!allowedKey(key)) return;
      if (mainOwned || getStore()) {
        values.delete(key);
        markDirty(key, null);
        persist();
      } else {
        try {
          getBrowserStorage()?.removeItem(key);
        } catch {
          /* Restricted browser context. */
        }
      }
    },
    flush(): Promise<void> {
      return persistence;
    },
  };
}

export const rendererPreferences = createRendererPreferences(
  () => (typeof window === 'undefined' ? undefined : window.electron?.store),
  () => (typeof window === 'undefined' ? undefined : window.localStorage),
);
