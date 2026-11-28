/** Version labels are available before the desktop connection is established. */
export function connectionVersions(runtime = globalThis.chrome?.runtime) {
  return {
    extensionVersion: runtime?.getManifest?.()?.version,
    desktopVersion:
      typeof __BUNDLED_DESKTOP_VERSION__ === 'string' ? __BUNDLED_DESKTOP_VERSION__ : undefined,
  };
}
