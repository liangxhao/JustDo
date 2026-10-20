import { ClockIcon, Cog6ToothIcon } from '@heroicons/react/24/outline';
import { useEffect, useState } from 'react';

import { i18nService } from '@/services/i18n';

import AppCodeReviewAction from './AppCodeReviewAction';
import { AppPluginSlot, useAppViews } from './AppPluginSlot';

export interface AppExtensionSelection {
  pluginId: string;
  id: string;
  epoch: string;
  slot: string;
}

export function AppExtensionDialog({
  selection,
  onClose,
}: {
  selection: AppExtensionSelection | null;
  onClose: () => void;
}) {
  const views = useAppViews(selection?.slot ?? '', selection?.pluginId);
  const active =
    selection && views.find(view => view.id === selection.id && view.epoch === selection.epoch);
  useEffect(() => {
    if (selection && !active) onClose();
  }, [selection, active, onClose]);
  return active ? (
    <AppPluginSlot
      slot={active.slot}
      pluginId={active.pluginId}
      contributionId={active.id}
      context={{ onClose }}
    />
  ) : null;
}

/** The shell routes declared actions and keeps their dialogs alive when extension details close. */
export default function AppExtensionActions({
  extensionId,
  onOpen,
  variant = 'card',
}: {
  extensionId: string;
  onOpen?: (selection: AppExtensionSelection) => void;
  variant?: 'card' | 'details';
}) {
  const settings = useAppViews('plugin.settings', extensionId);
  const history = useAppViews('plugin.history', extensionId);
  const [selection, setSelection] = useState<AppExtensionSelection | null>(null);
  return (
    <>
      <AppCodeReviewAction extensionId={extensionId} />
      {[...history, ...settings].map(view => (
        <button
          key={view.id}
          type="button"
          className={
            variant === 'details'
              ? 'inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-primary hover:bg-surface-raised'
              : 'pointer-events-auto rounded-lg p-1.5 text-secondary hover:bg-surface-raised'
          }
          aria-label={i18nService.t(view.labelKey)}
          title={i18nService.t(view.labelKey)}
          onClick={event => {
            event.stopPropagation();
            (onOpen ?? setSelection)({
              pluginId: extensionId,
              id: view.id,
              epoch: view.epoch,
              slot: view.slot,
            });
          }}
        >
          {(variant === 'card' || view.slot === 'plugin.history') &&
            (view.icon ??
              (view.slot === 'plugin.history' ? (
                <ClockIcon aria-hidden="true" className="h-4 w-4" />
              ) : (
                <Cog6ToothIcon aria-hidden="true" className="h-4 w-4" />
              )))}
          {variant === 'details' && i18nService.t(view.labelKey)}
        </button>
      ))}
      {!onOpen && <AppExtensionDialog selection={selection} onClose={() => setSelection(null)} />}
    </>
  );
}
