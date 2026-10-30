import type { AppMessagePresentation } from '../../../../../plugins/sdk/app-plugin-sdk/browser';

const contributors = new Map<string, AppMessagePresentation>();
const listeners = new Set<() => void>();
export function subscribeMessagePresentation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function changed(): void {
  listeners.forEach(listener => listener());
}
export function registerMessagePresentation(
  id: string,
  contribution: AppMessagePresentation,
): () => void {
  contributors.set(id, contribution);
  changed();
  return () => {
    if (contributors.get(id) === contribution) {
      contributors.delete(id);
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
