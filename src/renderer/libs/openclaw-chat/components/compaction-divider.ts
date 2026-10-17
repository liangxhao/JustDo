import { html, nothing } from 'lit';

import { i18nService } from '@/services/i18n';

import { formatActiveTurnDuration } from '../model/active-turn-footer';
import { buildChatItems } from '../pipeline/build-chat-items';
import type { ChatItem, GatewayMessage } from '../types';

export function renderCompactionDivider(
  item: Extract<ChatItem, { kind: 'divider' }>,
  now = Date.now(),
) {
  const label = item.inProgress
    ? `${item.label} · ${formatActiveTurnDuration(now - item.timestamp)}`
    : item.label;
  const description = item.description?.trim();
  const summary = item.summary?.trim() || i18nService.t('coworkCompactSummaryUnavailable');
  return html`
    <div class="chat-divider">
      ${
        item.expandable === false
          ? html`<div class="chat-divider__status">
              <span class="chat-divider__summary">${label}</span>
              ${description ? html`<div class="chat-divider__description">${description}</div>` : nothing}
            </div>`
          : html`<details class="chat-divider__details">
              <summary class="chat-divider__summary" title=${i18nService.t('coworkCompactDetails')}>
                ${label}
              </summary>
              <div class="chat-divider__content">${summary}</div>
            </details>`
      }
    </div>
  `;
}

export function renderCompactionMessage(message: GatewayMessage | undefined, now: number) {
  if (!message) return html``;
  const divider = buildChatItems({
    sessionKey: '',
    messages: [message],
    toolMessages: [],
    streamSegments: [],
    stream: null,
    streamStartedAt: null,
    showToolCalls: true,
  }).find(item => item.kind === 'divider');
  return divider?.kind === 'divider' ? renderCompactionDivider(divider, now) : html``;
}
