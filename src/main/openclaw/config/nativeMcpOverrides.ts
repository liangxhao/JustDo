const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Preserve native extension overrides without importing their definitions into product storage. */
export const mergeNativeMcpOverrides = (
  config: unknown,
  managedServers: Record<string, Record<string, unknown>>,
  extensionNames: ReadonlySet<string> = new Set(),
  retiredNames: ReadonlySet<string> = new Set(),
): Record<string, Record<string, unknown>> => {
  const servers =
    isRecord(config) && isRecord(config.mcp) && isRecord(config.mcp.servers)
      ? config.mcp.servers
      : {};
  return {
    ...Object.fromEntries(
      Object.entries(servers).filter(
        ([name, value]) =>
          !retiredNames.has(name) &&
          isRecord(value) &&
          (extensionNames.has(name) ||
            (value.enabled === false && Object.keys(value).length === 1)),
      ),
    ),
    ...managedServers,
  } as Record<string, Record<string, unknown>>;
};
