export const ExtensionPackageLifecycleMode = {
  HOT: 'hot',
  STOPPED: 'stopped',
} as const;

export type ExtensionPackageLifecycleMode =
  (typeof ExtensionPackageLifecycleMode)[keyof typeof ExtensionPackageLifecycleMode];

/** Exact package ownership and the prepared source, before any native mutation. */
export type ExtensionPackageMutationTarget = {
  nativePluginIds: readonly string[];
  installPath?: string;
  sourceDirectory?: string;
};

export type ApplyExtensionPackageMutation = <T>(
  target: ExtensionPackageMutationTarget,
  operation: (mode: ExtensionPackageLifecycleMode) => Promise<T>,
) => Promise<T>;

/** Reserve Main lifecycle ordering before entering the extension mutation queue. */
export type WithExtensionPackageMutation = <T>(
  operation: (apply: ApplyExtensionPackageMutation) => Promise<T>,
) => Promise<T>;
