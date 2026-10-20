/** Pure wire contracts. No application, Electron, Node or DOM dependencies. */
export const APP_PLUGIN_API_VERSION = 1;
export const APP_PLUGIN_MANIFEST = 'app.plugin.json';
export const APP_PLUGIN_ARTIFACT = 'app.artifact.json';
export const AppPluginIpc = {
  Snapshot: 'plugins:app:snapshot',
  Invoke: 'plugins:app:invoke',
  Changed: 'plugins:app:changed',
  Event: 'plugins:app:event',
  Review: 'plugins:app:review',
  Approve: 'plugins:app:approve',
} as const;
export const AppPluginError = {
  Unavailable: 'appPluginUnavailable',
  ApprovalRequired: 'appPluginApprovalRequired',
  Retired: 'appPluginRetired',
  Invalid: 'appPluginInvalidRequest',
  Incompatible: 'appPluginIncompatible',
} as const;
export type AppPluginState = 'prepared' | 'active' | 'cleanup' | 'blocked';
export interface AppPluginManifest {
  manifestVersion: 1;
  apiVersion: 1;
  id: string;
  version: string;
  nativePluginId: string;
  entries: { main: string; browser: string; presentation?: string };
  capabilities: string[];
  commands: string[];
  slots: string[];
  native?: { defaultEnabled: boolean; userToggleable: boolean };
}
export interface AppPluginArtifact {
  manifest: AppPluginManifest;
  /** Digest of the manifest and every artifact file, excluding this index. */
  hash: string;
  files: Record<string, string>;
}
export interface AppPluginSnapshot {
  id: string;
  version: string;
  hash: string;
  epoch: string;
  state: AppPluginState;
  browserEntry?: string;
  browserStyle?: string;
  /** Pure display graph for the currently installed approved hash, independent of business epoch. */
  presentationEntry?: string;
  /** Selected approved UI artifact receipt, not Native installation/enablement proof. */
  installed?: true;
  commands?: string[];
  slots?: string[];
  restartRequired?: boolean;
}
export interface AppPluginInvocation {
  id: string;
  epoch: string;
  command: string;
  args: unknown[];
}
/** Transient plugin metadata, scoped to the exact active artifact and business epoch. */
export interface AppPluginEvent {
  id: string;
  hash: string;
  epoch: string;
  name: string;
  payload: unknown;
}
export interface AppPluginBridge {
  snapshot(): Promise<AppPluginSnapshot[]>;
  invoke(input: AppPluginInvocation): Promise<unknown>;
  onChanged(listener: (snapshot: AppPluginSnapshot[]) => void): () => void;
  onEvent?(listener: (event: AppPluginEvent) => void): () => void;
  review?(id: string): Promise<AppPluginReview | null>;
  approve?(input: {
    id: string;
    hash: string;
    token: string;
  }): Promise<{ success: boolean; restartRequired?: boolean }>;
}
export interface AppPluginReview {
  id: string;
  version: string;
  hash: string;
  token: string;
  capabilities: string[];
  approved: boolean;
  restartRequired: boolean;
}
export interface AppSubmission {
  pluginId: string;
  epoch: string;
  mode: string;
  input?: unknown;
}

export const isAppIdentifier = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(value) &&
  value.length <= 96;
export const isAppArtifactPath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 512 &&
  value
    .split('/')
    .every(segment => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/u.test(segment) && segment !== '..');
export const parseAppPluginManifest = (value: unknown): AppPluginManifest => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(AppPluginError.Invalid);
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      key =>
        ![
          'manifestVersion',
          'apiVersion',
          'id',
          'version',
          'nativePluginId',
          'entries',
          'capabilities',
          'commands',
          'slots',
          'native',
        ].includes(key),
    )
  )
    throw new Error(AppPluginError.Invalid);
  const entries = input.entries as Record<string, unknown> | undefined;
  const identifiers = (list: unknown): list is string[] =>
    Array.isArray(list) &&
    list.length <= 128 &&
    list.every(isAppIdentifier) &&
    new Set(list).size === list.length;
  if (
    input.manifestVersion !== 1 ||
    input.apiVersion !== APP_PLUGIN_API_VERSION ||
    !isAppIdentifier(input.id) ||
    !isAppIdentifier(input.nativePluginId) ||
    input.nativePluginId !== input.id ||
    typeof input.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/u.test(input.version) ||
    !entries ||
    !isAppArtifactPath(entries.main) ||
    !/\.(?:mjs|js)$/u.test(entries.main) ||
    !isAppArtifactPath(entries.browser) ||
    !/\.(?:mjs|js)$/u.test(entries.browser) ||
    Object.keys(entries).some(key => !['main', 'browser', 'presentation'].includes(key)) ||
    (entries.presentation !== undefined &&
      (!isAppArtifactPath(entries.presentation) ||
        !/\.(?:mjs|js)$/u.test(entries.presentation) ||
        entries.presentation === entries.main ||
        entries.presentation === entries.browser)) ||
    !identifiers(input.capabilities) ||
    !identifiers(input.commands) ||
    !identifiers(input.slots)
  ) {
    throw new Error(AppPluginError.Invalid);
  }
  const native = input.native as AppPluginManifest['native'];
  if (
    native !== undefined &&
    (!native ||
      typeof native !== 'object' ||
      Array.isArray(native) ||
      Object.keys(native).some(key => !['defaultEnabled', 'userToggleable'].includes(key)) ||
      typeof native.defaultEnabled !== 'boolean' ||
      typeof native.userToggleable !== 'boolean')
  )
    throw new Error(AppPluginError.Invalid);
  return {
    manifestVersion: 1,
    apiVersion: 1,
    id: input.id,
    version: input.version,
    nativePluginId: input.nativePluginId,
    entries: {
      main: entries.main,
      browser: entries.browser,
      ...(entries.presentation ? { presentation: entries.presentation as string } : {}),
    },
    capabilities: [...input.capabilities],
    commands: [...input.commands],
    slots: [...input.slots],
    ...(native
      ? { native: { defaultEnabled: native.defaultEnabled, userToggleable: native.userToggleable } }
      : {}),
  };
};

/** Bound untrusted IPC without storing or logging its contents. */
export const isAppWireValue = (value: unknown): boolean => {
  const ancestors = new Set<object>();
  let remaining = 2 * 1024 * 1024;
  let nodes = 0;
  const visit = (entry: unknown, depth: number): boolean => {
    if (++nodes > 20000 || depth > 32 || remaining < 0) return false;
    if (entry === null || entry === undefined || typeof entry === 'boolean') return true;
    if (typeof entry === 'number') return Number.isFinite(entry);
    if (typeof entry === 'string') {
      remaining -= entry.length * 2;
      return remaining >= 0;
    }
    if (typeof entry !== 'object' || ancestors.has(entry)) return false;
    if (
      !Array.isArray(entry) &&
      Object.getPrototypeOf(entry) !== Object.prototype &&
      Object.getPrototypeOf(entry) !== null
    )
      return false;
    ancestors.add(entry);
    const result = Object.entries(entry).every(([key, nested]) => {
      remaining -= key.length * 2;
      return !['__proto__', 'prototype', 'constructor'].includes(key) && visit(nested, depth + 1);
    });
    ancestors.delete(entry);
    return result;
  };
  return visit(value, 0);
};
