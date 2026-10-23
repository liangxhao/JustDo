import { Squares2X2Icon } from '@heroicons/react/24/outline';
import { useLayoutEffect, useRef, useState } from 'react';

import {
  getNativeWidgetPresentations,
  type NativeWidgetPresentation,
} from '@/libs/openclaw-chat/components/native-widget/presentations';
import { i18nService } from '@/services/i18n';

import type { CoworkDisplayTab } from '../CoworkDisplayPanel';

function WidgetPanel({ entry }: { entry: NativeWidgetPresentation }) {
  const mount = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const manager = getNativeWidgetPresentations();
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
          {i18nService.t('coworkWidgetDisconnected')}
        </div>
      )}
      {entry.surface?.failed && entry.view.context?.isCurrent() && (
        <div role="status" className="p-4 text-sm text-secondary">
          {i18nService.t('coworkWidgetDisconnected')}
          <button
            type="button"
            className="ml-3 underline"
            onClick={() => getNativeWidgetPresentations().retrySurface(entry)}
          >
            {i18nService.t('coworkWidgetRetry')}
          </button>
        </div>
      )}
    </div>
  );
}

/** Tabs select the existing authenticated widget; closing returns it to its message. */
export function useWidgetReferenceTabs(
  scope: string,
  select: (id: string) => void,
  open: () => void,
  sessionIds?: readonly string[],
) {
  const manager = getNativeWidgetPresentations();
  const [, update] = useState(0);
  const latest = useRef({ scope, select, open });
  latest.current = { scope, select, open };
  useLayoutEffect(() => manager.retainWorkspace(), [manager]);
  useLayoutEffect(() => {
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
  useLayoutEffect(() => manager.resume(scope), [manager, scope]);
  const entries = manager.entries.filter(entry => entry.pinned && entry.scope === scope);
  const tabs: CoworkDisplayTab[] = entries.map(entry => ({
    id: entry.id,
    label: manager.title(entry),
    reference: true,
    icon: <Squares2X2Icon className="h-4 w-4" />,
    onSelect: () => select(entry.id),
    onClose: () => manager.unpin(entry),
  }));
  return {
    tabs,
    hasRetainedPanels: manager.entries.some(entry => entry.pinned || entry.returnPending),
    panel: (activeId: string | null) => {
      const entry = entries.find(value => value.id === activeId);
      return entry ? <WidgetPanel key={entry.id} entry={entry} /> : undefined;
    },
  };
}
