/**
 * <justdo-chat> Lit custom element.
 * Renders OpenClaw-style chat messages in a shadow DOM.
 *
 * Can receive messages either:
 * 1. Directly via properties (messages, stream, etc.)
 * 2. Via a ChatController reference (controller property)
 */
import katexStyles from 'katex/dist/katex.min.css?inline';
import { css, html, LitElement, nothing, type TemplateResult, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import mermaid from 'mermaid';

import { renderTimelineItem } from '@/libs/openclaw-chat/components/active-turn-timeline';
import {
  renderMessageBlock,
  renderMessageBlockWithTrailingStream,
  renderStreamingGroup,
  renderStreamingThinkingGroup,
  shouldRenderGroupAvatarByPrevItem,
  shouldRenderGroupFooterByNextItem,
} from '@/libs/openclaw-chat/components/message-render';
import { ChatScrollController } from '@/libs/openclaw-chat/controllers/chat-scroll-controller';
import { StreamRenderScheduler } from '@/libs/openclaw-chat/controllers/stream-render-scheduler';
import type { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import {
  type ChatMinimapEntry,
  projectChatMinimapEntries,
} from '@/libs/openclaw-chat/model/chat-minimap';
import type { AssistantTurn } from '@/libs/openclaw-chat/model/chat-transcript-state';
import { projectPersistedMessagesForActiveTurn } from '@/libs/openclaw-chat/model/optimistic-history-tail';
import { mergePendingUserMessageForDisplay } from '@/libs/openclaw-chat/model/optimistic-user-message';
import { PersistedTimelineCache } from '@/libs/openclaw-chat/model/persisted-timeline-cache';
import {
  createProcessSummarySessionIdentity,
  ProcessSummaryTakeoverTracker,
} from '@/libs/openclaw-chat/model/process-summary-takeover';
import {
  type PersistedTimelineItem,
  projectPersistedTimeline,
} from '@/libs/openclaw-chat/model/project-history-timeline';
import {
  type ActiveTurnTimelineItem,
  projectTurnItems,
} from '@/libs/openclaw-chat/model/project-turn-items';
import { prepareVisibleTimelineRows } from '@/libs/openclaw-chat/model/timeline-avatar-state';
import {
  PersistedTimelineRenderCache,
  projectIncrementalTimelineView,
} from '@/libs/openclaw-chat/model/timeline-render-cache';
import { buildChatItems } from '@/libs/openclaw-chat/pipeline/build-chat-items';
import type { ChatItem, GatewayMessage, MessageGroup } from '@/libs/openclaw-chat/types';
import { i18nService } from '@/services/i18n';

import { renderMermaidSvg } from './mermaidRenderer';

const MERMAID_BUBBLE_MIN_WIDTH = 500;
const MERMAID_BUBBLE_MAX_WIDTH = 820;
const MERMAID_BUBBLE_HORIZONTAL_PADDING = 64;
const MINIMAP_VISIBLE_ENTRY_THRESHOLD = 2;

@customElement('justdo-chat')
export class JustDoChatElement extends LitElement {
  private readonly streamingThinkingScrollHeights = new WeakMap<HTMLElement, number>();

  // ─── Properties ─────────────────────────────────────────────────────────

  /** Direct message input (when not using controller) */
  @property({ type: Array, attribute: false })
  declare messages: GatewayMessage[];

  @property({ type: String, attribute: false })
  declare stream: string | null;

  @property({ type: Number, attribute: false })
  declare streamStartedAt: number | null;

  @property({ type: Boolean, attribute: false })
  declare isStreaming: boolean;

  @property({ type: String, attribute: false })
  declare assistantName: string;

  @property({ type: String, attribute: false })
  declare workingDirectory: string;

  @property({ type: String, attribute: false })
  declare searchQuery: string;

  @property({ type: Boolean, attribute: false })
  declare searchCaseSensitive: boolean;

  @state()
  declare private openProcessSummaryKey: string | null;

  @state()
  declare private currentMinimapKey: string | null;

  @state()
  declare private hoveredMinimapKey: string | null;

  private readonly chatScrollController = new ChatScrollController(
    () => this.requestUpdate(),
    () => void this._controller?.showOlderHistory(),
    () => this._controller?.showNewerHistory() ?? false,
  );
  private readonly streamRenderScheduler = new StreamRenderScheduler(() => this.requestUpdate());
  private readonly persistedTimelineCache = new PersistedTimelineCache();
  private readonly persistedTimelineRenderCache = new PersistedTimelineRenderCache();
  private readonly processSummaryTakeoverTracker = new ProcessSummaryTakeoverTracker();
  private renderedOpenProcessSummaryKey: string | null = null;
  private focusedProcessSummaryKeyBeforeRender: string | null = null;
  private processSummarySessionIdentity: string | null = null;
  private lastSearchEnhancementKey = '';
  private lastMermaidEnhancementKey = '';
  private lastMinimapSyncKey = '';
  private latestMinimapPrefix: readonly ChatMinimapEntry[] = [];
  private latestMinimapTail: ChatMinimapEntry | null = null;
  private minimapEntriesSignature = '';
  private minimapPreviewTop = 0;
  private mermaidScrollFrame: number | null = null;

  constructor() {
    super();
    this.messages = [];
    this.stream = null;
    this.streamStartedAt = null;
    this.isStreaming = false;
    this.assistantName = '';
    this.workingDirectory = '';
    this.searchQuery = '';
    this.searchCaseSensitive = false;
    this.openProcessSummaryKey = null;
    this.currentMinimapKey = null;
    this.hoveredMinimapKey = null;
  }

  /** ChatController reference (preferred — connects directly to gateway) */
  private _controller: ChatController | null = null;
  private _controllerUnsubscribe: (() => void) | null = null;
  private _streamUnsubscribe: (() => void) | null = null;
  private activeSearchIndex = -1;

  get controller(): ChatController | null {
    return this._controller;
  }

  set controller(ctrl: ChatController | null) {
    if (this._controller === ctrl) return;
    this.unsubscribeController();
    this._controller = ctrl;
    if (ctrl) this.subscribeController(ctrl);
    this.requestUpdate();
  }

  // ─── Styles ─────────────────────────────────────────────────────────────

  static styles = [
    unsafeCSS(katexStyles),
    css`
      :host {
        display: block;
        font-family:
          -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
        font-size: 14px;
        line-height: 1.6;
        color: var(--justdo-chat-text, #1a1a1a);
        background: var(--justdo-chat-bg, transparent);
        overflow-y: auto;
        height: 100%;
      }

      .chat-shell {
        position: relative;
        min-height: 100%;
      }

      .chat-container {
        width: clamp(320px, 75%, 1120px);
        max-width: calc(100% - 32px);
        box-sizing: border-box;
        margin: 0 auto;
        padding: 16px 0;
      }

      .chat-minimap {
        position: sticky;
        top: 50%;
        z-index: 20;
        float: left;
        display: flex;
        width: 32px;
        max-height: min(68vh, 560px);
        box-sizing: border-box;
        margin-left: 16px;
        transform: translateY(-50%);
        color: #a3a3a3;
      }

      .chat-minimap__track {
        width: 32px;
        max-height: min(68vh, 560px);
        box-sizing: border-box;
        padding: 7px 0 7px 8px;
        overflow-y: auto;
        border-left: 1px solid rgba(163, 163, 163, 0.28);
        scrollbar-width: none;
      }

      .chat-minimap__track::-webkit-scrollbar {
        display: none;
      }

      .chat-minimap__item {
        display: flex;
        align-items: center;
        width: 23px;
        height: 14px;
        margin: 0;
        padding: 0;
        border: 0;
        background: transparent;
        color: inherit;
        cursor: pointer;
      }

      .chat-minimap__line {
        display: block;
        width: var(--minimap-line-width, 7px);
        height: 1px;
        border-radius: 999px;
        background: currentColor;
        opacity: 0.62;
        transition:
          width 120ms ease,
          height 120ms ease,
          color 120ms ease,
          opacity 120ms ease;
      }

      .chat-minimap__item:hover .chat-minimap__line,
      .chat-minimap__item:focus-visible .chat-minimap__line {
        width: 16px;
        height: 2px;
        opacity: 0.92;
      }

      .chat-minimap__item--active {
        color: #525252;
      }

      .chat-minimap__item--active .chat-minimap__line {
        width: 18px;
        height: 2px;
        opacity: 1;
      }

      .chat-minimap__item:focus-visible {
        outline: none;
      }

      .chat-minimap__preview {
        position: absolute;
        left: 38px;
        top: 0;
        width: min(320px, calc(100vw - 96px));
        box-sizing: border-box;
        padding: 10px 12px;
        transform: translateY(-50%);
        border: 1px solid rgba(0, 0, 0, 0.08);
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.98);
        box-shadow: 0 10px 28px rgba(0, 0, 0, 0.14);
        pointer-events: none;
      }

      .chat-minimap__preview-user,
      .chat-minimap__preview-assistant {
        display: -webkit-box;
        overflow: hidden;
        -webkit-box-orient: vertical;
        word-break: break-word;
      }

      .chat-minimap__preview-user {
        -webkit-line-clamp: 1;
        color: #262626;
        font-size: 13px;
        font-weight: 650;
        line-height: 1.45;
      }

      .chat-minimap__preview-assistant {
        margin-top: 4px;
        -webkit-line-clamp: 2;
        color: #a3a3a3;
        font-size: 12px;
        line-height: 1.45;
      }

      :host(.dark) .chat-minimap,
      :host([data-theme='dark']) .chat-minimap {
        color: #737373;
      }

      :host(.dark) .chat-minimap__item--active,
      :host([data-theme='dark']) .chat-minimap__item--active {
        color: #d4d4d4;
      }

      :host(.dark) .chat-minimap__preview,
      :host([data-theme='dark']) .chat-minimap__preview {
        border-color: rgba(255, 255, 255, 0.06);
        background: rgba(38, 38, 38, 0.98);
        box-shadow: 0 10px 32px rgba(0, 0, 0, 0.38);
      }

      :host(.dark) .chat-minimap__preview-user,
      :host([data-theme='dark']) .chat-minimap__preview-user {
        color: #f5f5f5;
      }

      :host(.dark) .chat-minimap__preview-assistant,
      :host([data-theme='dark']) .chat-minimap__preview-assistant {
        color: #a3a3a3;
      }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }

      :host(.full-width) .chat-container {
        width: 100%;
        max-width: 100%;
        padding-left: 8px;
        padding-right: 8px;
      }

      /* ── Chat Group ─────────────────────────────────────────────────── */

      .chat-group {
        display: flex;
        gap: 12px;
        padding: 2px 0;
        align-items: flex-start;
      }

      .chat-group--continuation {
        padding-top: 0;
        padding-bottom: 0;
      }

      .chat-group--user {
        flex-direction: row-reverse;
      }

      .chat-divider {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        margin: 10px 0;
        color: var(--justdo-chat-text-secondary, #6b7280);
      }

      .chat-divider::before,
      .chat-divider::after {
        content: '';
        flex: 1;
        height: 1px;
        margin-top: 9px;
        background: var(--justdo-chat-border, rgba(0, 0, 0, 0.12));
      }

      .chat-divider__details {
        min-width: 0;
        max-width: min(720px, 80%);
      }

      .chat-divider__summary {
        cursor: pointer;
        font-size: 12px;
        text-align: center;
        white-space: nowrap;
        user-select: none;
      }

      .chat-divider__content {
        margin-top: 8px;
        padding: 10px 12px;
        border: 1px solid var(--justdo-chat-border, rgba(0, 0, 0, 0.08));
        border-radius: 8px;
        background: var(--justdo-chat-thinking-bg, rgba(0, 0, 0, 0.02));
        font-size: 13px;
        line-height: 1.55;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }

      .chat-group__avatar {
        flex-shrink: 0;
        width: 32px;
        height: 32px;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .chat-group--continuation .chat-group__avatar {
        height: 0;
        overflow: hidden;
      }

      .chat-group__avatar .chat-avatar {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        font-weight: 600;
      }

      .chat-avatar.user {
        background: var(--justdo-chat-user-avatar-bg, #e0e7ff);
        color: var(--justdo-chat-user-avatar-text, #4338ca);
      }

      .chat-avatar.assistant {
        background: var(--justdo-chat-assistant-avatar-bg, #f3e8ff);
        color: var(--justdo-chat-assistant-avatar-text, #7c3aed);
      }

      .chat-avatar.tool {
        background: var(--justdo-chat-tool-avatar-bg, rgba(0, 0, 0, 0.05));
        color: var(--justdo-chat-tool-avatar-text, #6b7280);
      }

      .chat-avatar.other {
        background: rgba(0, 0, 0, 0.05);
        color: #6b7280;
      }

      .chat-avatar--logo {
        object-fit: cover;
      }

      .chat-group__content {
        flex: 1;
        min-width: 0;
      }

      .chat-group--assistant .chat-group__content {
        margin-right: 44px;
      }

      .chat-group__footer {
        font-size: 11px;
        color: var(--justdo-chat-text-secondary, #9ca3af);
        margin-top: 2px;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .chat-group--user .chat-group__footer {
        justify-content: flex-end;
      }

      .chat-group__sender {
        font-weight: 500;
      }

      /* ── Chat Bubble ────────────────────────────────────────────────── */

      .chat-bubble {
        padding: 10px 14px;
        border-radius: 12px;
        max-width: 100%;
        box-sizing: border-box;
        min-width: 0;
        word-wrap: break-word;
        overflow-wrap: break-word;
        position: relative;
      }

      .message-copy {
        position: absolute;
        top: 6px;
        right: 6px;
        z-index: 2;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        border: 0;
        border-radius: 5px;
        background: color-mix(in srgb, var(--justdo-chat-assistant-bg, #ffffff) 86%, transparent);
        color: var(--justdo-chat-text-secondary, #6b7280);
        cursor: pointer;
        opacity: 0;
        pointer-events: none;
        box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
        backdrop-filter: blur(4px);
        transition:
          opacity 120ms ease,
          background 120ms ease,
          color 120ms ease;
      }

      .chat-bubble:hover .message-copy,
      .message-copy:focus-visible {
        opacity: 1;
        pointer-events: auto;
      }

      .message-copy:hover {
        background: color-mix(
          in srgb,
          var(--justdo-chat-assistant-bg, #ffffff) 74%,
          rgba(0, 0, 0, 0.14)
        );
      }

      .message-copy--copied {
        color: #16a34a;
        opacity: 1;
      }

      .chat-bubble--user {
        background: var(--justdo-chat-user-bg, #eaf1fc);
        color: var(--justdo-chat-user-text, #1a1a1a);
        border-bottom-right-radius: 4px;
        margin-left: auto;
        max-width: calc(100% - 44px);
        width: fit-content;
      }

      .chat-bubble--user .message-copy {
        background: color-mix(in srgb, var(--justdo-chat-user-bg, #eaf1fc) 86%, transparent);
      }

      .chat-bubble--user .message-copy:hover {
        background: color-mix(
          in srgb,
          var(--justdo-chat-user-bg, #eaf1fc) 74%,
          rgba(0, 0, 0, 0.14)
        );
      }

      /* Remove default <p> margins inside user bubble — these add
       ~28px of phantom vertical space per paragraph.
       Also override pre-wrap → normal so trailing \n after </p>
       does not create an empty line at the bottom. */
      .chat-bubble--user .chat-bubble__text {
        white-space: normal;
      }

      .chat-bubble--user .chat-bubble__text > p {
        margin: 0;
        padding: 0;
      }

      .chat-bubble--user .chat-bubble__text > p + p {
        margin-top: 8px;
      }

      .chat-bubble--user a {
        color: inherit;
        text-decoration: underline;
      }

      .chat-bubble__content {
        display: flex;
        min-width: 0;
        flex-direction: column;
        gap: 8px;
      }

      .chat-bubble__images {
        display: flex;
        width: 100%;
        justify-content: center;
        margin: 0;
      }

      .chat-bubble__images:last-child {
        margin-bottom: 0;
      }

      .chat-bubble__images--assistant {
        margin: 0;
      }

      .chat-bubble__image {
        display: block;
        max-width: min(520px, 100%);
        max-height: 520px;
        border-radius: 8px;
        object-fit: contain;
      }

      .chat-bubble--assistant {
        background: var(--justdo-chat-assistant-bg, #ffffff);
        color: var(--justdo-chat-assistant-text, inherit);
        border-bottom-left-radius: 4px;
        max-width: 100%;
        width: fit-content;
      }

      .chat-bubble--streaming {
        border-left: 3px solid var(--justdo-chat-accent, #6366f1);
      }

      .chat-bubble__text {
        min-width: 0;
        max-width: 100%;
        white-space: pre-wrap;
      }

      .chat-bubble__text.markdown-content {
        white-space: normal;
      }

      .markdown-content {
        --code-block-bg: var(--justdo-chat-code-light-bg, #f0f2f5);
        --code-block-header-bg: var(--justdo-chat-code-light-bg, #f0f2f5);
        --code-block-text: var(--justdo-chat-code-text, #24292e);
        min-width: 0;
        max-width: 100%;
        overflow-wrap: anywhere;
      }

      /* ── Markdown Content ───────────────────────────────────────────── */

      .markdown-content p {
        margin: 0 0 4px 0;
      }

      .markdown-content p:last-child {
        margin-bottom: 0;
      }

      .markdown-content h1,
      .markdown-content h2,
      .markdown-content h3,
      .markdown-content h4 {
        margin: 10px 0 4px 0;
        font-weight: 600;
      }

      .markdown-content h1 {
        font-size: 1.3em;
      }
      .markdown-content h2 {
        font-size: 1.2em;
      }
      .markdown-content h3 {
        font-size: 1.1em;
      }

      .markdown-content ul,
      .markdown-content ol {
        padding-left: 20px;
        margin: 2px 0;
      }

      .markdown-content li {
        margin: 1px 0;
      }

      .markdown-content blockquote {
        border-left: 3px solid var(--justdo-chat-border, #d1d5db);
        margin: 4px 0;
        padding: 3px 12px;
        color: var(--justdo-chat-text-secondary, #6b7280);
      }

      .markdown-content table {
        border-collapse: collapse;
        margin: 4px 0;
        max-width: 100%;
        width: 100%;
      }

      .markdown-content th,
      .markdown-content td {
        border: 1px solid var(--justdo-chat-border, #e5e7eb);
        padding: 6px 10px;
        text-align: left;
      }

      .markdown-content th {
        background: var(--justdo-chat-table-header-bg, rgba(0, 0, 0, 0.03));
        font-weight: 600;
      }

      .markdown-content a {
        color: var(--justdo-chat-link, #6366f1);
        text-decoration: none;
      }

      .markdown-content a:hover {
        text-decoration: underline;
      }

      .markdown-content img.markdown-inline-image {
        max-width: 100%;
        border-radius: 8px;
        margin: 2px 0;
      }

      .markdown-content .markdown-plain-text-fallback {
        white-space: pre-wrap;
        font: inherit;
      }

      /* ── Code Blocks ────────────────────────────────────────────────── */

      .markdown-content pre {
        width: 100%;
        min-width: 0;
        background: var(--code-block-bg);
        color: var(--code-block-text);
        padding: 12px;
        border-radius: 8px;
        max-width: 100%;
        box-sizing: border-box;
        overflow-x: auto;
        overflow-y: hidden;
        white-space: pre;
        overflow-wrap: normal;
        word-break: normal;
        font-size: 13px;
        line-height: 1.5;
        margin: 4px 0;
      }

      .markdown-content code {
        font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
        font-size: 0.9em;
      }

      .markdown-content :not(pre) > code {
        background: var(--justdo-chat-inline-code-bg, rgba(0, 0, 0, 0.06));
        padding: 2px 6px;
        border-radius: 4px;
      }

      .code-block-wrapper {
        position: relative;
        width: 100%;
        min-width: 0;
        max-width: 100%;
        margin: 4px 0;
        overflow: hidden;
        background: var(--code-block-bg);
        border-radius: 8px;
        box-sizing: border-box;
      }

      .code-block-header {
        position: relative;
        z-index: 3;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 12px;
        min-width: 0;
        background: var(--code-block-header-bg);
        border-radius: 8px 8px 0 0;
        font-size: 12px;
      }

      .code-block-wrapper pre {
        width: 100%;
        margin-top: 0;
        margin-bottom: 0;
        border: 0;
        border-radius: 0 0 8px 8px;
      }

      .code-block-wrapper pre > code {
        display: block;
        width: max-content;
        min-width: 100%;
        box-sizing: border-box;
      }

      .code-block-lang {
        color: var(--justdo-chat-text-secondary, #9ca3af);
        font-size: 11px;
        text-transform: uppercase;
      }

      .code-block-copy {
        position: relative;
        z-index: 4;
        background: none;
        border: 1px solid var(--justdo-chat-border, rgba(255, 255, 255, 0.15));
        color: var(--justdo-chat-text-secondary, #9ca3af);
        cursor: pointer;
        flex: 0 0 auto;
        margin-left: auto;
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 11px;
        transition: all 0.15s;
      }

      .code-block-copy:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
      }

      .assistant-canvas {
        width: min(760px, 100%);
        margin-top: 8px;
        overflow: hidden;
        background: var(--justdo-chat-assistant-bg, #ffffff);
        border: 1px solid var(--justdo-chat-border, #e5e7eb);
        border-radius: 10px;
      }

      .assistant-canvas__title {
        padding: 7px 10px;
        overflow: hidden;
        color: var(--justdo-chat-text-secondary, #6b7280);
        font-size: 12px;
        font-weight: 500;
        text-overflow: ellipsis;
        white-space: nowrap;
        border-bottom: 1px solid var(--justdo-chat-border, #e5e7eb);
      }

      .assistant-canvas__frame {
        display: block;
        width: 100%;
        min-height: 160px;
        background: #fff;
        border: 0;
      }

      .assistant-canvas__unavailable {
        padding: 18px;
        color: var(--justdo-chat-text-secondary, #6b7280);
        font-size: 13px;
        text-align: center;
      }

      .message-attachments {
        display: flex;
        flex-flow: row wrap;
        gap: 6px;
        max-width: 100%;
        margin: 0;
      }

      .message-attachment {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        width: fit-content;
        max-width: min(320px, 100%);
        padding: 4px 7px 4px 5px;
        color: var(--text-primary);
        text-align: left;
        background: color-mix(in srgb, var(--surface-raised, #ffffff) 45%, transparent);
        border: 1px solid color-mix(in srgb, currentColor 10%, transparent);
        border-radius: 7px;
        cursor: pointer;
        transition:
          border-color 120ms ease,
          background 120ms ease,
          color 120ms ease;
      }

      .message-attachment:hover {
        background: var(--surface-hover, rgba(127, 127, 127, 0.1));
        border-color: color-mix(in srgb, var(--accent, #4f7cff) 28%, transparent);
      }

      .message-attachment:focus-visible {
        outline: 2px solid var(--accent, #4f7cff);
        outline-offset: 2px;
      }

      .message-attachment__icon {
        display: grid;
        flex: 0 0 22px;
        width: 22px;
        height: 22px;
        color: var(--accent, #4f7cff);
        background: color-mix(in srgb, currentColor 8%, transparent);
        border-radius: 6px;
        place-items: center;
      }

      .message-attachment__icon svg {
        width: 13px;
        height: 13px;
        stroke-width: 1.7;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      .message-attachment__content {
        overflow: hidden;
        min-width: 0;
        flex: 1;
      }

      .message-attachment__name {
        overflow: hidden;
        min-width: 0;
        font-size: 12px;
        font-weight: 500;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .message-attachment__open {
        flex: 0 0 auto;
        color: var(--text-secondary);
        font-size: 11px;
        opacity: 0.45;
        transition: opacity 120ms ease;
      }

      .message-attachment:hover .message-attachment__open {
        opacity: 0.9;
      }

      .mermaid-toggle {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 18px;
        height: 18px;
        padding: 2px;
        border: 0;
        border-radius: 4px;
        background: transparent;
        color: var(--justdo-chat-text-secondary, #6b7280);
        cursor: pointer;
      }

      .mermaid-toggle:hover {
        color: var(--justdo-chat-text, #1f2937);
        background: rgba(0, 0, 0, 0.06);
      }

      .mermaid-block.is-source .mermaid-toggle span {
        color: var(--justdo-chat-accent, #3b82f6);
      }

      .mermaid-block {
        overflow: hidden;
        border: 1px solid var(--justdo-chat-border, #e5e7eb);
        border-radius: 4px;
        background: var(--justdo-chat-code-light-bg, #f0f2f5);
      }

      .mermaid-block .code-block-header {
        min-height: 20px;
        padding: 2px 8px;
        color: var(--justdo-chat-text-secondary, #6b7280);
        background: var(--justdo-chat-code-light-bg, #f0f2f5);
        border-radius: 0;
        line-height: 1.25;
      }

      .mermaid-block .code-block-lang {
        font-size: 12px;
        font-weight: 500;
        text-transform: none;
      }

      .mermaid-preview {
        overflow-x: auto;
        padding: 16px;
        text-align: center;
        background: var(--justdo-chat-code-light-bg, #f0f2f5);
        border-top: 1px solid var(--justdo-chat-border, #e5e7eb);
        border-radius: 0;
      }

      .mermaid-preview svg {
        max-width: 100%;
        height: auto;
      }

      .mermaid-source pre,
      .mermaid-source pre code {
        background: var(--justdo-chat-code-light-bg, #f0f2f5);
      }

      .mermaid-source pre {
        padding: 4px 8px;
        font-size: 13px;
        line-height: 1.5;
      }

      .mermaid-source code {
        color: #383a42;
      }

      .mermaid-source .hljs-keyword {
        color: #a626a4;
      }

      .mermaid-source .hljs-built_in,
      .mermaid-source .hljs-number {
        color: #986801;
      }

      .mermaid-source .hljs-string {
        color: #50a14f;
      }

      .mermaid-source .hljs-comment {
        color: #a0a1a7;
      }

      .mermaid-source .hljs-symbol {
        color: #0184bc;
      }

      .mermaid-error {
        color: var(--justdo-chat-error, #dc2626);
        white-space: pre-wrap;
        text-align: left;
        font-size: 12px;
      }

      .code-block-copy__done {
        display: none;
      }

      .code-block-copy.copied .code-block-copy__idle {
        display: none;
      }

      .code-block-copy.copied .code-block-copy__done {
        display: inline;
      }

      /* JSON collapse */
      .json-collapse {
        margin: 4px 0;
      }

      .json-collapse > summary {
        cursor: pointer;
        font-size: 12px;
        color: var(--justdo-chat-text-secondary, #9ca3af);
        padding: 4px 0;
      }

      /* ── highlight.js (GitHub theme) ────────────────────────────────── */

      .hljs {
        color: #24292e;
      }
      .hljs-comment,
      .hljs-quote {
        color: #6a737d;
        font-style: italic;
      }
      .hljs-keyword,
      .hljs-selector-tag {
        color: #d73a49;
      }
      .hljs-literal,
      .hljs-number,
      .hljs-tag .hljs-attr {
        color: #005cc5;
      }
      .hljs-string,
      .hljs-doctag,
      .hljs-regexp {
        color: #032f62;
      }
      .hljs-title,
      .hljs-section,
      .hljs-selector-id {
        color: #6f42c1;
        font-weight: 600;
      }
      .hljs-subst {
        font-weight: normal;
      }
      .hljs-type,
      .hljs-class .hljs-title {
        color: #6f42c1;
      }
      .hljs-tag,
      .hljs-name,
      .hljs-attribute {
        color: #22863a;
      }
      .hljs-symbol,
      .hljs-bullet {
        color: #e36209;
      }
      .hljs-built_in,
      .hljs-builtin-name {
        color: #005cc5;
      }
      .hljs-meta {
        color: #735c0f;
      }
      .hljs-deletion {
        color: #b31d28;
        background: #ffeef0;
      }
      .hljs-addition {
        color: #22863a;
        background: #f0fff4;
      }
      .hljs-emphasis {
        font-style: italic;
      }
      .hljs-strong {
        font-weight: bold;
      }

      :host(.dark) .hljs,
      :host([data-theme='dark']) .hljs {
        color: #e1e4e8;
      }

      :host(.dark) .markdown-content,
      :host([data-theme='dark']) .markdown-content {
        --code-block-bg: #161b22;
        --code-block-header-bg: #161b22;
        --code-block-text: #d4d4d4;
      }
      :host(.dark) .hljs-comment,
      :host([data-theme='dark']) .hljs-comment {
        color: #6a737d;
      }
      :host(.dark) .hljs-keyword,
      :host([data-theme='dark']) .hljs-keyword {
        color: #ff7b72;
      }
      :host(.dark) .hljs-string,
      :host([data-theme='dark']) .hljs-string {
        color: #a5d6ff;
      }
      :host(.dark) .hljs-number,
      :host([data-theme='dark']) .hljs-number {
        color: #79c0ff;
      }
      :host(.dark) .hljs-title,
      :host([data-theme='dark']) .hljs-title {
        color: #d2a8ff;
      }
      :host(.dark) .hljs-tag,
      :host([data-theme='dark']) .hljs-tag {
        color: #7ee787;
      }
      :host(.dark) .hljs-attr,
      :host([data-theme='dark']) .hljs-attr {
        color: #79c0ff;
      }

      /* Detect dark mode via host class — follows app theme, not OS */
      :host(.dark) .hljs {
        color: #e1e4e8;
      }
      :host(.dark) .hljs-comment {
        color: #6a737d;
      }
      :host(.dark) .hljs-keyword {
        color: #ff7b72;
      }
      :host(.dark) .hljs-string {
        color: #a5d6ff;
      }
      :host(.dark) .hljs-number {
        color: #79c0ff;
      }
      :host(.dark) .hljs-title {
        color: #d2a8ff;
      }
      :host(.dark) .hljs-tag {
        color: #7ee787;
      }
      :host(.dark) .hljs-attr {
        color: #79c0ff;
      }
      :host(.dark) .mermaid-block {
        border-color: rgba(255, 255, 255, 0.1);
        background: #282c34;
      }
      :host(.dark) .mermaid-block .code-block-header {
        color: #9ca3af;
        background: #282c34;
      }
      :host(.dark) .mermaid-preview {
        background: #282c34;
        border-top-color: rgba(255, 255, 255, 0.1);
      }
      :host(.dark) .mermaid-source pre,
      :host(.dark) .mermaid-source pre code {
        background: #282c34;
      }
      :host(.dark) .mermaid-source code {
        color: #abb2bf;
      }
      :host(.dark) .mermaid-source .hljs-keyword {
        color: #c678dd;
      }
      :host(.dark) .mermaid-source .hljs-built_in,
      :host(.dark) .mermaid-source .hljs-number {
        color: #d19a66;
      }
      :host(.dark) .mermaid-source .hljs-string {
        color: #98c379;
      }
      :host(.dark) .mermaid-source .hljs-comment {
        color: #5c6370;
      }
      :host(.dark) .mermaid-source .hljs-symbol {
        color: #56b6c2;
      }
      :host(.dark) .mermaid-toggle:hover {
        color: #f3f4f6;
        background: rgba(255, 255, 255, 0.1);
      }
      :host(.dark) .markdown-content pre {
        background: var(--code-block-bg);
        color: var(--code-block-text);
      }

      /* ── Thinking Block ─────────────────────────────────────────────── */

      .chat-thinking {
        width: fit-content;
        max-width: 100%;
        margin: 1px 0 4px;
        box-sizing: border-box;
      }

      .chat-thinking__content {
        padding: 6px 10px;
        background: var(--justdo-chat-thinking-bg, rgba(0, 0, 0, 0.02));
        border-radius: 8px;
        font-size: 13px;
        line-height: 1.5;
        color: var(--justdo-chat-text-secondary, #6b7280);
        margin-top: 2px;
        border: 1px solid var(--justdo-chat-border, rgba(0, 0, 0, 0.04));
        max-height: 7.5em;
        overflow-y: auto;
      }

      .chat-thinking__content p,
      .chat-thinking__content ul,
      .chat-thinking__content ol,
      .chat-thinking__content pre {
        margin: 0;
      }

      .chat-thinking__content p + p,
      .chat-thinking__content ul + p,
      .chat-thinking__content ol + p,
      .chat-thinking__content pre + p {
        margin-top: 2px;
      }

      .chat-thinking__header {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: var(--justdo-chat-text-secondary, #9ca3af);
        padding: 1px 0 2px;
      }

      .chat-thinking__indicator {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--justdo-chat-accent, #6366f1);
        animation: thinking-pulse 1.5s infinite ease-in-out;
      }

      .chat-thinking__label {
        font-weight: 500;
      }

      @keyframes thinking-pulse {
        0%,
        100% {
          opacity: 0.4;
          transform: scale(0.8);
        }
        50% {
          opacity: 1;
          transform: scale(1.2);
        }
      }

      /* ── Reading Indicator ──────────────────────────────────────────── */

      .chat-reading-indicator {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 0;
      }

      .chat-reading-indicator span {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--justdo-chat-accent, #6366f1);
        animation: reading-pulse 1.4s infinite ease-in-out;
      }

      .chat-reading-indicator span:nth-child(2) {
        animation-delay: 0.2s;
      }
      .chat-reading-indicator span:nth-child(3) {
        animation-delay: 0.4s;
      }

      @keyframes reading-pulse {
        0%,
        80%,
        100% {
          transform: scale(0.7);
          opacity: 0.35;
        }
        40% {
          transform: scale(1);
          opacity: 0.9;
        }
      }

      /* ── Empty State ────────────────────────────────────────────────── */

      .empty-state {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--justdo-chat-text-secondary, #9ca3af);
        font-size: 14px;
      }

      /* ── Dark mode overrides ────────────────────────────────────────── */

      /* Use CSS custom properties controlled by the app's data-theme,
       NOT prefers-color-scheme which follows the OS setting. */
      :host(.dark) {
        color: #e5e7eb;
      }
      :host(.dark) .chat-bubble--assistant {
        background: var(--justdo-chat-assistant-bg, #1f2937);
        border-color: rgba(255, 255, 255, 0.06);
      }
      :host(.dark) .chat-thinking__content {
        background: rgba(255, 255, 255, 0.03);
        border-color: rgba(255, 255, 255, 0.06);
      }

      .chat-search-mark {
        border-radius: 3px;
        background: rgba(250, 204, 21, 0.75);
        color: #422006;
        box-shadow: 0 0 0 2px rgba(234, 179, 8, 0.45);
      }

      .active-turn {
        position: relative;
        width: 100%;
        box-sizing: border-box;
        margin: 8px 0 22px;
        color: var(--justdo-chat-text, #111827);
      }
      .active-turn__footer {
        display: flex;
        flex: 1;
        min-width: 0;
        min-height: 28px;
        align-items: center;
        gap: 6px;
        color: var(--justdo-chat-muted, #64748b);
        font-size: 11px;
      }
      .active-turn-timeline {
        display: grid;
        gap: 4px;
      }
      .chat-group--timeline {
        padding-block: 0;
      }
      .chat-group--timeline .chat-group__content {
        padding-top: 1px;
      }
      .process-summary {
        display: flex;
        width: fit-content;
        max-width: 100%;
        align-items: center;
        gap: 7px;
        border: 0;
        border-radius: 8px;
        padding: 6px 9px;
        background: transparent;
        color: var(--justdo-chat-muted, #64748b);
        font: inherit;
        font-size: 13px;
        font-style: italic;
        font-weight: 500;
        cursor: pointer;
      }
      .process-summary:hover,
      .process-summary:focus-visible {
        background: rgba(59, 130, 246, 0.08);
        color: #2563eb;
        outline: none;
      }
      .process-summary__icon {
        font-size: 16px;
      }
      .process-summary__chevron {
        margin-left: 2px;
        font-size: 18px;
        line-height: 1;
        transition: transform 120ms ease;
      }
      .process-summary[aria-expanded='true'] .process-summary__chevron {
        transform: rotate(90deg);
      }
      .process-summary__items {
        display: grid;
        gap: 8px;
        margin: 2px 0 8px 18px;
        padding: 0 0 0 14px;
        border-left: 1px solid var(--justdo-chat-border, rgba(148, 163, 184, 0.32));
        list-style: none;
      }
      .process-summary__item {
        min-width: 0;
        border-radius: 8px;
        padding: 7px 9px;
        background: var(--justdo-chat-process-bg, rgba(248, 250, 252, 0.58));
        font-size: 12px;
        font-style: normal;
      }
      .process-summary__item:focus {
        outline: 2px solid var(--justdo-chat-accent, #2563eb);
        outline-offset: 2px;
      }
      .process-summary__item-heading {
        display: grid;
        grid-template-columns: 9px minmax(0, 1fr);
        gap: 7px;
        align-items: center;
        color: var(--justdo-chat-muted, #64748b);
      }
      .process-summary__thinking-marker {
        width: 9px;
        height: 9px;
        background: var(--justdo-chat-accent, #6366f1);
        clip-path: polygon(50% 0, 61% 36%, 100% 50%, 61% 64%, 50% 100%, 39% 64%, 0 50%, 39% 36%);
      }
      .process-summary__thinking-marker--running {
        animation: thinking-pulse 1.5s infinite ease-in-out;
      }
      .process-summary__thinking-marker--failed {
        background: #ef4444;
      }
      .process-summary__thinking-marker--cancelled,
      .process-summary__thinking-marker--interrupted {
        background: #f59e0b;
      }
      .process-summary__item-heading strong {
        overflow: hidden;
        color: var(--justdo-chat-text, #111827);
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .process-summary__thinking {
        margin-top: 5px;
        color: var(--justdo-chat-muted, #64748b);
        line-height: 1.5;
        max-height: 7.5em;
        overflow-y: auto;
      }
      .process-summary__thinking > :first-child {
        margin-top: 0;
      }
      .process-summary__thinking > :last-child {
        margin-bottom: 0;
      }
      .process-summary__error {
        margin: 5px 0 0;
        color: var(--justdo-chat-danger, #b91c1c);
        font: inherit;
        white-space: pre-wrap;
      }
      .process-summary__tool {
        min-width: 0;
      }
      .process-summary__tool-title {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 7px;
        color: var(--justdo-chat-text, #111827);
        cursor: pointer;
        list-style-position: outside;
      }
      .process-summary__tool-status {
        width: 7px;
        height: 7px;
        flex: 0 0 auto;
        border-radius: 999px;
        background: #f59e0b;
      }
      .process-summary__tool-status--running {
        background: #3b82f6;
        animation: process-pulse 1.4s ease-in-out infinite;
      }
      .process-summary__tool-status--completed {
        background: #22c55e;
      }
      .process-summary__tool-status--failed {
        background: #ef4444;
      }
      .process-summary__tool-status--cancelled,
      .process-summary__tool-status--interrupted {
        background: #f59e0b;
      }
      .process-summary__tool-title strong {
        flex: 0 0 auto;
      }
      .process-summary__tool-input {
        min-width: 0;
        overflow: hidden;
        color: var(--justdo-chat-muted, #64748b);
        font-weight: 400;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .process-summary__tool-detail {
        display: grid;
        gap: 4px;
        margin: 7px 0 0 14px;
      }
      .process-summary__detail-label {
        color: var(--justdo-chat-muted, #64748b);
        font-size: 11px;
        font-weight: 600;
      }
      .process-summary__tool-detail pre {
        max-height: 280px;
        margin: 0 0 4px;
        overflow: auto;
        border-radius: 6px;
        padding: 7px 8px;
        background: var(--justdo-chat-code-bg, rgba(15, 23, 42, 0.05));
        color: var(--justdo-chat-text, #111827);
        font:
          11px/1.5 ui-monospace,
          SFMono-Regular,
          Menlo,
          Monaco,
          Consolas,
          monospace;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .process-live {
        width: min(100%, 680px);
        border-radius: 8px;
        padding: 8px 10px;
        background: var(--justdo-chat-process-bg, rgba(248, 250, 252, 0.58));
        font-size: 12px;
      }
      .process-live__tool > summary {
        list-style-position: outside;
      }
      .execution-plan-update {
        width: min(100%, 680px);
        box-sizing: border-box;
        border: 1px solid color-mix(in srgb, var(--justdo-chat-border, #cbd5e1) 82%, transparent);
        border-left: 3px solid color-mix(in srgb, #22c55e 72%, #94a3b8);
        border-radius: 8px;
        padding: 10px 12px 11px;
        background: color-mix(
          in srgb,
          var(--surface-raised, #ffffff) 88%,
          var(--justdo-chat-process-bg, #f1f5f9)
        );
        box-shadow: 0 1px 3px rgba(15, 23, 42, 0.06);
        color: var(--justdo-chat-text, #111827);
        font-size: 13px;
      }
      .execution-plan-update--failed {
        border-left-color: #ef4444;
      }
      .execution-plan-update__header {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 7px;
        padding-bottom: 8px;
        border-bottom: 1px solid
          color-mix(in srgb, var(--justdo-chat-border, #cbd5e1) 60%, transparent);
      }
      .execution-plan-update__header strong {
        font-size: 13px;
        line-height: 1.3;
      }
      .execution-plan-update__count {
        flex: 0 0 auto;
        border-radius: 999px;
        padding: 2px 7px;
        background: color-mix(in srgb, #22c55e 10%, transparent);
        color: color-mix(in srgb, #15803d 82%, var(--justdo-chat-text, #111827));
        font-size: 11px;
        font-weight: 500;
        font-variant-numeric: tabular-nums;
        line-height: 1.4;
      }
      .execution-plan-update__explanation {
        margin: 8px 1px 0;
        color: var(--justdo-chat-muted, #64748b);
        font-size: 12px;
        line-height: 1.55;
      }
      .execution-plan-update__steps {
        display: grid;
        gap: 3px;
        margin: 8px 0 0;
        padding: 0;
        list-style: none;
      }
      .execution-plan-update__step {
        display: grid;
        min-width: 0;
        grid-template-columns: 15px minmax(0, 1fr);
        gap: 8px;
        align-items: start;
        border-radius: 6px;
        padding: 4px 6px;
        line-height: 1.5;
      }
      .execution-plan-update__marker {
        display: inline-grid;
        width: 13px;
        height: 13px;
        place-items: center;
        margin-top: 3px;
        border: 1px solid var(--justdo-chat-border, rgba(100, 116, 139, 0.55));
        border-radius: 2px;
        color: white;
        font-size: 9px;
        font-weight: 700;
        line-height: 1;
      }
      .execution-plan-update__step--completed {
        color: var(--justdo-chat-muted, #64748b);
      }
      .execution-plan-update__step--in_progress {
        background: color-mix(in srgb, #3b82f6 8%, transparent);
        color: var(--justdo-chat-text, #111827);
        font-weight: 500;
      }
      .execution-plan-update__step--completed .execution-plan-update__marker {
        border-color: #22c55e;
        background: #22c55e;
      }
      .execution-plan-update__step--in_progress .execution-plan-update__marker {
        border-color: #3b82f6;
        border-radius: 999px;
        background: #3b82f6;
        animation: process-pulse 1.4s ease-in-out infinite;
      }
      .execution-plan-update__step-text {
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .timeline-content__body > :first-child {
        margin-top: 0;
      }
      .timeline-content__body > :last-child {
        margin-bottom: 0;
      }
      .timeline-content {
        width: 100%;
        min-width: 0;
        padding: 4px 2px 8px;
        font-size: 14px;
        line-height: 1.65;
      }
      .process-terminal {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        border-radius: 9px;
        padding: 9px 11px;
        background: rgba(254, 242, 242, 0.86);
        color: #b91c1c;
        font-size: 13px;
      }
      .new-messages-indicator {
        position: sticky;
        z-index: 12;
        bottom: 14px;
        display: grid;
        width: 34px;
        height: 34px;
        place-items: center;
        margin: 8px auto 0;
        border: 1px solid rgba(100, 116, 139, 0.2);
        border-radius: 999px;
        padding: 0;
        background: rgba(248, 250, 252, 0.92);
        box-shadow: 0 4px 14px rgba(15, 23, 42, 0.1);
        color: #64748b;
        cursor: pointer;
        transition:
          background 120ms ease,
          color 120ms ease,
          transform 120ms ease;
        backdrop-filter: blur(8px);
      }
      .new-messages-indicator:hover,
      .new-messages-indicator:focus-visible {
        background: rgba(241, 245, 249, 0.98);
        color: #475569;
        outline: none;
        transform: translateY(-1px);
      }
      .new-messages-indicator svg {
        width: 17px;
        height: 17px;
        fill: none;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 1.8;
      }
      :host(.dark) .process-terminal {
        background: rgba(127, 29, 29, 0.2);
        color: #fca5a5;
      }
      :host(.dark) .new-messages-indicator {
        border-color: rgba(148, 163, 184, 0.18);
        background: rgba(30, 41, 59, 0.88);
        color: #94a3b8;
      }
      :host(.dark) .new-messages-indicator:hover,
      :host(.dark) .new-messages-indicator:focus-visible {
        background: rgba(51, 65, 85, 0.94);
        color: #cbd5e1;
      }
      @keyframes process-pulse {
        50% {
          opacity: 0.35;
          transform: scale(0.82);
        }
      }
      @media (max-width: 760px) {
        .chat-minimap {
          display: none;
        }

        .process-summary__items {
          margin-left: 8px;
        }
      }
      @media (prefers-reduced-motion: reduce) {
        .process-summary__thinking-marker--running,
        .process-summary__tool-status--running,
        .execution-plan-update__step--in_progress .execution-plan-update__marker {
          animation: none;
        }
        .new-messages-indicator {
          transition: none;
        }
      }
    `,
  ];

  // ─── Rendering ──────────────────────────────────────────────────────────

  render(): TemplateResult {
    // Use controller state if available, otherwise use direct properties
    const ctrl = this._controller;
    const persistedMessages = ctrl
      ? (ctrl.state.visibleChatMessages as GatewayMessage[])
      : this.messages;
    const activeTurn = ctrl?.state.transcript.activeTurn ?? null;
    let messages = projectPersistedMessagesForActiveTurn(persistedMessages, activeTurn);
    const isStreaming = ctrl ? ctrl.state.chatSending : this.isStreaming;

    // Merge the optimistic prompt in turn order during session transitions.
    const pendingMessage = (ctrl?.state.pendingUserMessage as GatewayMessage | null) ?? null;
    messages = mergePendingUserMessageForDisplay(messages, pendingMessage);

    const terminalProjectionVariant =
      activeTurn && activeTurn.status !== 'running'
        ? `${activeTurn.runId}:${activeTurn.status}:${activeTurn.items
            .filter(item => item.type === 'content')
            .map(item => item.text)
            .join('\n')}`
        : 'live';
    const getHistoryTimeline = () =>
      this.persistedTimelineCache.get(
        {
          sessionKey: ctrl?.state.sessionKey ?? '',
          sessionId: ctrl?.state.currentSessionId ?? null,
          historyGeneration: ctrl?.state.transcript.historyGeneration ?? 0,
          messages: persistedMessages,
          pendingMessage,
          projectionVariant: terminalProjectionVariant,
        },
        () => projectPersistedTimeline(messages),
      );

    if (ctrl) {
      const historyTimeline = getHistoryTimeline();
      const activeTimeline = this.projectActiveTimeline();
      const timelineView = projectIncrementalTimelineView({
        persisted: this.persistedTimelineRenderCache.get(historyTimeline),
        activeTimeline,
        suppressTrailingAssistantFooter: activeTurn !== null || isStreaming,
      });
      this.resolveOpenProcessSummaryKey(
        [
          ...timelineView.persistedRows.map(row => row.item),
          ...(timelineView.seamRow ? [timelineView.seamRow.item] : []),
          ...timelineView.activeRows.map(row => row.item),
        ],
        createProcessSummarySessionIdentity({
          sessionKey: ctrl.state.sessionKey,
          sessionId: ctrl.state.currentSessionId ?? ctrl.state.transcript.sessionId,
          historyGeneration: ctrl.state.transcript.historyGeneration,
        }),
      );
      return html`
        <div class="chat-shell">
          ${this.renderMinimap(
            timelineView.minimapPrefix,
            timelineView.minimapTail,
            timelineView.minimapKeySignature,
          )}
          <div class="chat-container" role="log" aria-busy=${activeTurn?.status === 'running'}>
            <div class="sr-only" role="status" aria-live="polite">
              ${activeTurn ? i18nService.t(this.activeTurnStatusKey(activeTurn)) : nothing}
            </div>
            ${repeat(
              timelineView.persistedRows,
              row => row.item.key,
              row => this.renderVisibleTimelineItem(row.item, row.showAvatar, row.showFooter),
            )}
            ${
              timelineView.seamRow
                ? this.renderVisibleTimelineItem(
                    timelineView.seamRow.item,
                    timelineView.seamRow.showAvatar,
                    timelineView.seamRow.showFooter,
                  )
                : nothing
            }
            ${repeat(
              timelineView.activeRows,
              row => row.item.key,
              row => this.renderVisibleTimelineItem(row.item, row.showAvatar, row.showFooter),
            )}
            ${
              activeTurn && activeTurn.status !== 'running'
                ? html`
                    <section
                      class="active-turn chat-group chat-group--assistant chat-group--continuation"
                    >
                      <div class="chat-group__avatar" aria-hidden="true"></div>
                      <footer class="active-turn__footer">
                        ${this.activeTurnFooter(activeTurn, persistedMessages)}
                      </footer>
                    </section>
                  `
                : nothing
            }
            ${
              this.chatScrollController.state.mode === 'paused'
                ? html`
                    <button
                      type="button"
                      class="new-messages-indicator"
                      data-jump-to-latest
                      aria-label=${i18nService.t('coworkJumpToLatest')}
                      title=${i18nService.t('coworkJumpToLatest')}
                      @click=${() => this._controller?.showLatestHistory()}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M6 9l6 6 6-6"></path>
                      </svg>
                    </button>
                  `
                : nothing
            }
          </div>
        </div>
      `;
    }

    // Direct-property mode remains for standalone consumers without a controller.
    const thinkingMessages: unknown[] = [];
    const toolMessages: unknown[] = [];
    const streamSegments: Array<{ text: string; ts: number }> = [];
    const stream = this.stream;
    const thinkingStream = null;

    if (!isStreaming && !stream) {
      const historyTimeline = getHistoryTimeline();
      const visibleRows = prepareVisibleTimelineRows(historyTimeline);
      const minimapEntries = projectChatMinimapEntries(historyTimeline);
      this.resolveOpenProcessSummaryKey(
        visibleRows.map(row => row.item),
        'direct',
      );
      return html`
        <div class="chat-shell">
          ${this.renderMinimap(minimapEntries)}
          <div class="chat-container" role="log">
            ${repeat(
              visibleRows,
              row => row.item.key,
              row => this.renderVisibleTimelineItem(row.item, row.showAvatar, row.showFooter),
            )}
          </div>
        </div>
      `;
    }

    const hasAssistantStream = Boolean(stream && stream.trim().length > 0);
    const shouldKeepThinkingInTimeline = hasAssistantStream && toolMessages.length > 0;
    const thinkingMessagesForTimeline =
      hasAssistantStream && !shouldKeepThinkingInTimeline
        ? thinkingMessages.slice(0, -1)
        : thinkingMessages;
    const committedThinkingForStream =
      hasAssistantStream && !shouldKeepThinkingInTimeline
        ? this.extractThinkingText(thinkingMessages[thinkingMessages.length - 1])
        : null;
    const thinkingForStreamingGroup = thinkingStream ?? committedThinkingForStream;
    const timelineMessages =
      thinkingMessagesForTimeline.length > 0
        ? [...messages, ...(thinkingMessagesForTimeline as GatewayMessage[])]
        : messages;
    const shouldRenderWaitingStream =
      isStreaming &&
      !hasAssistantStream &&
      !thinkingStream &&
      toolMessages.length === 0 &&
      streamSegments.length === 0;
    const displayStream = shouldRenderWaitingStream ? '' : stream;
    const items = this.buildItems(timelineMessages, toolMessages, streamSegments, displayStream);
    const hasLiveStreamItem = items.some(item => item.kind === 'stream' && item.isStreaming);
    const minimapEntries = projectChatMinimapEntries(
      getHistoryTimeline(),
      displayStream || thinkingForStreamingGroup,
    );
    // Always render the chat container — never show "No messages"
    return html`
      <div class="chat-shell">
        ${this.renderMinimap(minimapEntries)}
        <div class="chat-container">
          ${this.renderItems(items, thinkingForStreamingGroup)}
          ${
            thinkingStream && !hasLiveStreamItem
              ? renderStreamingThinkingGroup(thinkingStream, {
                  showAvatar: !items.some(
                    item => item.kind === 'group' && item.role === 'assistant',
                  ),
                })
              : nothing
          }
        </div>
      </div>
    `;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.chatScrollController.connect(this);
    this.renderRoot?.addEventListener('click', this.handleMarkdownClick);
    this.renderRoot?.addEventListener('keydown', this.handleTimelineKeyDown);
    this.addEventListener('scroll', this.handleMermaidVisibilityScroll, { passive: true });
    this.addEventListener('scroll', this.handleMinimapScroll, { passive: true });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.chatScrollController.disconnect();
    this.streamRenderScheduler.dispose();
    this.persistedTimelineCache.clear();
    this.persistedTimelineRenderCache.clear();
    this.processSummaryTakeoverTracker.clear();
    this.processSummarySessionIdentity = null;
    this.renderedOpenProcessSummaryKey = null;
    this.renderRoot?.removeEventListener('click', this.handleMarkdownClick);
    this.renderRoot?.removeEventListener('keydown', this.handleTimelineKeyDown);
    this.removeEventListener('scroll', this.handleMermaidVisibilityScroll);
    this.removeEventListener('scroll', this.handleMinimapScroll);
    if (this.mermaidScrollFrame !== null) cancelAnimationFrame(this.mermaidScrollFrame);
    this.mermaidScrollFrame = null;
    this.unsubscribeController();
  }

  protected firstUpdated(): void {
    requestAnimationFrame(() => this.updateCurrentMinimapEntry());
    requestAnimationFrame(() => void this.renderMermaidDiagrams());
  }

  protected willUpdate(): void {
    this.focusedProcessSummaryKeyBeforeRender =
      this.renderRoot?.querySelector<HTMLElement>('[data-process-summary-key]:focus')?.dataset
        .processSummaryKey ?? null;
    this.chatScrollController.beforeRender();
  }

  protected updated(changedProperties?: Map<string | number | symbol, unknown>): void {
    if (this.openProcessSummaryKey !== this.renderedOpenProcessSummaryKey) {
      const nextOpenKey = this.renderedOpenProcessSummaryKey;
      const shouldRestoreFocus =
        this.focusedProcessSummaryKeyBeforeRender === this.openProcessSummaryKey &&
        nextOpenKey !== null;
      this.openProcessSummaryKey = nextOpenKey;
      if (shouldRestoreFocus) {
        void this.updateComplete.then(() => {
          this.shadowRoot
            ?.querySelector<HTMLElement>(`[data-process-summary-key="${CSS.escape(nextOpenKey)}"]`)
            ?.focus();
        });
      }
    }
    this.focusedProcessSummaryKeyBeforeRender = null;
    const transcriptRevision =
      this._controller?.state.transcript.revision ??
      this.messages.length + (this.stream?.length ?? 0);
    this.chatScrollController.afterRender(transcriptRevision);
    this.scrollStreamingThinkingToBottom();
    if (changedProperties?.has('searchQuery') || changedProperties?.has('searchCaseSensitive')) {
      this.activeSearchIndex = -1;
      this.clearSearchMarks();
    }
    const searchEnhancementKey = `${this.searchQuery}:${this.searchCaseSensitive}:${transcriptRevision}`;
    if (searchEnhancementKey !== this.lastSearchEnhancementKey) {
      this.lastSearchEnhancementKey = searchEnhancementKey;
      requestAnimationFrame(() => this.emitSearchMatchCount());
    }
    const completedContentKey =
      this._controller?.state.transcript.activeTurn?.items
        .filter(item => item.type === 'content' && item.status !== 'streaming')
        .map(item => `${item.id}:${item.lastSeq}`)
        .join('|') ?? '';
    const mermaidEnhancementKey = `${this.persistedTimelineCache.revision}:${completedContentKey}`;
    if (mermaidEnhancementKey !== this.lastMermaidEnhancementKey) {
      this.lastMermaidEnhancementKey = mermaidEnhancementKey;
      requestAnimationFrame(() => void this.renderMermaidDiagrams());
    }
    const minimapSyncKey = `${this.persistedTimelineCache.revision}:${this.persistedTimelineRenderCache.revision}:${this.minimapEntriesSignature}`;
    if (minimapSyncKey !== this.lastMinimapSyncKey) {
      this.lastMinimapSyncKey = minimapSyncKey;
      requestAnimationFrame(() => this.updateCurrentMinimapEntry());
    }
  }

  private scrollStreamingThinkingToBottom(): void {
    const contents = this.renderRoot.querySelectorAll<HTMLElement>(
      '.chat-thinking--streaming .chat-thinking__content',
    );
    for (const content of contents) {
      const previousScrollHeight = this.streamingThinkingScrollHeights.get(content);
      if (previousScrollHeight !== content.scrollHeight) {
        content.scrollTop = content.scrollHeight;
        this.streamingThinkingScrollHeights.set(content, content.scrollHeight);
      }
    }
  }

  private resolveOpenProcessSummaryKey(
    items: ReadonlyArray<PersistedTimelineItem | ActiveTurnTimelineItem>,
    sessionIdentity: string,
  ): void {
    if (this.processSummarySessionIdentity !== sessionIdentity) {
      this.processSummaryTakeoverTracker.clear();
      this.processSummarySessionIdentity = sessionIdentity;
      this.renderedOpenProcessSummaryKey = null;
      return;
    }
    this.renderedOpenProcessSummaryKey = this.processSummaryTakeoverTracker.resolve(
      this.openProcessSummaryKey,
      items,
    );
  }

  private readonly handleMarkdownClick = (event: Event): void => {
    const element = event.composedPath().find(node => node instanceof HTMLElement) as
      HTMLElement | undefined;
    const summaryButton = element?.closest<HTMLElement>('[data-process-summary-key]');
    if (summaryButton) {
      const summaryKey = summaryButton.dataset.processSummaryKey ?? null;
      this.openProcessSummaryKey =
        this.renderedOpenProcessSummaryKey === summaryKey ? null : summaryKey;
      return;
    }
    if (element?.closest('[data-jump-to-latest]')) {
      this.chatScrollController.jumpToLatest();
      return;
    }
    const copyTarget = event
      .composedPath()
      .find(node => node instanceof HTMLElement && node.classList.contains('code-block-copy')) as
      HTMLButtonElement | undefined;
    if (copyTarget) {
      event.preventDefault();
      event.stopPropagation();
      const code = copyTarget.dataset.code;
      if (code === undefined) return;
      void this.copyCodeBlock(copyTarget, code);
      return;
    }

    const target = event
      .composedPath()
      .find(node => node instanceof HTMLElement && node.classList.contains('mermaid-toggle')) as
      HTMLButtonElement | undefined;
    if (!target) return;

    const block = target.closest<HTMLElement>('.mermaid-block');
    if (!block) return;
    const showSource = !block.classList.contains('is-source');
    block.classList.toggle('is-source', showSource);
    const preview = block.querySelector<HTMLElement>('.mermaid-preview');
    const source = block.querySelector<HTMLElement>('.mermaid-source');
    const label = block.querySelector<HTMLElement>('.code-block-lang');
    if (preview) preview.hidden = showSource;
    if (source) source.hidden = !showSource;
    if (label) label.textContent = showSource ? 'mermaid' : 'mermaid (rendered)';
    const buttonLabel = i18nService.t(showSource ? 'renderDiagram' : 'showCode');
    target.setAttribute('aria-label', buttonLabel);
    target.title = buttonLabel;
  };

  private readonly handleTimelineKeyDown = (event: Event): void => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key !== 'Escape' || !this.openProcessSummaryKey) return;
    keyboardEvent.preventDefault();
    const summaryKey = this.openProcessSummaryKey;
    this.openProcessSummaryKey = null;
    void this.updateComplete.then(() => {
      this.shadowRoot
        ?.querySelector<HTMLElement>(`[data-process-summary-key="${CSS.escape(summaryKey)}"]`)
        ?.focus();
    });
  };

  private readonly handleMermaidVisibilityScroll = (): void => {
    if (this.mermaidScrollFrame !== null) return;
    this.mermaidScrollFrame = requestAnimationFrame(() => {
      this.mermaidScrollFrame = null;
      void this.renderMermaidDiagrams();
    });
  };

  private async copyCodeBlock(button: HTMLButtonElement, code: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
      button.classList.add('copied');
      window.setTimeout(() => {
        button.classList.remove('copied');
      }, 1500);
    } catch (error) {
      console.error('[JustDoChat] Failed to copy code block', error);
    }
  }

  private async renderMermaidDiagrams(): Promise<void> {
    const blocks = this.renderRoot.querySelectorAll<HTMLElement>(
      '.mermaid-block:not([data-mermaid-rendered])',
    );
    for (const block of blocks) {
      const hostRect = this.getBoundingClientRect();
      const blockRect = block.getBoundingClientRect();
      if (blockRect.bottom < hostRect.top || blockRect.top > hostRect.bottom) continue;
      block.dataset.mermaidRendered = 'true';
      const preview = block.querySelector<HTMLElement>('.mermaid-preview');
      const code = block.querySelector<HTMLElement>('.mermaid-source code')?.textContent;
      if (!preview || !code) continue;
      try {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: document.documentElement.classList.contains('dark') ? 'dark' : 'default',
        });
        const id = `justdo-mermaid-${crypto.randomUUID()}`;
        const svg = await renderMermaidSvg(id, code);
        preview.innerHTML = svg;
        this.resizeMermaidBubble(block, preview);
      } catch (error) {
        preview.classList.add('mermaid-error');
        preview.textContent =
          error instanceof Error ? error.message : i18nService.t('mermaidRenderFailed');
      }
    }
  }

  private resizeMermaidBubble(block: HTMLElement, preview: HTMLElement): void {
    const svg = preview.querySelector<SVGSVGElement>('svg');
    const bubble = block.closest<HTMLElement>('.chat-bubble--assistant');
    if (!svg || !bubble) return;

    const diagramWidth = svg.viewBox.baseVal.width || svg.getBoundingClientRect().width;
    const preferredWidth = Math.min(
      MERMAID_BUBBLE_MAX_WIDTH,
      Math.max(MERMAID_BUBBLE_MIN_WIDTH, diagramWidth + MERMAID_BUBBLE_HORIZONTAL_PADDING),
    );
    const currentWidth = Number.parseFloat(bubble.style.width) || 0;
    bubble.style.width = `${Math.max(currentWidth, preferredWidth)}px`;
  }

  private subscribeController(ctrl: ChatController): void {
    this._controllerUnsubscribe = ctrl.subscribe(() => this.requestUpdate());
    this._streamUnsubscribe = ctrl.onStream(kind => {
      if (kind === 'tool-partial') {
        this.streamRenderScheduler.scheduleToolPartial();
      } else if (kind === 'terminal') {
        this.streamRenderScheduler.flush();
      } else {
        this.streamRenderScheduler.schedule();
      }
    });
  }

  private unsubscribeController(): void {
    this._controllerUnsubscribe?.();
    this._streamUnsubscribe?.();
    this._controllerUnsubscribe = null;
    this._streamUnsubscribe = null;
  }

  public getSearchMatchCount(): number {
    return this.collectSearchMatches().length;
  }

  public navigateSearch(direction: 1 | -1): { index: number; total: number } {
    this.clearSearchMarks();
    const matches = this.collectSearchMatches();
    const total = matches.length;
    if (total === 0) {
      this.activeSearchIndex = -1;
      this.clearSearchMarks();
      return { index: -1, total: 0 };
    }

    this.activeSearchIndex =
      this.activeSearchIndex < 0
        ? direction === 1
          ? 0
          : total - 1
        : (this.activeSearchIndex + direction + total) % total;

    this.highlightSearchMatch(matches[this.activeSearchIndex]);
    return { index: this.activeSearchIndex, total };
  }

  private emitSearchMatchCount(): void {
    const total = this.getSearchMatchCount();
    if (this.activeSearchIndex >= total) {
      this.activeSearchIndex = total > 0 ? total - 1 : -1;
    }
    this.dispatchEvent(
      new CustomEvent('search-match-count-change', {
        detail: { total, index: this.activeSearchIndex },
      }),
    );
  }

  private collectSearchMatches(): Array<{ node: Text; start: number; end: number }> {
    const query = this.searchQuery.trim();
    const root = this.shadowRoot?.querySelector('.chat-container');
    if (!query || !root) return [];

    const matcher = new RegExp(this.escapeRegExp(query), this.searchCaseSensitive ? 'g' : 'gi');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || !node.nodeValue) return NodeFilter.FILTER_REJECT;
        if (parent.closest('.chat-group__footer, button, input, textarea, select')) {
          return NodeFilter.FILTER_REJECT;
        }
        matcher.lastIndex = 0;
        return matcher.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });

    const matches: Array<{ node: Text; start: number; end: number }> = [];
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const text = node.nodeValue ?? '';
      matcher.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = matcher.exec(text))) {
        matches.push({ node, start: match.index, end: match.index + match[0].length });
        if (match[0].length === 0) matcher.lastIndex += 1;
      }
    }
    return matches;
  }

  private highlightSearchMatch(
    match: { node: Text; start: number; end: number } | undefined,
  ): void {
    this.clearSearchMarks();
    if (!match) return;

    const range = document.createRange();
    range.setStart(match.node, match.start);
    range.setEnd(match.node, match.end);

    const mark = document.createElement('span');
    mark.className = 'chat-search-mark';
    mark.dataset.justdoSearchMark = 'true';
    range.surroundContents(mark);
    this.expandSearchMatchContainers(mark);
    mark.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  }

  private expandSearchMatchContainers(mark: HTMLElement): void {
    let current: HTMLElement | null = mark;
    while (current) {
      const details: HTMLDetailsElement | null = current.closest('details');
      if (!details) return;
      details.open = true;
      current = details.parentElement;
    }
  }

  private clearSearchMarks(): void {
    const root = this.shadowRoot;
    if (!root) return;
    root.querySelectorAll<HTMLElement>('[data-justdo-search-mark="true"]').forEach(mark => {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark);
      parent.normalize();
    });
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private buildItems(
    messages?: unknown[],
    toolMessages?: unknown[],
    streamSegments?: Array<{ text: string; ts: number }>,
    stream?: string | null,
  ): Array<ChatItem | MessageGroup> {
    const msgs = messages ?? this.messages ?? [];

    try {
      const result = buildChatItems({
        sessionKey: '',
        messages: msgs,
        toolMessages: toolMessages ?? [],
        stream: stream ?? this.stream,
        streamStartedAt: this.streamStartedAt,
        streamSegments: streamSegments ?? [],
        queue: [],
        showToolCalls: true,
      });
      return result ?? [];
    } catch (err) {
      console.error('[justdo-chat] buildChatItems error:', err);
      return [];
    }
  }

  private activeTurnStatusKey(turn: AssistantTurn): string {
    if (turn.status === 'final') return 'coworkRunStateDone';
    if (turn.status === 'aborted' || turn.status === 'error') {
      return 'coworkRunStateInterrupted';
    }
    const last = turn.items[turn.items.length - 1];
    if (last?.type === 'thinking' && last.status === 'running') {
      return 'coworkRunStateThinking';
    }
    if (last?.type === 'tool' && last.status === 'running') return 'coworkRunStateTool';
    if (last?.type === 'content' && last.status === 'streaming') {
      return 'coworkRunStateResponding';
    }
    return 'coworkRunStateStarting';
  }

  private activeTurnFooter(
    turn: AssistantTurn,
    persistedMessages: GatewayMessage[],
  ): TemplateResult {
    const assistantMessage = [...persistedMessages]
      .reverse()
      .find(message => String(message.role ?? '').toLowerCase() === 'assistant') as
      Record<string, unknown> | undefined;
    const model =
      (typeof assistantMessage?.modelName === 'string' && assistantMessage.modelName) ||
      (typeof assistantMessage?.model === 'string' && assistantMessage.model) ||
      '';
    const timestamp = new Date(turn.endedAt ?? turn.startedAt).toLocaleString();
    return html`
      ${model ? html`<span>${model}</span><span>·</span>` : nothing}
      <time datetime=${new Date(turn.endedAt ?? turn.startedAt).toISOString()}>${timestamp}</time>
    `;
  }

  private renderVisibleTimelineItem(
    item: PersistedTimelineItem | ActiveTurnTimelineItem,
    showAvatar: boolean,
    showFooter: boolean,
  ): TemplateResult | typeof nothing {
    if (item.kind === 'history-message') {
      return html`
        <div data-history-key=${item.key} data-minimap-anchor=${item.key}>
          ${this.renderItems(
            this.buildItems([item.message], [], [], null),
            null,
            showAvatar,
            showFooter,
          )}
        </div>
      `;
    }
    return renderTimelineItem(
      item,
      Date.now(),
      item.kind === 'process-summary' && this.renderedOpenProcessSummaryKey === item.key,
      showAvatar,
    );
  }

  private renderMinimap(
    entries: readonly ChatMinimapEntry[],
    tail: ChatMinimapEntry | null = null,
    keySignature?: string,
  ): TemplateResult | typeof nothing {
    this.latestMinimapPrefix = entries;
    this.latestMinimapTail = tail;
    this.minimapEntriesSignature =
      keySignature ?? [...entries.map(entry => entry.key), ...(tail ? [tail.key] : [])].join('|');
    if (entries.length + (tail ? 1 : 0) < MINIMAP_VISIBLE_ENTRY_THRESHOLD) return nothing;

    const hoveredEntry =
      (tail?.key === this.hoveredMinimapKey ? tail : null) ??
      entries.find(entry => entry.key === this.hoveredMinimapKey) ??
      null;
    return html`
      <nav
        class="chat-minimap"
        aria-label=${i18nService.t('coworkMinimapLabel')}
        @mouseleave=${() => {
          this.hoveredMinimapKey = null;
        }}
      >
        <div class="chat-minimap__track">
          ${repeat(
            entries,
            entry => entry.key,
            entry => this.renderMinimapEntry(entry),
          )}
          ${tail ? this.renderMinimapEntry(tail) : nothing}
        </div>
        ${
          hoveredEntry
            ? html`
                <div
                  class="chat-minimap__preview"
                  style=${`top: ${this.minimapPreviewTop}px`}
                  aria-hidden="true"
                >
                  <div class="chat-minimap__preview-user">
                    ${hoveredEntry.userText || i18nService.t('coworkMinimapUserMessage')}
                  </div>
                  ${
                    hoveredEntry.assistantText
                      ? html`
                          <div class="chat-minimap__preview-assistant">
                            ${hoveredEntry.assistantText}
                          </div>
                        `
                      : nothing
                  }
                </div>
              `
            : nothing
        }
      </nav>
    `;
  }

  private renderMinimapEntry(entry: ChatMinimapEntry): TemplateResult {
    const active = entry.key === this.currentMinimapKey;
    const lineWidth = Math.min(
      12,
      5 + Math.ceil((entry.userText.length + entry.assistantText.length) / 64),
    );
    return html`
      <button
        type="button"
        class=${`chat-minimap__item${active ? ' chat-minimap__item--active' : ''}`}
        aria-current=${active ? 'true' : nothing}
        aria-label=${entry.userText || i18nService.t('coworkMinimapUserMessage')}
        @click=${() => this.scrollToMinimapEntry(entry)}
        @mouseenter=${(event: MouseEvent) => this.showMinimapPreview(entry, event)}
        @focus=${(event: FocusEvent) => this.showMinimapPreview(entry, event)}
        @blur=${() => {
          this.hoveredMinimapKey = null;
        }}
      >
        <span
          class="chat-minimap__line"
          style=${`--minimap-line-width: ${lineWidth}px`}
          aria-hidden="true"
        ></span>
      </button>
    `;
  }

  private minimapEntryCount(): number {
    return this.latestMinimapPrefix.length + (this.latestMinimapTail ? 1 : 0);
  }

  private minimapEntryAt(index: number): ChatMinimapEntry | null {
    if (index < this.latestMinimapPrefix.length) {
      return this.latestMinimapPrefix[index] ?? null;
    }
    return index === this.latestMinimapPrefix.length ? this.latestMinimapTail : null;
  }

  private scrollToMinimapEntry(entry: ChatMinimapEntry): void {
    let entryIndex = this.latestMinimapPrefix.findIndex(candidate => candidate.key === entry.key);
    if (entryIndex < 0 && this.latestMinimapTail?.key === entry.key) {
      entryIndex = this.latestMinimapPrefix.length;
    }
    const target = this.resolveMinimapAnchor(entry, entryIndex);
    if (!target) return;

    const hostTop = this.getBoundingClientRect().top;
    const targetTop = target.getBoundingClientRect().top;
    const nextScrollTop = Math.max(0, this.scrollTop + targetTop - hostTop - 16);
    this.currentMinimapKey = entry.key;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    this.scrollTo({ top: nextScrollTop, behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  private readonly handleMinimapScroll = (): void => {
    this.updateCurrentMinimapEntry();
  };

  private updateCurrentMinimapEntry(): void {
    const entryCount = this.minimapEntryCount();
    if (entryCount < MINIMAP_VISIBLE_ENTRY_THRESHOLD) {
      if (this.currentMinimapKey !== null) this.currentMinimapKey = null;
      return;
    }

    const hostRect = this.getBoundingClientRect();
    const activationTop = hostRect.top + Math.min(120, Math.max(48, this.clientHeight * 0.18));
    let current = this.minimapEntryAt(0);
    for (let index = 0; index < entryCount; index += 1) {
      const entry = this.minimapEntryAt(index);
      if (!entry) continue;
      const anchor = this.resolveMinimapAnchor(entry, index);
      if (!anchor) continue;
      if (anchor.getBoundingClientRect().top <= activationTop) current = entry;
      else break;
    }
    if (this.scrollHeight - this.scrollTop - this.clientHeight <= 1) {
      current = this.minimapEntryAt(entryCount - 1) ?? current;
    }
    const nextKey = current?.key ?? null;
    if (nextKey !== this.currentMinimapKey) this.currentMinimapKey = nextKey;
  }

  private resolveMinimapAnchor(entry: ChatMinimapEntry, entryIndex: number): HTMLElement | null {
    const keyedAnchor = this.renderRoot.querySelector<HTMLElement>(
      `[data-minimap-anchor="${CSS.escape(entry.anchorKey)}"]`,
    );
    if (keyedAnchor) return keyedAnchor;
    if (entryIndex < 0) return null;
    return (
      this.renderRoot.querySelectorAll<HTMLElement>('.chat-container .chat-group--user')[
        entryIndex
      ] ?? null
    );
  }

  private showMinimapPreview(entry: ChatMinimapEntry, event: Event): void {
    const target = event.currentTarget as HTMLElement;
    const minimap = target.closest<HTMLElement>('.chat-minimap');
    if (!minimap) return;
    const targetRect = target.getBoundingClientRect();
    const minimapRect = minimap.getBoundingClientRect();
    const targetCenter = targetRect.top + targetRect.height / 2 - minimapRect.top;
    this.minimapPreviewTop = Math.max(28, Math.min(minimapRect.height - 28, targetCenter));
    this.hoveredMinimapKey = entry.key;
  }

  private projectActiveTimeline() {
    const turn = this._controller?.state.transcript.activeTurn ?? null;
    return projectTurnItems(turn);
  }

  private renderItem(
    item: ChatItem | MessageGroup,
    thinkingStream: string | null = null,
    showAvatar = true,
  ): TemplateResult | typeof nothing {
    if (!item) return nothing;

    if ('kind' in item) {
      if (item.kind === 'group') {
        return renderMessageBlock(item as MessageGroup, {
          searchQuery: this.searchQuery,
          showAvatar,
          assistantName: this.assistantName,
          workingDirectory: this.workingDirectory,
        });
      }
      if (item.kind === 'stream') {
        const streamItem = item as {
          kind: 'stream';
          text: string;
          thinkingText?: string | null;
          startedAt: number;
          isStreaming: boolean;
        };
        const thinkingText =
          streamItem.thinkingText ?? (streamItem.isStreaming ? thinkingStream : null);
        return renderStreamingGroup(streamItem.text, streamItem.startedAt, thinkingText, {
          showAvatar,
        });
      }
      if (item.kind === 'divider') {
        if (item.expandable === false) {
          return html`
            <div class="chat-divider">
              <span class="chat-divider__summary" title=${item.description ?? item.label}>
                ${item.label}
              </span>
            </div>
          `;
        }
        const summary = item.summary?.trim() || i18nService.t('coworkCompactSummaryUnavailable');
        return html`
          <div class="chat-divider">
            <details class="chat-divider__details">
              <summary class="chat-divider__summary" title=${i18nService.t('coworkCompactDetails')}>
                ${item.label}
              </summary>
              <div class="chat-divider__content">${summary}</div>
            </details>
          </div>
        `;
      }
      if (item.kind === 'reading-indicator') {
        return nothing;
      }
    }

    return nothing;
  }

  private renderItems(
    items: Array<ChatItem | MessageGroup>,
    thinkingStream: string | null = null,
    initialAssistantAvatar?: boolean,
    allowFooter = true,
  ): Array<TemplateResult | typeof nothing> {
    const rendered: Array<TemplateResult | typeof nothing> = [];

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const prev = items[index - 1];
      const next = items[index + 1];
      if (
        item?.kind === 'group' &&
        item.role === 'assistant' &&
        next?.kind === 'stream' &&
        next.isStreaming
      ) {
        rendered.push(
          renderMessageBlockWithTrailingStream(item, next.text, thinkingStream, {
            searchQuery: this.searchQuery,
            showAvatar: shouldRenderGroupAvatarByPrevItem(item as MessageGroup, prev),
            workingDirectory: this.workingDirectory,
          }),
        );
        index += 1;
        continue;
      }

      if (item?.kind === 'group') {
        const showAvatar =
          index === 0 && item.role === 'assistant'
            ? (initialAssistantAvatar ??
              shouldRenderGroupAvatarByPrevItem(item as MessageGroup, prev))
            : shouldRenderGroupAvatarByPrevItem(item as MessageGroup, prev);
        rendered.push(
          renderMessageBlock(item as MessageGroup, {
            searchQuery: this.searchQuery,
            showFooter:
              allowFooter && shouldRenderGroupFooterByNextItem(item as MessageGroup, next),
            showAvatar,
            assistantName: this.assistantName,
            workingDirectory: this.workingDirectory,
          }),
        );
        continue;
      }

      const showAvatar =
        item?.kind === 'stream'
          ? !(prev?.kind === 'group' && prev.role === 'assistant') && prev?.kind !== 'stream'
          : true;
      rendered.push(this.renderItem(item, thinkingStream, showAvatar));
    }

    return rendered;
  }

  private extractThinkingText(message: unknown): string | null {
    const content = (message as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(content)) return null;

    const text = content
      .map(item => (item as Record<string, unknown> | undefined)?.thinking)
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n')
      .trim();
    return text || null;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'justdo-chat': JustDoChatElement;
  }
}
