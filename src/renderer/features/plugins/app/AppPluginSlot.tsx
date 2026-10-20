import { Component, type ReactNode, useSyncExternalStore } from 'react';

import type { AppViewContext } from '../../../../../packages/app-plugin-sdk/browser';
import { appBrowserRegistry } from './runtime';

class PluginViewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export const useAppViews = (slot: string, pluginId?: string) => {
  const views = useSyncExternalStore(appBrowserRegistry.subscribe, appBrowserRegistry.getViews);
  return views
    .filter(view => view.slot === slot && (pluginId === undefined || view.pluginId === pluginId))
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
};
export function AppPluginSlot({
  slot,
  pluginId,
  contributionId,
  context,
}: {
  slot: string;
  pluginId?: string;
  contributionId?: string;
  context: AppViewContext;
}) {
  return useAppViews(slot, pluginId)
    .filter(view => contributionId === undefined || view.id === contributionId)
    .map(view => (
      <PluginViewBoundary key={`${view.pluginId}:${view.epoch}:${view.id}`}>
        <view.component {...context} />
      </PluginViewBoundary>
    ));
}
