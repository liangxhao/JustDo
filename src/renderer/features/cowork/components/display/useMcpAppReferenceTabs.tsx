import { Squares2X2Icon } from '@heroicons/react/24/outline';
import type { McpAppDiscovery } from '@shared/plugins/mcpApps';
import { useLayoutEffect, useRef, useState } from 'react';

import {
  getMcpAppPresentations,
  type McpAppPresentation,
} from '@/libs/openclaw-chat/components/mcp-app/presentations';
import { readNativeMcpAppIdentity } from '@/libs/openclaw-chat/pipeline/native-mcp-app';
import { i18nService } from '@/services/i18n';

import { McpAppIcon } from '../mcpApps/McpAppIcon';
import type { CoworkDisplayTab } from './CoworkDisplayPanel';

function ReferencePanel({ entry }: { entry: McpAppPresentation }) {
  const mount = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const manager = getMcpAppPresentations();
    const target = mount.current!;
    manager.setSidebar(entry, target);
    const observer = new ResizeObserver(manager.requestLayout);
    observer.observe(target);
    return () => {
      observer.disconnect();
      manager.setSidebar(entry);
    };
  }, [entry]);
  return (
    <div ref={mount} className="absolute inset-0 bg-background">
      {!entry.view.context?.isCurrent() && (
        <div role="status" className="p-4 text-sm text-secondary">
          {i18nService.t('mcpAppsUnavailable')}
        </div>
      )}
    </div>
  );
}

/** References own no App and never use the normal closeApp or launch paths. */
export function useMcpAppReferenceTabs(
  scope: string,
  select: (id: string) => void,
  open: () => void,
  catalog?: McpAppDiscovery,
  sessionIds?: readonly string[],
) {
  const manager = getMcpAppPresentations();
  const [, update] = useState(0);
  const latest = useRef({ scope, select, open });
  latest.current = { scope, select, open };
  useLayoutEffect(() => manager.retainWorkspace(), [manager]);
  useLayoutEffect(() => {
    // An accepted/current session can precede its list refresh (including temp
    // conversations). Match the ordinary workspace's active-scope protection.
    if (sessionIds) manager.reconcileScopes(new Set([...sessionIds, scope]));
  }, [manager, sessionIds, scope]);
  useLayoutEffect(() => manager.subscribe(() => update(value => value + 1)), [manager]);
  useLayoutEffect(
    () =>
      manager.onReveal(entry => {
        if (entry.scope !== latest.current.scope) return;
        latest.current.select(entry.id);
        latest.current.open();
      }),
    [manager],
  );
  useLayoutEffect(() => {
    manager.resume(scope);
  }, [manager, scope]);
  const entries = manager.entries.filter(entry => entry.pinned && entry.scope === scope);
  const tabs: CoworkDisplayTab[] = entries.map(entry => {
    const identity = readNativeMcpAppIdentity(entry.preview);
    const server = catalog?.servers.find(item => item.serverName === identity?.serverName);
    const tool = server?.entrypoints.find(
      item => item.toolName === identity?.toolName && item.resourceUri === identity.uiResourceUri,
    );
    return {
      id: entry.id,
      label: manager.title(entry),
      reference: true,
      icon: (
        <McpAppIcon
          size="file"
          label={server?.label ?? identity?.serverName ?? entry.preview.title}
          icons={tool?.icons ?? server?.icons}
          fallback={<Squares2X2Icon className="h-4 w-4" />}
        />
      ),
      onSelect: () => select(entry.id),
      onClose: () => manager.unpin(entry),
    };
  });
  return {
    tabs,
    hasRetainedPanels: manager.entries.some(entry => entry.pinned || entry.returnPending),
    panel: (activeId: string | null) => {
      const entry = entries.find(value => value.id === activeId);
      return entry ? <ReferencePanel key={entry.id} entry={entry} /> : undefined;
    },
  };
}
