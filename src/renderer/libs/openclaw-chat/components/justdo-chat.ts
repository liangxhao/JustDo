/**
 * <justdo-chat> Lit custom element.
 * Renders OpenClaw-style chat messages in a shadow DOM.
 *
 * Can receive messages either:
 * 1. Directly via properties (messages, stream, etc.)
 * 2. Via a ChatController reference (controller property)
 */
import { css, html, LitElement, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

import type { ChatController } from '../gateway/chat-controller';
import { buildChatItems } from '../pipeline/build-chat-items';
import { extractTextCached } from '../pipeline/message-extract';
import type { ChatItem, GatewayMessage, MessageGroup } from '../types';
import {
  renderMessageGroup,
  renderReadingIndicatorGroup,
  renderStreamingGroup,
  renderStreamingThinkingGroup,
} from './grouped-render';

type ChatMinimapEntry = {
  index: number;
  role: 'user' | 'assistant';
  label: string;
  contentLen: number;
};

const MINIMAP_VISIBLE_ENTRY_THRESHOLD = 4;
const MINIMAP_NAV_LOCK_DURATION = 800;

@customElement('justdo-chat')
export class JustDoChatElement extends LitElement {
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
  declare searchQuery: string;

  @property({ type: Boolean, attribute: false })
  declare searchCaseSensitive: boolean;

  @state()
  declare private currentMinimapIndex: number;

  @state()
  declare private hoveredMinimapIndex: number | null;

  @state()
  declare private isMinimapHovered: boolean;

  @state()
  declare private minimapTooltipTop: number;

  constructor() {
    super();
    this.messages = [];
    this.stream = null;
    this.streamStartedAt = null;
    this.isStreaming = false;
    this.searchQuery = '';
    this.searchCaseSensitive = false;
    this.currentMinimapIndex = -1;
    this.hoveredMinimapIndex = null;
    this.isMinimapHovered = false;
    this.minimapTooltipTop = 0;
  }

  /** ChatController reference (preferred — connects directly to gateway) */
  private _controller: ChatController | null = null;
  private _controllerUnsubscribe: (() => void) | null = null;
  private _streamUnsubscribe: (() => void) | null = null;
  private isMinimapNavigating = false;
  private minimapNavigatingTimer: ReturnType<typeof setTimeout> | null = null;
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

  static styles = css`
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

    :host(.full-width) .chat-container {
      width: 100%;
      max-width: 100%;
      padding-left: 8px;
      padding-right: 8px;
    }

    .chat-minimap {
      position: sticky;
      top: 50%;
      float: right;
      width: 20px;
      max-height: calc(100vh - 40px);
      margin: 20px 18px 20px 0;
      transform: translateY(-50%);
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      z-index: 10;
      pointer-events: auto;
    }

    .chat-minimap__arrow {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      margin-right: -5px;
      padding: 0;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: #525252;
      cursor: pointer;
      opacity: 1;
      transition:
        opacity 140ms ease,
        background 140ms ease,
        color 140ms ease;
    }

    .chat-minimap:not(.chat-minimap--hovered) .chat-minimap__arrow {
      opacity: 0;
      pointer-events: none;
    }

    .chat-minimap__arrow:hover {
      background: rgba(229, 229, 229, 0.7);
      color: #262626;
    }

    .chat-minimap__arrow:disabled {
      cursor: default;
      opacity: 0.3;
      background: transparent;
    }

    .chat-minimap__arrow--up {
      margin-bottom: 8px;
    }

    .chat-minimap__arrow--down {
      margin-top: 8px;
    }

    .chat-minimap__arrow svg {
      width: 14px;
      height: 14px;
    }

    .chat-minimap__lines {
      width: 100%;
      min-height: 0;
      flex: 1;
      overflow-y: auto;
      scrollbar-width: none;
    }

    .chat-minimap__lines::-webkit-scrollbar {
      display: none;
    }

    .chat-minimap__item {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      width: 20px;
      padding: 5px 0;
      border: 0;
      background: transparent;
      cursor: pointer;
    }

    .chat-minimap__line {
      height: 2px;
      border-radius: 999px;
      background: #d4d4d4;
      transition:
        width 140ms ease,
        background 140ms ease;
    }

    .chat-minimap__item--active .chat-minimap__line,
    .chat-minimap__item:hover .chat-minimap__line {
      width: 16px !important;
      background: #262626;
    }

    .chat-minimap__tooltip {
      position: absolute;
      right: 28px;
      z-index: 100;
      width: min(360px, calc(100vw - 96px));
      box-sizing: border-box;
      padding: 8px 14px;
      border: 1px solid rgba(229, 229, 229, 0.8);
      background: #fafafa;
      border-radius: 12px;
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.12);
      transform: translateY(-50%);
      pointer-events: none;
      overflow: hidden;
      font-size: 13px;
      line-height: 1.35;
      color: #525252;
    }

    .chat-minimap__tooltip--user {
      border-radius: 12px 12px 4px 12px;
      background: #ffffff;
    }

    .chat-minimap__tooltip-text {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      word-break: break-all;
    }

    @media (max-width: 760px) {
      .chat-minimap {
        display: none;
      }
    }

    @media (max-height: 520px) {
      .chat-minimap {
        display: none;
      }
    }

    /* ── Chat Group ─────────────────────────────────────────────────── */

    .chat-group {
      display: flex;
      gap: 12px;
      padding: 8px 0;
      align-items: flex-start;
    }

    .chat-group--user {
      flex-direction: row-reverse;
    }

    .chat-group__avatar {
      flex-shrink: 0;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
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

    .chat-group__footer {
      font-size: 11px;
      color: var(--justdo-chat-text-secondary, #9ca3af);
      margin-top: 4px;
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
      background: color-mix(in srgb, var(--justdo-chat-assistant-bg, #ffffff) 74%, rgba(0, 0, 0, 0.14));
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
      background: color-mix(in srgb, var(--justdo-chat-user-bg, #eaf1fc) 74%, rgba(0, 0, 0, 0.14));
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

    .chat-bubble--assistant {
      background: var(--justdo-chat-assistant-bg, #ffffff);
      color: var(--justdo-chat-assistant-text, inherit);
      border-bottom-left-radius: 4px;
      max-width: calc(100% - 44px);
      width: fit-content;
    }

    .chat-bubble--streaming {
      border-left: 3px solid var(--justdo-chat-accent, #6366f1);
    }

    .chat-bubble__text {
      white-space: pre-wrap;
    }

    .chat-bubble__text.markdown-content {
      white-space: normal;
    }

    .markdown-content {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    /* ── Markdown Content ───────────────────────────────────────────── */

    .markdown-content p {
      margin: 0 0 8px 0;
    }

    .markdown-content p:last-child {
      margin-bottom: 0;
    }

    .markdown-content h1,
    .markdown-content h2,
    .markdown-content h3,
    .markdown-content h4 {
      margin: 16px 0 8px 0;
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
      margin: 4px 0;
    }

    .markdown-content li {
      margin: 2px 0;
    }

    .markdown-content blockquote {
      border-left: 3px solid var(--justdo-chat-border, #d1d5db);
      margin: 8px 0;
      padding: 4px 12px;
      color: var(--justdo-chat-text-secondary, #6b7280);
    }

    .markdown-content table {
      border-collapse: collapse;
      margin: 8px 0;
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
      margin: 4px 0;
    }

    .markdown-content .markdown-plain-text-fallback {
      white-space: pre-wrap;
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace;
      font-size: 13px;
      line-height: 1.5;
    }

    /* ── Code Blocks ────────────────────────────────────────────────── */

    .markdown-content pre {
      background: var(--justdo-chat-code-bg, #1e1e1e);
      color: var(--justdo-chat-code-text, #d4d4d4);
      padding: 12px;
      border-radius: 8px;
      max-width: 100%;
      box-sizing: border-box;
      overflow-x: auto;
      font-size: 13px;
      line-height: 1.5;
      margin: 8px 0;
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
      margin: 8px 0;
    }

    .code-block-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 12px;
      background: var(--justdo-chat-code-header-bg, #2d2d2d);
      border-radius: 8px 8px 0 0;
      font-size: 12px;
    }

    .code-block-wrapper pre {
      margin-top: 0;
      border-radius: 0 0 8px 8px;
    }

    .code-block-lang {
      color: var(--justdo-chat-text-secondary, #9ca3af);
      font-size: 11px;
      text-transform: uppercase;
    }

    .code-block-copy {
      background: none;
      border: 1px solid var(--justdo-chat-border, rgba(255, 255, 255, 0.15));
      color: var(--justdo-chat-text-secondary, #9ca3af);
      cursor: pointer;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      transition: all 0.15s;
    }

    .code-block-copy:hover {
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
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
      margin: 8px 0;
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
    :host(.dark) .code-block-header {
      background: #161b22;
    }
    :host(.dark) .markdown-content pre {
      background: #161b22;
    }

    /* ── Thinking Block ─────────────────────────────────────────────── */

    .chat-thinking {
      width: fit-content;
      max-width: calc(100% - 44px);
      margin: 2px 0 6px;
      box-sizing: border-box;
    }

    .chat-thinking__summary {
      cursor: pointer;
      font-size: 12px;
      color: var(--justdo-chat-text-secondary, #9ca3af);
      padding: 2px 0 3px;
      user-select: none;
    }

    .chat-thinking__content {
      padding: 7px 10px;
      background: var(--justdo-chat-thinking-bg, rgba(0, 0, 0, 0.02));
      border-radius: 8px;
      font-size: 13px;
      color: var(--justdo-chat-text-secondary, #6b7280);
      margin-top: 3px;
      border: 1px solid var(--justdo-chat-border, rgba(0, 0, 0, 0.04));
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
      margin-top: 3px;
    }

    .chat-thinking--streaming .chat-thinking__content {
      max-height: 200px;
      overflow-y: auto;
    }

    .chat-thinking__header {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--justdo-chat-text-secondary, #9ca3af);
      padding: 2px 0 3px;
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

    /* ── Tool Messages ──────────────────────────────────────────────── */

    .tool-message {
      width: fit-content;
      margin: 4px 0;
      padding: 8px 12px;
      background: var(--justdo-chat-tool-bg, #f3f4f6);
      border-radius: 8px;
      border-left: 3px solid var(--justdo-chat-tool-border, #6b7280);
      max-width: calc(100% - 44px);
      box-sizing: border-box;
    }

    .tool-message--error {
      border-left-color: var(--justdo-chat-error, #ef4444);
    }

    .tool-message__header {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      list-style: none;
    }

    .tool-message__header::-webkit-details-marker,
    .tool-card__name::-webkit-details-marker {
      display: none;
    }

    .tool-message__icon {
      display: flex;
      align-items: center;
      color: var(--justdo-chat-text-secondary, #6b7280);
    }

    .tool-message__output {
      font-size: 12px;
      max-height: 200px;
      overflow: auto;
      margin: 4px 0 0 0;
    }

    .tool-message__details,
    .tool-card__details {
      display: grid;
      gap: 8px;
      margin-top: 8px;
    }

    .tool-detail-box {
      overflow: hidden;
      border: 1px solid var(--justdo-chat-border, rgba(0, 0, 0, 0.08));
      border-radius: 6px;
      background: var(--justdo-chat-tool-detail-bg, rgba(255, 255, 255, 0.72));
    }

    .tool-detail-box__label {
      padding: 5px 8px;
      border-bottom: 1px solid var(--justdo-chat-border, rgba(0, 0, 0, 0.08));
      color: var(--justdo-chat-text-secondary, #6b7280);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    .tool-detail-box pre {
      max-height: 240px;
      margin: 0;
      padding: 8px;
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 12px;
    }

    /* ── Tool Timeline ──────────────────────────────────────────────── */

    .tool-timeline {
      width: fit-content;
      margin: 6px 0 8px;
      max-width: calc(100% - 44px);
      box-sizing: border-box;
    }

    .tool-timeline__summary {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 0;
      cursor: pointer;
      font-size: 12px;
      color: var(--justdo-chat-text-secondary, #6b7280);
      list-style: none;
      user-select: none;
    }

    .tool-timeline__summary::before {
      content: '>';
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 12px;
      height: 12px;
      color: currentColor;
      font-size: 11px;
      line-height: 1;
      transition: transform 120ms ease;
    }

    .tool-timeline[open] .tool-timeline__summary::before {
      transform: rotate(90deg);
    }

    .tool-timeline__summary:hover {
      color: var(--justdo-chat-text, #1a1a1a);
    }

    .tool-timeline__summary::-webkit-details-marker,
    .tool-timeline__title::-webkit-details-marker {
      display: none;
    }

    .tool-timeline__list {
      position: relative;
      display: grid;
      gap: 8px;
      margin: 0;
      padding: 6px 0 0 18px;
      list-style: none;
    }

    .tool-timeline__list::before {
      content: '';
      position: absolute;
      left: 6px;
      top: 2px;
      bottom: 2px;
      width: 1px;
      background: var(--justdo-chat-border, rgba(0, 0, 0, 0.12));
    }

    .tool-timeline__item {
      position: relative;
      display: grid;
      grid-template-columns: 14px minmax(0, 1fr);
      gap: 8px;
      min-width: 0;
    }

    .tool-timeline__marker {
      position: relative;
      z-index: 1;
      width: 9px;
      height: 9px;
      margin-top: 7px;
      border-radius: 50%;
      background: var(--justdo-chat-text-secondary, #9ca3af);
      box-shadow: 0 0 0 3px var(--justdo-chat-tool-bg, #f3f4f6);
    }

    .tool-timeline__item--completed .tool-timeline__marker {
      background: var(--justdo-success, #22c55e);
    }

    .tool-timeline__item--error .tool-timeline__marker {
      background: var(--justdo-chat-error, #ef4444);
    }

    .tool-timeline__body {
      min-width: 0;
      padding: 7px 10px;
      border: 1px solid var(--justdo-chat-border, rgba(0, 0, 0, 0.06));
      border-radius: 7px;
      background: var(--justdo-chat-tool-bg, #f3f4f6);
    }

    .tool-timeline__title {
      display: flex;
      align-items: center;
      min-width: 0;
      font-size: 12px;
      cursor: pointer;
      list-style: none;
      font-weight: 600;
    }

    .tool-timeline__name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }

    .tool-timeline__body .tool-message__details {
      margin-top: 8px;
    }

    /* ── Reading Indicator ──────────────────────────────────────────── */

    .chat-reading-indicator {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 10px 0;
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
    :host(.dark) .chat-minimap__arrow {
      color: #a3a3a3;
    }
    :host(.dark) .chat-minimap__arrow:hover {
      background: rgba(64, 64, 64, 0.7);
      color: #e5e5e5;
    }
    :host(.dark) .chat-minimap__line {
      background: #525252;
    }
    :host(.dark) .chat-minimap__item--active .chat-minimap__line,
    :host(.dark) .chat-minimap__item:hover .chat-minimap__line {
      background: #e5e5e5;
    }
    :host(.dark) .chat-minimap__tooltip {
      background: #262626;
      border-color: #404040;
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.4);
      color: #d4d4d4;
    }
    :host(.dark) .chat-thinking__content {
      background: rgba(255, 255, 255, 0.03);
      border-color: rgba(255, 255, 255, 0.06);
    }
    :host(.dark) .tool-message {
      background: rgba(255, 255, 255, 0.03);
    }
    :host(.dark) .tool-timeline {
      background: transparent;
    }
    :host(.dark) .tool-timeline__body,
    :host(.dark) .tool-detail-box {
      background: var(--justdo-chat-assistant-bg, #1f2937);
      border-color: rgba(255, 255, 255, 0.06);
    }
    :host(.dark) .tool-timeline__list::before {
      background: rgba(255, 255, 255, 0.14);
    }
    :host(.dark) .tool-timeline__marker {
      box-shadow: 0 0 0 3px #1f2937;
    }

    .chat-search-mark {
      border-radius: 3px;
      background: rgba(250, 204, 21, 0.75);
      color: #422006;
      box-shadow: 0 0 0 2px rgba(234, 179, 8, 0.45);
    }
  `;

  // ─── Rendering ──────────────────────────────────────────────────────────

  render(): TemplateResult {
    // Use controller state if available, otherwise use direct properties
    const ctrl = this._controller;
    let messages = ctrl ? (ctrl.state.chatMessages as GatewayMessage[]) : this.messages;
    const thinkingMessages = ctrl ? ctrl.state.chatThinkingMessages : [];
    const toolMessages = ctrl ? ctrl.state.chatToolMessages : [];
    const streamSegments = ctrl ? ctrl.state.chatStreamSegments : [];
    const stream = ctrl ? ctrl.state.chatStream : this.stream;
    const thinkingStream = ctrl ? ctrl.state.chatThinkingStream : null;
    const isStreaming = ctrl ? ctrl.state.chatSending : this.isStreaming;

    // Append pending user message (optimistic display during session transitions)
    if (ctrl?.state.pendingUserMessage) {
      const pending = ctrl.state.pendingUserMessage as GatewayMessage;
      const alreadyInHistory = messages.some(
        m =>
          (m as Record<string, unknown>).role === 'user' &&
          (m as Record<string, unknown>).content === pending.content &&
          (m as Record<string, unknown>).timestamp === pending.timestamp,
      );
      if (!alreadyInHistory) {
        messages = [...messages, pending];
      }
    }

    const hasAssistantStream = Boolean(stream && stream.trim().length > 0);
    const thinkingMessagesForTimeline = hasAssistantStream
      ? thinkingMessages.slice(0, -1)
      : thinkingMessages;
    const committedThinkingForStream = hasAssistantStream
      ? this.extractThinkingText(thinkingMessages[thinkingMessages.length - 1])
      : null;
    const thinkingForStreamingGroup = thinkingStream ?? committedThinkingForStream;
    const timelineMessages =
      thinkingMessagesForTimeline.length > 0
        ? [...messages, ...(thinkingMessagesForTimeline as GatewayMessage[])]
        : messages;
    const items = this.buildItems(timelineMessages, toolMessages, streamSegments, stream);
    const hasLiveStreamItem = items.some(item => item.kind === 'stream' && item.isStreaming);
    const hasReadingIndicator = items.some(item => item.kind === 'reading-indicator');
    const shouldShowWaitingIndicator =
      isStreaming &&
      !hasReadingIndicator &&
      !hasAssistantStream &&
      !thinkingStream &&
      toolMessages.length === 0 &&
      streamSegments.length === 0;
    const minimapEntries = this.buildMinimapEntries(messages, stream);

    // Always render the chat container — never show "No messages"
    return html`
      <div class="chat-shell">
        ${this.renderMinimap(minimapEntries)}
        <div class="chat-container">
          ${items.map(item => this.renderItem(item, thinkingForStreamingGroup))}
          ${thinkingStream && !hasLiveStreamItem
            ? renderStreamingThinkingGroup(thinkingStream)
            : nothing}
          ${shouldShowWaitingIndicator ? renderReadingIndicatorGroup() : nothing}
        </div>
      </div>
    `;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.addEventListener('scroll', this.handleScroll);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.removeEventListener('scroll', this.handleScroll);
    if (this.minimapNavigatingTimer) {
      clearTimeout(this.minimapNavigatingTimer);
      this.minimapNavigatingTimer = null;
    }
    this.unsubscribeController();
  }

  protected firstUpdated(): void {
    this.updateCurrentMinimapIndex();
  }

  protected updated(changedProperties?: Map<string | number | symbol, unknown>): void {
    requestAnimationFrame(() => this.updateCurrentMinimapIndex());
    if (
      changedProperties?.has('searchQuery') ||
      changedProperties?.has('searchCaseSensitive')
    ) {
      this.activeSearchIndex = -1;
      this.clearSearchMarks();
    }
    requestAnimationFrame(() => this.emitSearchMatchCount());
  }

  private subscribeController(ctrl: ChatController): void {
    this._controllerUnsubscribe = ctrl.subscribe(() => this.requestUpdate());
    this._streamUnsubscribe = ctrl.onStream(() => this.requestUpdate());
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
        return matcher.test(node.nodeValue)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
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

  private highlightSearchMatch(match: { node: Text; start: number; end: number } | undefined): void {
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
    const msgs = messages ?? this.messages;
    if (!msgs || msgs.length === 0) return [];

    try {
      const result = buildChatItems({
        sessionKey: '',
        messages: msgs,
        toolMessages: toolMessages ?? [],
        stream: stream ?? this.stream,
        streamStartedAt: this._controller?.state.chatStreamStartedAt ?? this.streamStartedAt,
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

  private renderItem(
    item: ChatItem | MessageGroup,
    thinkingStream: string | null = null,
  ): TemplateResult | typeof nothing {
    if (!item) return nothing;

    if ('kind' in item) {
      if (item.kind === 'group') {
        return renderMessageGroup(item as MessageGroup, { searchQuery: this.searchQuery });
      }
      if (item.kind === 'stream') {
        const streamItem = item as {
          kind: 'stream';
          text: string;
          startedAt: number;
          isStreaming: boolean;
          toolMessages?: unknown[];
        };
        return renderStreamingGroup(
          streamItem.text,
          streamItem.startedAt,
          streamItem.toolMessages ?? [],
          streamItem.isStreaming ? thinkingStream : null,
        );
      }
      if (item.kind === 'reading-indicator') {
        return renderReadingIndicatorGroup();
      }
    }

    return nothing;
  }

  private renderMinimap(entries: ChatMinimapEntry[]): TemplateResult | typeof nothing {
    if (entries.length < MINIMAP_VISIBLE_ENTRY_THRESHOLD) {
      return nothing;
    }

    const currentIndex = this.resolveCurrentMinimapIndex(entries.length);
    const hoveredEntry =
      this.hoveredMinimapIndex == null ? null : (entries[this.hoveredMinimapIndex] ?? null);
    const maxContentLen = entries.reduce((max, entry) => Math.max(max, entry.contentLen), 1);
    const canNavigateUp = currentIndex > 0;
    const canNavigateDown = currentIndex < entries.length - 1;

    return html`
      <nav
        class=${`chat-minimap ${this.isMinimapHovered ? 'chat-minimap--hovered' : ''}`}
        @mouseenter=${() => {
          this.isMinimapHovered = true;
        }}
        @mouseleave=${() => {
          this.isMinimapHovered = false;
          this.hoveredMinimapIndex = null;
        }}
      >
        <button
          type="button"
          class="chat-minimap__arrow chat-minimap__arrow--up"
          ?disabled=${!canNavigateUp}
          @click=${() => this.navigateMinimapByStep(entries, -1)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
          </svg>
        </button>
        <div class="chat-minimap__lines">
          ${entries.map((entry, index) => {
            const isActive = index === currentIndex;
            const ratio = entry.contentLen / maxContentLen;
            const lineWidth = Math.round(6 + ratio * 10);
            return html`
              <button
                type="button"
                class=${`chat-minimap__item ${isActive ? 'chat-minimap__item--active' : ''}`}
                @click=${() => this.scrollToMinimapEntry(entry, entries.length, index)}
                @mouseenter=${(event: MouseEvent) => this.showMinimapTooltip(index, event)}
              >
                <span class="chat-minimap__line" style=${`width: ${lineWidth}px;`}></span>
              </button>
            `;
          })}
        </div>
        <button
          type="button"
          class="chat-minimap__arrow chat-minimap__arrow--down"
          ?disabled=${!canNavigateDown}
          @click=${() => this.navigateMinimapByStep(entries, 1)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        </button>
        ${hoveredEntry
          ? html`
              <div
                class=${`chat-minimap__tooltip ${
                  hoveredEntry.role === 'user' ? 'chat-minimap__tooltip--user' : ''
                }`}
                style=${`top: ${this.minimapTooltipTop}px;`}
              >
                <div class="chat-minimap__tooltip-text">${hoveredEntry.label}</div>
              </div>
            `
          : nothing}
      </nav>
    `;
  }

  private buildMinimapEntries(
    messages: GatewayMessage[],
    stream: string | null,
  ): ChatMinimapEntry[] {
    const entries: ChatMinimapEntry[] = [];

    messages.forEach((message, index) => {
      const role = this.normalizeMinimapRole(message);
      if (!role) {
        return;
      }

      const label = this.cleanMinimapText(extractTextCached(message));
      if (!label) {
        return;
      }

      entries.push({ index, role, label, contentLen: label.length });
    });

    const streamingLabel = this.cleanMinimapText(stream);
    if (streamingLabel) {
      entries.push({
        index: messages.length,
        role: 'assistant',
        label: streamingLabel,
        contentLen: streamingLabel.length,
      });
    }

    return entries;
  }

  private normalizeMinimapRole(message: GatewayMessage): ChatMinimapEntry['role'] | null {
    const role = typeof message.role === 'string' ? message.role.toLowerCase() : '';
    return role === 'user' || role === 'assistant' ? role : null;
  }

  private cleanMinimapText(text: string | null | undefined): string {
    return (text ?? '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[#>*_\-~]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240);
  }

  private scrollToMinimapEntry(
    entry: ChatMinimapEntry,
    entryCount: number,
    visualIndex = entry.index,
  ): void {
    const maxScrollTop = Math.max(0, this.scrollHeight - this.clientHeight);
    if (maxScrollTop === 0) {
      return;
    }

    const denominator = Math.max(1, entryCount - 1);
    const nextScrollTop = (visualIndex / denominator) * maxScrollTop;
    this.lockMinimapNavigation();
    this.currentMinimapIndex = visualIndex;
    this.scrollTo({ top: nextScrollTop, behavior: 'smooth' });
  }

  private handleScroll = (): void => {
    this.updateCurrentMinimapIndex();
  };

  private updateCurrentMinimapIndex(): void {
    if (this.isMinimapNavigating) {
      return;
    }

    const entries = this.buildMinimapEntries(
      this._controller ? (this._controller.state.chatMessages as GatewayMessage[]) : this.messages,
      this._controller ? this._controller.state.chatStream : this.stream,
    );
    if (entries.length === 0) {
      if (this.currentMinimapIndex !== -1) {
        this.currentMinimapIndex = -1;
      }
      return;
    }

    const distanceToBottom = this.scrollHeight - this.scrollTop - this.clientHeight;
    const nextIndex =
      distanceToBottom <= 20
        ? entries.length - 1
        : Math.round(
            (this.scrollTop / Math.max(1, this.scrollHeight - this.clientHeight)) *
              (entries.length - 1),
          );
    const clampedIndex = Math.max(0, Math.min(entries.length - 1, nextIndex));
    if (this.currentMinimapIndex !== clampedIndex) {
      this.currentMinimapIndex = clampedIndex;
    }
  }

  private resolveCurrentMinimapIndex(entryCount: number): number {
    if (entryCount <= 0) {
      return -1;
    }
    if (this.currentMinimapIndex < 0 || this.currentMinimapIndex >= entryCount) {
      return entryCount - 1;
    }
    return this.currentMinimapIndex;
  }

  private navigateMinimapByStep(entries: ChatMinimapEntry[], direction: -1 | 1): void {
    const currentIndex = this.resolveCurrentMinimapIndex(entries.length);
    const nextIndex = Math.max(0, Math.min(entries.length - 1, currentIndex + direction));
    const entry = entries[nextIndex];
    if (!entry || nextIndex === currentIndex) {
      return;
    }
    this.scrollToMinimapEntry(entry, entries.length, nextIndex);
  }

  private lockMinimapNavigation(): void {
    this.isMinimapNavigating = true;
    if (this.minimapNavigatingTimer) {
      clearTimeout(this.minimapNavigatingTimer);
    }
    this.minimapNavigatingTimer = setTimeout(() => {
      this.isMinimapNavigating = false;
    }, MINIMAP_NAV_LOCK_DURATION);
  }

  private showMinimapTooltip(index: number, event: MouseEvent): void {
    this.hoveredMinimapIndex = index;
    const target = event.currentTarget as HTMLElement;
    const rail = target.closest('.chat-minimap');
    const targetRect = target.getBoundingClientRect();
    const railRect = rail?.getBoundingClientRect();
    this.minimapTooltipTop = railRect
      ? targetRect.top + targetRect.height / 2 - railRect.top
      : target.offsetTop + target.offsetHeight / 2;
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
