import {
  type AppServerNotificationMethod,
  type AppServerParams,
  isAppServerRecord,
} from '../../appServer/appServerProtocol';

type Listener = (method: AppServerNotificationMethod, params: AppServerParams) => void;

/** Live subscriptions only. Native history remains the sole source of past messages. */
export class CodexAppServerEventHub {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(threadId: string, listener: Listener): () => void {
    const group = this.listeners.get(threadId) ?? new Set<Listener>();
    group.add(listener);
    this.listeners.set(threadId, group);
    return () => {
      group.delete(listener);
      if (group.size === 0 && this.listeners.get(threadId) === group)
        this.listeners.delete(threadId);
    };
  }

  publish(method: AppServerNotificationMethod, params: AppServerParams): void {
    const threadId = typeof params.threadId === 'string' ? params.threadId
      : isAppServerRecord(params.thread) && typeof params.thread.id === 'string' ? params.thread.id
      : undefined;
    if (!threadId) return;
    const group = this.listeners.get(threadId);
    if (!group) return;
    for (const listener of [...group]) {
      if (!group.has(listener)) continue;
      try {
        listener(method, params);
      } catch {
        // A broken observer cannot interrupt the run or another client's output.
        group.delete(listener);
      }
    }
    if (group.size === 0 && this.listeners.get(threadId) === group)
      this.listeners.delete(threadId);
  }
}
