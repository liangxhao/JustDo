import { html, nothing, type TemplateResult } from 'lit';
import { keyed } from 'lit/directives/keyed.js';
import { ref } from 'lit/directives/ref.js';
import { repeat } from 'lit/directives/repeat.js';

import { i18nService } from '@/services/i18n';

import type {
  CompletedProcessTimelineItem,
  SourceTimelineItem,
} from '../../model/timeline/timeline-avatar-state';
import { renderChatAvatar } from '../message/chat-avatar';
import { disclosureContent } from './disclosure-content';

export function renderCompletedProcess(
  item: CompletedProcessTimelineItem,
  options: {
    sessionIdentity: string | null;
    showAvatar: boolean;
    expanded?: boolean;
    assistantAvatar?: TemplateResult;
    onRender?: (element?: Element) => void;
    renderItem: (item: SourceTimelineItem, showAvatar: boolean) => TemplateResult | typeof nothing;
    renderItems?: (render: (item: SourceTimelineItem, index: number) => unknown) => unknown;
  },
): TemplateResult {
  return html`
    ${keyed(
      options.sessionIdentity,
      html`
        <details
          ${ref(options.onRender)}
          class="completed-process"
          ?open=${options.expanded ?? false}
          data-completed-process-key=${item.key}
          data-history-key=${item.key}
        >
          <summary
            class=${`chat-group chat-group--assistant chat-group--timeline${options.showAvatar ? '' : ' chat-group--continuation'}`}
          >
            <span class="chat-group__avatar">
              ${options.showAvatar ? (options.assistantAvatar ?? renderChatAvatar('assistant')) : nothing}
            </span>
            <span class="chat-group__content">
              <span class="completed-process__trigger">
                <svg class="completed-process__icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3 10a9 9 0 1 1 2.6 8.4M3 4v6h6M12 7v5l3 2" />
                </svg>
                <span class="completed-process__label completed-process__label--collapsed"
                  >${i18nService.t('coworkProcessExpandHistory')}</span
                >
                <span class="completed-process__label completed-process__label--expanded"
                  >${i18nService.t('coworkProcessCollapseHistory')}</span
                >
                <svg class="completed-process__chevron" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m9 6 6 6-6 6" />
                </svg>
              </span>
            </span>
          </summary>
          <div class="completed-process__items">
            ${disclosureContent(() =>
              options.renderItems?.((child, index) => options.renderItem(child, index === 0 && options.showAvatar)) ?? repeat(
                item.items,
                child => child.key,
                (child, index) => options.renderItem(child, index === 0 && options.showAvatar),
              ),
            )}
          </div>
        </details>
      `,
    )}
  `;
}
