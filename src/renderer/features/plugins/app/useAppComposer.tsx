import { PuzzlePieceIcon } from '@heroicons/react/24/outline';
import { useEffect, useRef, useSyncExternalStore } from 'react';

import type { ComposerFeatureItem } from '@/features/cowork/components/composer/ComposerFeatureMenu';
import { i18nService } from '@/services/i18n';

import { isAppWireValue } from '../../../../../packages/app-plugin-sdk/contracts';
import { appendAppInput } from '../../../../../plugins/extensions/runtime-services/contracts/app-input';
import type { AppMode } from './browserRegistry';
import { appBrowserRegistry } from './runtime';

interface Selection {
  id: string;
  epoch: string;
  modeId: string;
  token: string;
  options?: unknown;
}
const drafts = new Map<string, Selection>();
const listeners = new Set<() => void>();
let revision = 0;
const changed = () => {
  revision++;
  listeners.forEach(listener => listener());
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const composerGroup = (mode: AppMode): NonNullable<AppMode['group']> | undefined =>
  mode.group ??
  (mode.groupLabelKey
    ? {
        id: mode.groupLabelKey,
        labelKey: mode.groupLabelKey,
        icon: mode.icon,
      }
    : undefined);

export function useAppComposer(
  draftKey: string,
  enabled: boolean,
  onSelected?: (mode: AppMode) => void,
) {
  const modes = useSyncExternalStore(appBrowserRegistry.subscribe, appBrowserRegistry.getModes);
  useEffect(() => {
    let removed = false;
    for (const [key, value] of drafts)
      if (
        !modes.some(
          mode =>
            mode.pluginId === value.id && mode.epoch === value.epoch && mode.id === value.modeId,
        )
      ) {
        drafts.delete(key);
        removed = true;
      }
    if (removed) changed();
  }, [modes]);
  useSyncExternalStore(subscribe, () => revision);
  const keyRef = useRef(draftKey);
  keyRef.current = draftKey;
  const selection = enabled ? drafts.get(draftKey) : undefined;
  const selected =
    selection &&
    modes.find(
      mode =>
        mode.pluginId === selection.id &&
        mode.epoch === selection.epoch &&
        mode.id === selection.modeId,
    );
  const current = () =>
    selected &&
    keyRef.current === draftKey &&
    drafts.get(draftKey) === selection &&
    appBrowserRegistry.getModes().includes(selected);
  const isCurrentSelection = () =>
    keyRef.current === draftKey &&
    (!enabled || (selection ? Boolean(current()) : !drafts.has(draftKey)));
  const clear = () => {
    drafts.delete(draftKey);
    changed();
  };
  const select = (mode: AppMode) => {
    if (!appBrowserRegistry.getModes().includes(mode)) return;
    drafts.set(draftKey, {
      id: mode.pluginId,
      epoch: mode.epoch,
      modeId: mode.id,
      token: crypto.randomUUID(),
    });
    if (drafts.size > 512) drafts.delete(drafts.keys().next().value!);
    changed();
    onSelected?.(mode);
  };
  const orderedModes = [...modes].sort(
    (left, right) =>
      (composerGroup(left)?.order ?? left.order ?? 0) -
        (composerGroup(right)?.order ?? right.order ?? 0) || (left.order ?? 0) - (right.order ?? 0),
  );
  const features: ComposerFeatureItem[] = [];
  for (const mode of enabled ? orderedModes : []) {
    const group = composerGroup(mode);
    const entry: ComposerFeatureItem = {
      id: `${mode.pluginId}:${mode.id}`,
      label: i18nService.t(mode.labelKey),
      description: mode.descriptionKey ? i18nService.t(mode.descriptionKey) : undefined,
      icon: mode.icon ?? <PuzzlePieceIcon className="h-4 w-4" />,
      selected: selected === mode,
      role: group ? 'menuitemradio' : 'menuitem',
      onSelect: () => select(mode),
    };
    if (!group) {
      features.push({ ...entry, section: i18nService.t('composerPlugins') });
      continue;
    }
    const id = `${mode.pluginId}:${group.id}`;
    let parent = features.find(item => item.id === id);
    if (!parent) {
      parent = {
        id,
        label: i18nService.t(group.labelKey),
        icon: group.icon ?? mode.icon ?? <PuzzlePieceIcon className="h-4 w-4" />,
        section: i18nService.t('composerPlugins'),
        backLabel: group.backLabelKey ? i18nService.t(group.backLabelKey) : undefined,
        selected: false,
        onSelect: () => undefined,
        children: [],
      };
      features.push(parent);
    }
    parent.selected = parent.selected || entry.selected;
    parent.children = [...(parent.children ?? []), entry];
  }
  const selectedGroup = selected ? composerGroup(selected) : undefined;
  const token = selected
    ? {
        label: selected.selectionLabelKey
          ? i18nService.t(selected.selectionLabelKey)
          : selectedGroup
            ? `${i18nService.t(selectedGroup.labelKey)} · ${i18nService.t(selected.labelKey)}`
            : i18nService.t(selected.labelKey),
        icon: selected.icon ?? <PuzzlePieceIcon className="h-4 w-4" />,
        removeLabel: i18nService.t(selected.removeLabelKey ?? 'appPluginRemoveMode'),
      }
    : undefined;
  const Options = selected?.component;
  const options = Options ? (
    <Options
      value={selection?.options}
      onChange={value => {
        if (!current() || !isAppWireValue(value)) throw new Error('appPluginRetired');
        drafts.set(draftKey, { ...selection!, options: value });
        changed();
      }}
    />
  ) : null;
  return {
    selected,
    selection,
    isCurrentSelection,
    features,
    token,
    options,
    clear,
    async prepare(input: Parameters<AppMode['prepare']>[0]) {
      if (!isCurrentSelection()) throw new Error('appPluginRetired');
      if (!selected) return { prompt: input.prompt, submission: undefined };
      if (!current() || (input.queued && !selected.allowQueue))
        throw new Error('appPluginSubmitUnavailable');
      const result = await selected.prepare({ ...input, options: selection?.options });
      if (!current()) throw new Error('appPluginRetired');
      if (!isAppWireValue(result.input)) throw new Error('appPluginInvalidRequest');
      return {
        ...result,
        prompt: appendAppInput(input.prompt, {
          v: 1,
          pluginId: selected.pluginId,
          epoch: selected.epoch,
          mode: selected.id,
          prompt: result.prompt,
          ...(result.input === undefined ? {} : { input: result.input }),
        }),
        submission: {
          pluginId: selected.pluginId,
          epoch: selected.epoch,
          mode: selected.id,
          input: result.input,
        },
      };
    },
    accepted() {
      if (current()) clear();
    },
  };
}
