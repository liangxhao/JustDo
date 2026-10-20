import { useCallback, useLayoutEffect, useState } from 'react';

import type { AppViewContext } from '../../../../../packages/app-plugin-sdk/browser';
import { AppPluginSlot, useAppViews } from './AppPluginSlot';
import type { AppView } from './browserRegistry';
import { appBrowserRegistry } from './runtime';

const pageKey = (view: AppView) => `${view.pluginId}:${view.epoch}:${view.id}`;

/** Keep navigation observers mounted while one plugin page occupies the content area. */
export function AppPageSlot({
  context,
  onVisibleChange,
}: {
  context: AppViewContext;
  onVisibleChange(visible: boolean): void;
}) {
  const views = useAppViews('application.page');
  const [selected, setSelected] = useState<string | null>(null);
  const visible = views.some(view => pageKey(view) === selected);
  useLayoutEffect(() => {
    onVisibleChange(visible);
    if (!visible) setSelected(null);
  }, [onVisibleChange, visible]);
  const select = useCallback((key: string, show: boolean) => {
    if (
      show &&
      !appBrowserRegistry
        .getViews()
        .some(view => view.slot === 'application.page' && pageKey(view) === key)
    )
      return;
    setSelected(current => (show ? key : current === key ? null : current));
  }, []);

  return views.map(view => (
    <AppPageView
      key={pageKey(view)}
      view={view}
      selected={pageKey(view) === selected}
      context={context}
      select={select}
    />
  ));
}

function AppPageView({
  view,
  selected,
  context,
  select,
}: {
  view: AppView;
  selected: boolean;
  context: AppViewContext;
  select(key: string, visible: boolean): void;
}) {
  const key = pageKey(view);
  const setVisible = useCallback((visible: boolean) => select(key, visible), [key, select]);
  return (
    <div className="h-full" hidden={!selected}>
      <AppPluginSlot
        slot="application.page"
        pluginId={view.pluginId}
        contributionId={view.id}
        context={{
          ...context,
          active: selected && context.active !== false,
          page: { setVisible },
        }}
      />
    </div>
  );
}
