import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type ExtensionEnablement,
  getExtensionEnabled,
} from '@/features/plugins/extensions/useExtensionEnablement';

/** Plugin-owned options only; text and attachments remain with the normal composer. */
export function useComposerFeatureDraft<T extends object>(
  draftKey: string,
  extensionId: string,
  settings: ExtensionEnablement,
) {
  const enabled = getExtensionEnabled(settings, extensionId);
  const revision = settings.disabledRevisions.get(extensionId) ?? 0;
  const [drafts, setDrafts] = useState<
    Record<string, { value: T; revision: number; extensionId: string }>
  >({});
  const draft = drafts[draftKey];
  const value =
    enabled === true && draft?.revision === revision && draft.extensionId === extensionId
      ? draft.value
      : undefined;
  const current = useRef({ draftKey, value, enabled, revision, extensionId });
  current.current = { draftKey, value, enabled, revision, extensionId };

  useEffect(() => {
    setDrafts(previous => {
      const entries = Object.entries(previous);
      const valid = entries.filter(
        ([, entry]) =>
          enabled !== false && entry.revision === revision && entry.extensionId === extensionId,
      );
      return entries.length === valid.length ? previous : Object.fromEntries(valid);
    });
  }, [enabled, revision, extensionId]);

  const setValue = useCallback((next: T | undefined) => {
    const context = current.current;
    if (next !== undefined && context.enabled !== true) return;
    setDrafts(previous => {
      if (next === undefined) {
        const { [context.draftKey]: _removed, ...remaining } = previous;
        return remaining;
      }
      return {
        ...previous,
        [context.draftKey]: {
          value: next,
          revision: context.revision,
          extensionId: context.extensionId,
        },
      };
    });
  }, []);

  const clearAccepted = useCallback((acceptedKey: string, acceptedValue: T) => {
    setDrafts(previous => {
      if (previous[acceptedKey]?.value !== acceptedValue) return previous;
      const { [acceptedKey]: _removed, ...remaining } = previous;
      return remaining;
    });
  }, []);

  const isCurrent = useCallback((submittedKey: string, submittedValue: T) => {
    const context = current.current;
    return (
      context.enabled === true &&
      context.draftKey === submittedKey &&
      context.value === submittedValue
    );
  }, []);

  return { value, setValue, clearAccepted, isCurrent };
}
