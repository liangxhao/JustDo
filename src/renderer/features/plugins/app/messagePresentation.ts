import { i18nService } from '@/services/i18n';

import type { AppMessagePresentation } from '../../../../../plugins/sdk/app-plugin-sdk/browser';

const contributors = new Map<string, AppMessagePresentation>();
const listeners = new Set<() => void>();
let unsubscribeDisplayPreferences: (() => void) | undefined;
export function subscribeMessagePresentation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function changed(): void {
  listeners.forEach(listener => listener());
}

function syncDisplayPreferences(): void {
  if ([...contributors.values()].some(contribution => contribution.displayText)) {
    // Reuse the existing presentation invalidator for locale/dictionary changes.
    unsubscribeDisplayPreferences ??= i18nService.subscribe(changed);
  } else {
    unsubscribeDisplayPreferences?.();
    unsubscribeDisplayPreferences = undefined;
  }
}
export function registerMessagePresentation(
  id: string,
  contribution: AppMessagePresentation,
): () => void {
  contributors.set(id, contribution);
  syncDisplayPreferences();
  changed();
  return () => {
    if (contributors.get(id) === contribution) {
      contributors.delete(id);
      syncDisplayPreferences();
      changed();
    }
  };
}
export function pluginMessagePresentation(message: unknown) {
  for (const contribution of contributors.values()) {
    try {
      const value = contribution.nativeInput?.(message);
      if (value) return value;
    } catch {
      /* No projection from a retired plugin. */
    }
  }
  return undefined;
}
export function pluginMessageText(source: string): string {
  for (const contribution of contributors.values()) {
    try {
      source = contribution.text?.(source) ?? source;
    } catch {
      /* Preserve text if a display projection fails. */
    }
  }
  return source;
}

/** Run on visible text only; transport parsing and restored drafts keep their exact source. */
export function pluginMessageDisplayText(source: string): string {
  for (const contribution of contributors.values()) {
    if (!contribution.displayText) continue;
    try {
      const context = Object.freeze({ language: i18nService.getLanguage() });
      const result = contribution.displayText(source, context);
      if (typeof result === 'string') source = result;
    } catch {
      /* A retired or failed display projection cannot replace visible source. */
    }
  }
  return source;
}

export function pluginReplyMirror(message: unknown): boolean {
  for (const contribution of contributors.values()) {
    try {
      if (contribution.replyMirror?.(message) === true) return true;
    } catch {
      /* A retired or failed display projection cannot hide a native record. */
    }
  }
  return false;
}
