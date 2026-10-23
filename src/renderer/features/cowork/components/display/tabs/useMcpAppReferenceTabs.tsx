import type { McpAppDiscovery } from '@shared/plugins/mcpApps';
import { useLayoutEffect, useRef, useState } from 'react';

import {
  getMcpAppPresentations,
  type McpAppPresentation,
} from '@/libs/openclaw-chat/components/mcp-app/presentations';
import { i18nService } from '@/services/i18n';

import type { CoworkDisplayTab } from '../CoworkDisplayPanel';
import { McpAppTabIcon } from './McpAppTabIcon';

function ReferencePanel({ entry }: { entry: McpAppPresentation }) {
  const mount = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const manager = getMcpAppPresentations();
    const target = mount.current!;
    manager.setSidebar(entry, target);
    const owner = target.ownerDocument.defaultView as Window & typeof globalThis;
    const observer = new owner.ResizeObserver(manager.requestLayout);
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
      {entry.surface?.failed && entry.view.context?.isCurrent() && (
        <div role="status" className="p-4 text-sm text-secondary">
          {i18nService.t('mcpAppsUnavailable')}
          <button
            type="button"
            className="ml-3 underline"
            onClick={() => getMcpAppPresentations().retrySurface(entry)}
          >
            {i18nService.t('mcpAppsRetry')}
          </button>
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
    return {
      id: entry.id,
      label: manager.title(entry),
      reference: true,
      icon: (
        <McpAppTabIcon
          preview={entry.preview}
          context={entry.view.context}
          catalog={catalog}
          label={entry.preview.title}
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
