import type { GatewayMessage } from '@/libs/openclaw-chat/types';

import type { PersistedTimelineItem } from './project-history-timeline';

export interface PersistedTimelineCacheKey {
  sessionKey: string;
  sessionId: string | null;
  historyGeneration: number;
  messages: GatewayMessage[];
  pendingMessage: GatewayMessage | null;
  projectionVariant: string;
  runTimingSignature?: string;
}

export class PersistedTimelineCache {
  private key: PersistedTimelineCacheKey | null = null;
  private value: PersistedTimelineItem[] = [];
  private buildRevision = 0;

  get revision(): number {
    return this.buildRevision;
  }

  get(
    key: PersistedTimelineCacheKey,
    project: () => PersistedTimelineItem[],
  ): PersistedTimelineItem[] {
    if (
      this.key?.sessionKey === key.sessionKey &&
      this.key.sessionId === key.sessionId &&
      this.key.historyGeneration === key.historyGeneration &&
      this.key.messages === key.messages &&
      this.key.pendingMessage === key.pendingMessage &&
      this.key.projectionVariant === key.projectionVariant &&
      (this.key.runTimingSignature ?? '') === (key.runTimingSignature ?? '')
    ) {
      return this.value;
    }
    this.key = { ...key };
    this.value = project();
    this.buildRevision += 1;
    return this.value;
  }

  clear(): void {
    this.key = null;
    this.value = [];
    this.buildRevision += 1;
  }
}
