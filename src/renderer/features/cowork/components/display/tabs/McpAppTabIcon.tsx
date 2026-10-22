import { Squares2X2Icon } from '@heroicons/react/24/outline';
import type {
  McpAppDiscovery,
  McpAppIcon as AppIcon,
  McpAppPreview,
} from '@shared/plugins/mcpApps';
import { useCallback, useContext, useSyncExternalStore } from 'react';

import { resolveMcpAppIcons } from '@/libs/openclaw-chat/components/mcp-app/icons';
import type { McpAppViewContext } from '@/libs/openclaw-chat/components/mcp-app/view';
import { readNativeMcpAppIdentity } from '@/libs/openclaw-chat/pipeline/native-mcp-app';

import { McpAppIcon } from '../../mcpApps/McpAppIcon';
import { WorkspaceFileIconContext } from '../../shared/WorkspaceFileIconContext';

export function McpAppTabIcon({
  preview,
  context,
  catalog,
  icons,
  label,
}: {
  preview?: McpAppPreview;
  context?: McpAppViewContext;
  catalog?: McpAppDiscovery;
  /** Declaration from the selected entry, used only while its Tab is loading. */
  icons?: readonly AppIcon[];
  label: string;
}) {
  const apps = context?.apps;
  const subscribe = useCallback(
    (notify: () => void) => apps?.subscribe(notify) ?? (() => {}),
    [apps],
  );
  const currentCatalog = useSyncExternalStore(subscribe, () => apps?.iconCatalog);
  // Adopted home Apps keep their original socket; the visible workspace's
  // catalog also refreshes their display metadata after navigation.
  const workspaceCatalog = useContext(WorkspaceFileIconContext);
  const identity = readNativeMcpAppIdentity(preview);
  return (
    <McpAppIcon
      size="file"
      label={label}
      icons={
        preview
          ? identity && resolveMcpAppIcons(catalog ?? workspaceCatalog ?? currentCatalog, identity)
          : icons
      }
      fallback={<Squares2X2Icon className="h-4 w-4" />}
    />
  );
}
