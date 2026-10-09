import { createHash } from 'node:crypto';

import { type Flow, FLOW_LIMITS } from './contract.js';
import type { FlowStore } from './store.js';

export interface NotificationHost {
  send(flow: Flow, message: string): Promise<void>;
}

const notificationText = {
  zh: {
    title: 'Swarm Workflow 等待处理',
    next: '可以在主会话询问原因、补充信息并继续，或打开 Swarm Workflow 查看详情。',
  },
  en: {
    title: 'Swarm Workflow needs attention',
    next: 'Ask in this conversation about the blocker, provide input to continue, or open Swarm Workflow for details.',
  },
};

/** A bounded notification intent, never a second copy of native chat messages. */
export class FlowNotifier {
  private enabled = true;
  constructor(
    readonly store: FlowStore,
    readonly host: NotificationHost,
  ) {}
  stop(): void {
    this.enabled = false;
  }

  async tick(): Promise<void> {
    for (const entry of this.store.all()) {
      if (!this.enabled) break;
      // Native execution and user controls can advance other flows during send.
      const snapshot = this.store.get(entry.id);
      if (!snapshot) continue;
      if (snapshot.status !== 'blocked') continue;
      const nodes = snapshot.nodes.filter(
        node => node.error || ['failed', 'uncertain'].includes(node.status),
      );
      if (!snapshot.error && !nodes.length) continue;
      const fingerprint = JSON.stringify([
        snapshot.error ?? null,
        nodes.map(node => [
          node.id,
          node.attempt ?? 1,
          node.runId ?? node.intendedRunId,
          node.error ?? null,
        ]),
      ]);
      const id = createHash('sha256').update(fingerprint).digest('hex');
      if (
        snapshot.notices?.some(notice => notice.id === id) ||
        (snapshot.notices?.length ?? 0) >= FLOW_LIMITS.notices
      )
        continue;
      snapshot.notices = [...(snapshot.notices ?? []), { id, state: 'sending' }];
      this.store.put(snapshot);
      const words = /[\p{Script=Han}]/u.test(snapshot.goal)
        ? notificationText.zh
        : notificationText.en;
      const reasons = [
        snapshot.error,
        ...nodes.map(node => `${node.title}: ${node.error || node.status}`),
      ]
        .filter(Boolean)
        .map(reason => String(reason).slice(0, 1200));
      const message = `${words.title}\n\n${reasons.join('\n\n')}\n\n${words.next}`;
      let sent = false;
      try {
        await this.host.send(snapshot, message);
        sent = true;
      } catch {
        // chat.inject has no durable idempotency input. A lost ACK must never
        // cause duplicate transcript insertion, including after process restart.
      }
      const latest = this.store.get(snapshot.id);
      const notice = latest?.notices?.find(item => item.id === id);
      if (latest && notice) {
        notice.state = sent ? 'sent' : 'unconfirmed';
        this.store.put(latest);
      }
    }
  }
}
