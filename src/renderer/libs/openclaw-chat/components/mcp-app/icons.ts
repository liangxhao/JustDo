import type { McpAppDescriptor, McpAppDiscovery, McpAppIcon } from '@shared/plugins/mcpApps';

/** Display metadata only; callers supply an admitted view or a real catalog entry. */
export function resolveMcpAppIcons(
  catalog: McpAppDiscovery | undefined,
  identity: Pick<McpAppDescriptor, 'serverName'> &
    Partial<Pick<McpAppDescriptor, 'toolName' | 'uiResourceUri'>>,
): readonly McpAppIcon[] | undefined {
  const server = catalog?.servers.find(item => item.serverName === identity.serverName);
  const entry = server?.entrypoints.find(
    item =>
      item.toolName === identity.toolName &&
      (identity.uiResourceUri === undefined || item.resourceUri === identity.uiResourceUri),
  );
  return entry?.icons?.length ? entry.icons : server?.icons;
}

/** Icons travel inline with discovery; never fetch a public or local image URL. */
export function selectMcpAppIcon(
  icons: readonly McpAppIcon[] | undefined,
  theme: 'light' | 'dark',
  failed: readonly string[] = [],
): McpAppIcon | undefined {
  const candidates =
    icons?.filter(
      icon =>
        typeof icon.src === 'string' &&
        icon.src.length <= 2048 &&
        /^data:image\/(?:png|jpeg|gif|webp|svg\+xml)(?:;charset=utf-8)?(?:;base64)?,/i.test(
          icon.src,
        ) &&
        !failed.includes(icon.src),
    ) ?? [];
  return candidates.find(icon => icon.theme === theme) ?? candidates.find(icon => !icon.theme);
}
