import katexStyles from 'katex/dist/katex.min.css?inline';
import { css, unsafeCSS } from 'lit';
import monacoEditorStyles from 'monaco-editor/min/vs/editor/editor.main.css?inline';

import browserRecordingStyles from '@/features/browser/browserRecording.css?inline';

export const chatStyles = [
  unsafeCSS(browserRecordingStyles),
  unsafeCSS(katexStyles),
  unsafeCSS(monacoEditorStyles),
  css`
    :host {
      display: block;
      font-family: var(
        --justdo-font-family,
        -apple-system,
        BlinkMacSystemFont,
        'Segoe UI',
        Roboto,
        'Helvetica Neue',
        Arial,
        sans-serif
      );
      font-size: var(--justdo-chat-font-size, 14px);
      line-height: 1.6;
      color: var(--justdo-chat-text, #1a1a1a);
      background: var(--justdo-chat-bg, transparent);
      overflow-y: auto;
      height: 100%;
      scrollbar-width: thin;
      scrollbar-color: var(--justdo-scroll-thumb, rgba(148, 163, 184, 0.55)) transparent;
      scrollbar-gutter: stable;
    }

    :host::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }

    :host::-webkit-scrollbar-track {
      background: transparent;
    }

    :host::-webkit-scrollbar-thumb {
      background-color: var(--justdo-scroll-thumb, rgba(148, 163, 184, 0.55));
      border-radius: 3px;
    }

    :host::-webkit-scrollbar-thumb:hover {
      background-color: var(--justdo-scroll-thumb-hover, rgba(100, 116, 139, 0.75));
    }

    .chat-shell {
      position: relative;
      min-height: 100%;
    }

    .chat-container {
      width: var(--justdo-chat-content-width, 70%);
      /* Match the composer: adapt to the viewport without a fixed pixel cap. */
      max-width: calc(100% - 32px);
      min-width: min(320px, calc(100% - 32px));
      box-sizing: border-box;
      margin: 0 auto;
      padding: 16px 0;
    }

    .phase-boundary {
      display: flex;
      align-items: center;
      gap: 12px;
      margin: 28px 0;
      color: var(--justdo-chat-muted, #737373);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.02em;
    }

    .phase-boundary::before,
    .phase-boundary::after {
      height: 1px;
      flex: 1;
      content: '';
      background: var(--justdo-chat-border, rgba(148, 163, 184, 0.35));
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

    .chat-group--assistant.chat-group--content {
      padding-block: 0;
    }

    .chat-group--assistant:not(.chat-group--continuation) {
      position: relative;
    }

    .chat-group--assistant:not(.chat-group--continuation) > .chat-group__avatar {
      position: var(--justdo-assistant-leading-avatar-position, static);
      top: 0;
      left: 0;
    }

    .chat-group--assistant:not(.chat-group--continuation) > .chat-group__content {
      margin-left: var(--justdo-assistant-leading-content-margin-left, 0px);
    }

    .chat-group--assistant.chat-group--content:not(.chat-group--continuation)
      > .chat-group__content {
      padding-top: var(--justdo-assistant-avatar-first-line-offset, 0px);
    }

    .chat-group--content + .chat-group--content,
    .chat-container > .chat-history-row + .chat-history-row {
      margin-top: max(var(--justdo-message-gap, 8px), var(--justdo-assistant-row-gap, 0px));
    }

    .chat-container > .chat-group--timeline + .chat-group--timeline {
      margin-top: max(var(--justdo-timeline-gap, 4px), var(--justdo-assistant-row-gap, 0px));
    }

    .chat-container > .chat-group--timeline + .chat-group--content,
    .chat-container > .chat-group--content + .chat-group--timeline,
    .chat-container > .chat-history-row + .chat-group--timeline,
    .chat-container > .chat-group--timeline + .chat-history-row {
      margin-top: var(--justdo-assistant-row-gap, 0px);
    }

    .chat-group--content .chat-bubble + .chat-bubble {
      margin-top: var(--justdo-message-gap, 8px);
    }

    .chat-group--assistant .chat-bubble + .chat-bubble {
      margin-top: max(var(--justdo-message-gap, 8px), var(--justdo-assistant-row-gap, 0px));
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

    .chat-avatar.error {
      background: var(--justdo-chat-error-avatar-bg, #fee2e2);
      color: var(--justdo-chat-error-avatar-text, #b91c1c);
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
      line-height: 1.45;
    }

    .chat-group--user .chat-group__footer {
      justify-content: flex-end;
    }

    .user-message-actions {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      margin-right: 2px;
      position: relative;
      z-index: 2;
      opacity: 0.55;
      pointer-events: auto;
      transition: opacity 120ms ease;
    }

    .chat-group--user:hover .user-message-actions,
    .user-message-actions:focus-within {
      opacity: 1;
    }

    .user-message-action {
      display: inline-grid;
      width: 30px;
      height: 30px;
      place-items: center;
      border: 0;
      border-radius: 5px;
      padding: 0;
      background: transparent;
      color: var(--justdo-chat-text-secondary, #6b7280);
      cursor: pointer;
      -webkit-app-region: no-drag;
    }

    .user-message-action:hover,
    .user-message-action:focus-visible {
      outline: none;
      background: color-mix(in srgb, currentColor 10%, transparent);
      color: var(--justdo-chat-text, #1a1a1a);
    }

    .user-message-action--withdraw:hover,
    .user-message-action--withdraw:focus-visible {
      color: #dc2626;
    }

    .user-message-action svg {
      width: 15px;
      height: 15px;
    }

    .assistant-message-action {
      display: inline-grid;
      width: 24px;
      height: 24px;
      flex: 0 0 auto;
      place-items: center;
      border: 0;
      border-radius: 5px;
      padding: 0;
      background: transparent;
      color: inherit;
      cursor: pointer;
      opacity: 0.7;
      -webkit-app-region: no-drag;
    }

    .assistant-message-action:hover,
    .assistant-message-action:focus-visible {
      outline: none;
      background: color-mix(in srgb, currentColor 10%, transparent);
      color: var(--justdo-chat-text, #1a1a1a);
      opacity: 1;
    }

    .assistant-message-action svg {
      width: 14px;
      height: 14px;
    }

    .user-message-editor {
      width: min(620px, 72vw);
      max-width: 100%;
      margin-left: auto;
      box-sizing: border-box;
      border-radius: 16px;
      background: var(--justdo-chat-user-bg, #f3f4f6);
      padding: 12px;
    }

    .user-message-editor__input {
      display: block;
      width: 100%;
      min-height: 96px;
      max-height: 320px;
      resize: vertical;
      border: 0;
      outline: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      line-height: 1.55;
    }

    .user-message-editor__actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 10px;
    }

    .user-message-editor__actions button {
      border: 1px solid var(--justdo-chat-border, #d1d5db);
      border-radius: 999px;
      background: var(--justdo-chat-bg, #fff);
      color: var(--justdo-chat-text, #1a1a1a);
      padding: 6px 14px;
      cursor: pointer;
    }

    .user-message-editor__actions button:disabled {
      cursor: default;
      opacity: 0.55;
    }

    .user-message-editor__actions .user-message-editor__submit {
      border-color: transparent;
      background: var(--justdo-chat-accent, #2563eb);
      color: white;
    }

    @media (hover: none) {
      .user-message-actions {
        opacity: 1;
        pointer-events: auto;
      }
    }

    .chat-group--assistant .chat-group__footer,
    .active-turn__footer {
      padding-left: var(--justdo-assistant-footer-padding-left, 0px);
    }

    .chat-group--assistant .chat-group__footer {
      margin-top: var(--justdo-assistant-footer-margin-top, 2px);
    }

    .chat-group__sender {
      font-weight: 400;
    }

    .chat-group__footer-separator,
    .active-turn__footer-separator {
      opacity: 0.6;
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

    .message-speech {
      position: absolute;
      right: 6px;
      bottom: 6px;
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

    .chat-bubble:hover .message-speech,
    .message-speech:focus-visible,
    .message-speech--loading,
    .message-speech--playing {
      opacity: 1;
      pointer-events: auto;
    }

    .message-speech:hover,
    .message-speech--playing {
      color: var(--justdo-chat-text, #1a1a1a);
      background: color-mix(
        in srgb,
        var(--justdo-chat-assistant-bg, #ffffff) 74%,
        rgba(0, 0, 0, 0.14)
      );
    }

    .message-speech__icon {
      width: 16px;
      height: 16px;
    }

    .message-speech__loading {
      width: 13px;
      height: 13px;
      border: 1.5px solid currentColor;
      border-right-color: transparent;
      border-radius: 50%;
      animation: message-speech-spin 700ms linear infinite;
    }

    .message-speech__wave {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 2px;
      width: 16px;
      height: 16px;
    }

    .message-speech__wave > span {
      width: 2px;
      height: 10px;
      border-radius: 999px;
      background: currentColor;
      transform-origin: center;
      animation: message-speech-wave 720ms ease-in-out infinite;
    }

    .message-speech__wave > span:nth-child(2),
    .message-speech__wave > span:nth-child(4) {
      animation-delay: -360ms;
    }

    .message-speech__wave > span:nth-child(3) {
      animation-delay: -180ms;
    }

    @keyframes message-speech-spin {
      to {
        transform: rotate(360deg);
      }
    }

    @keyframes message-speech-wave {
      0%,
      100% {
        transform: scaleY(0.35);
      }
      50% {
        transform: scaleY(1);
      }
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

    .chat-bubble__content {
      display: flex;
      min-width: 0;
      flex-direction: column;
      gap: 8px;
    }

    .chat-bubble__images {
      display: grid;
      grid-template-columns: repeat(var(--image-columns, 1), minmax(0, 200px));
      justify-content: center;
      justify-items: center;
      max-width: 100%;
      gap: 8px;
      align-items: flex-start;
      margin: 0;
    }

    .chat-bubble__images > .chat-bubble__image,
    .chat-bubble__images > .message-attachment-list-item {
      min-width: 0;
      max-width: 100%;
    }

    .chat-bubble__images:last-child {
      margin-bottom: 0;
    }

    .chat-bubble__images--assistant {
      margin: 0;
    }

    .chat-bubble__image {
      display: block;
      max-width: min(200px, 100%);
      max-height: 200px;
      border-radius: 8px;
      cursor: zoom-in;
      object-fit: contain;
    }

    .chat-bubble--assistant {
      padding: var(--justdo-assistant-bubble-padding, 10px 14px);
      background: color-mix(
        in srgb,
        var(--justdo-chat-assistant-bg, #ffffff)
          var(--justdo-assistant-bubble-background-strength, 100%),
        transparent
      );
      color: var(--justdo-chat-assistant-text, inherit);
      border-radius: var(--justdo-assistant-bubble-radius, 12px 12px 12px 4px);
      min-width: var(--justdo-assistant-bubble-min-width, 0);
      max-width: 100%;
      width: var(--justdo-assistant-bubble-width, fit-content);
    }

    .chat-bubble--assistant:has(> .message-copy) {
      padding-right: var(--justdo-assistant-bubble-copy-padding-right, 14px);
    }

    .chat-bubble--streaming {
      border-left: var(--justdo-assistant-stream-border-width, 3px) solid
        var(--justdo-chat-accent, #6366f1);
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
      --code-block-bg: var(--justdo-chat-code-light-bg, #f6f8fa);
      --code-block-border: #d0d7de;
      --code-block-text: var(--justdo-chat-code-text, #1f2328);
      --code-block-muted: #656d76;
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

    .markdown-content .markdown-table-scroll {
      max-width: 100%;
      margin: 4px 0;
      overflow-x: auto;
      overflow-y: hidden;
      overscroll-behavior-inline: contain;
    }

    .markdown-content table {
      border-collapse: collapse;
      width: max-content;
      min-width: 100%;
      max-width: none;
    }

    .markdown-content th,
    .markdown-content td {
      border: 1px solid var(--justdo-chat-border, #e5e7eb);
      padding: 6px 10px;
      text-align: left;
      overflow-wrap: normal;
      word-break: normal;
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
      max-width: min(200px, 100%);
      max-height: 200px;
      object-fit: contain;
      border-radius: 8px;
      margin: 2px 0;
      cursor: zoom-in;
    }

    .markdown-content .markdown-plain-text-fallback {
      white-space: pre-wrap;
      font: inherit;
    }

    .markdown-box-drawing-diagram {
      display: block;
      max-width: 100%;
      overflow-x: auto;
      overflow-y: hidden;
      white-space: pre;
      overflow-wrap: normal;
      word-break: normal;
      font-family:
        -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, 'Segoe UI', Roboto,
        sans-serif;
      font-size: 15px;
      line-height: 24px;
    }

    pre.markdown-box-drawing-code,
    pre.markdown-box-drawing-code > code {
      font-family:
        -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, 'Segoe UI', Roboto,
        sans-serif;
      font-size: 15px;
      line-height: 24px;
    }

    /* ── Code Blocks ────────────────────────────────────────────────── */

    .markdown-content pre {
      width: 100%;
      min-width: 0;
      background: var(--code-block-bg);
      color: var(--code-block-text);
      padding: 16px;
      border-radius: 6px;
      max-width: 100%;
      box-sizing: border-box;
      overflow-x: auto;
      overflow-y: hidden;
      white-space: var(--justdo-code-white-space, pre);
      overflow-wrap: var(--justdo-code-overflow-wrap, normal);
      word-break: normal;
      font-size: 14px;
      line-height: 1.5;
      margin: 8px 0;
      tab-size: 4;
    }

    .markdown-content code {
      font-family: 'SFMono-Regular', 'Cascadia Code', 'Fira Code', Consolas, monospace;
      font-size: 0.9em;
    }

    .markdown-content :not(pre) > code {
      padding: 0.2em 0.4em;
      color: var(--code-block-text);
      background: var(--justdo-chat-inline-code-bg, rgba(175, 184, 193, 0.2));
      border: 0;
      border-radius: 6px;
    }

    .code-block-wrapper {
      position: relative;
      width: 100%;
      min-width: 0;
      max-width: 100%;
      margin: 8px 0;
      overflow: visible;
      background: var(--code-block-bg);
      border: 0;
      border-radius: 6px;
      box-shadow: none;
      box-sizing: border-box;
    }

    .code-block-header {
      position: absolute;
      z-index: 4;
      top: 7px;
      right: 7px;
      display: flex;
      align-items: center;
      padding: 0;
      background: transparent;
      border: 0;
    }

    .code-block-wrapper:not(.mermaid-block):has(.code-block-lang) .code-block-header {
      inset: 0 0 auto;
      justify-content: space-between;
      min-height: 36px;
      padding: 0 8px 0 16px;
      border-bottom: 1px solid var(--code-block-border);
    }

    .code-block-wrapper:not(.mermaid-block):has(.code-block-lang) pre {
      padding-top: 52px;
    }

    .code-block-wrapper pre {
      width: 100%;
      margin-top: 0;
      margin-bottom: 0;
      border: 0;
      border-radius: 6px;
    }

    .code-block-wrapper pre > code {
      display: block;
      width: var(--justdo-code-width, max-content);
      min-width: 100%;
      box-sizing: border-box;
      font-size: inherit;
    }

    .markdown-content pre.markdown-box-drawing-code,
    .markdown-content pre.markdown-box-drawing-code > code {
      width: max-content;
      white-space: pre;
      overflow-wrap: normal;
    }

    .code-block-lang {
      overflow: hidden;
      color: var(--code-block-muted);
      font-family: 'SFMono-Regular', 'Cascadia Code', 'Fira Code', Consolas, monospace;
      font-size: 12px;
      font-weight: 400;
      letter-spacing: 0;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .code-block-copy {
      position: relative;
      z-index: 4;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      background: var(--code-block-bg);
      border: 1px solid var(--code-block-border);
      color: var(--code-block-muted);
      cursor: pointer;
      flex: 0 0 auto;
      margin-left: auto;
      padding: 0;
      border-radius: 6px;
      font-size: 0;
      opacity: 0;
      transition:
        color 140ms ease,
        background 140ms ease,
        border-color 140ms ease,
        opacity 140ms ease;
    }

    .code-block-copy::before {
      width: 16px;
      height: 16px;
      content: '';
      background: currentColor;
      mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M0 6.75C0 5.784.784 5 1.75 5h6.5C9.216 5 10 5.784 10 6.75v7.5A1.75 1.75 0 0 1 8.25 16h-6.5A1.75 1.75 0 0 1 0 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h6.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z'/%3E%3Cpath d='M6 1.75C6 .784 6.784 0 7.75 0h6.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11H12.5V9.5h1.75a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25h-6.5a.25.25 0 0 0-.25.25V3H6Z'/%3E%3C/svg%3E")
        center / contain no-repeat;
    }

    .code-block-wrapper:hover .code-block-copy,
    .code-block-copy:focus-visible,
    .code-block-copy.copied {
      opacity: 1;
    }

    .code-block-copy:hover {
      color: var(--code-block-text);
      background: #f3f4f6;
      border-color: #8c959f;
    }

    .code-block-copy:focus-visible {
      outline: 2px solid #0969da;
      outline-offset: 2px;
    }

    .code-block-copy.copied {
      color: #1a7f37;
    }

    .code-block-copy.copied::before {
      mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M13.78 4.22a.75.75 0 0 1 0 1.06l-6.25 6.25a.75.75 0 0 1-1.06 0l-3.25-3.25a.75.75 0 0 1 1.06-1.06L7 9.94l5.72-5.72a.75.75 0 0 1 1.06 0Z'/%3E%3C/svg%3E");
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

    .browser-annotation-message {
      width: min(420px, 100%);
      overflow: hidden;
      color: var(--text-primary);
      background: var(--surface-raised, #ffffff);
      border: 1px solid color-mix(in srgb, var(--text-primary) 9%, transparent);
      border-radius: 12px;
      box-shadow: 0 2px 8px color-mix(in srgb, #000000 5%, transparent);
      transition:
        border-color 160ms ease,
        box-shadow 160ms ease;
    }

    .browser-annotation-message:hover,
    .browser-annotation-message[open] {
      border-color: color-mix(in srgb, var(--text-primary) 15%, transparent);
      box-shadow: 0 3px 12px color-mix(in srgb, #000000 7%, transparent);
    }

    .browser-annotation-message__summary {
      display: flex;
      gap: 9px;
      align-items: center;
      min-width: 0;
      padding: 9px 10px;
      cursor: pointer;
      list-style: none;
      transition: background 140ms ease;
    }

    .browser-annotation-message__summary:hover {
      background: color-mix(in srgb, var(--text-primary) 2.5%, transparent);
    }

    .browser-annotation-message[open] .browser-annotation-message__summary {
      background: transparent;
      border-bottom: 1px solid color-mix(in srgb, var(--text-primary) 7%, transparent);
    }

    .browser-annotation-message__summary::-webkit-details-marker {
      display: none;
    }

    .browser-annotation-message__summary:focus-visible {
      outline: 2px solid var(--accent, #4f7cff);
      outline-offset: -3px;
      border-radius: 13px;
    }

    .browser-annotation-message__icon {
      display: grid;
      flex: 0 0 28px;
      width: 28px;
      height: 28px;
      color: #1683f8;
      background: color-mix(in srgb, #1683f8 10%, transparent);
      border-radius: 8px;
      place-items: center;
    }

    .browser-annotation-message__icon svg {
      width: 17px;
      height: 17px;
    }

    .browser-annotation-message__main {
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }

    .browser-annotation-message__source {
      display: flex;
      gap: 4px;
      align-items: center;
      overflow: hidden;
      color: var(--text-secondary);
      font-size: 10.5px;
      line-height: 15px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .browser-annotation-message__source-icon {
      display: inline-flex;
      flex: 0 0 auto;
      opacity: 0.72;
    }

    .browser-annotation-message__source-icon svg {
      width: 12px;
      height: 12px;
    }

    .browser-annotation-message__label {
      display: flex;
      align-items: center;
      overflow: hidden;
      font-size: 13px;
      line-height: 19px;
      white-space: nowrap;
    }

    .browser-annotation-message__title {
      overflow: hidden;
      color: var(--text-primary);
      font-weight: 550;
      letter-spacing: -0.01em;
      text-overflow: ellipsis;
    }

    .browser-annotation-message__chevron {
      display: grid;
      flex: 0 0 auto;
      width: 24px;
      height: 24px;
      color: var(--text-secondary);
      border-radius: 7px;
      place-items: center;
      transform: rotate(0deg);
      transition:
        color 120ms ease,
        background 120ms ease,
        transform 160ms ease;
    }

    .browser-annotation-message__summary:hover .browser-annotation-message__chevron {
      color: var(--text-primary);
      background: color-mix(in srgb, var(--text-primary) 7%, transparent);
    }

    .browser-annotation-message__chevron svg {
      width: 14px;
      height: 14px;
    }

    .browser-annotation-message[open] .browser-annotation-message__chevron {
      transform: rotate(180deg);
    }

    .browser-annotation-message__details {
      display: grid;
      gap: 8px;
      padding: 10px 12px 11px;
      margin: 0;
      overflow-wrap: anywhere;
      font-size: 11px;
      line-height: 17px;
      background: color-mix(in srgb, var(--text-primary) 1.5%, transparent);
    }

    .browser-annotation-message__property {
      display: grid;
      grid-template-columns: 66px minmax(0, 1fr);
      gap: 10px;
      min-width: 0;
    }

    .browser-annotation-message__property dt,
    .browser-annotation-message__property dd {
      min-width: 0;
      margin: 0;
    }

    .browser-annotation-message__property dt {
      color: var(--text-secondary);
      font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace;
      font-size: 10px;
      letter-spacing: 0.01em;
    }

    .browser-annotation-message__property dd {
      overflow: hidden;
      color: color-mix(in srgb, var(--text-primary) 92%, transparent);
      text-overflow: ellipsis;
    }

    .browser-annotation-message__property code {
      padding: 1px 4px;
      overflow-wrap: anywhere;
      color: inherit;
      font-family: 'SF Mono', 'Cascadia Code', Consolas, monospace;
      font-size: 10.5px;
      background: color-mix(in srgb, var(--text-primary) 5%, transparent);
      border-radius: 4px;
      white-space: normal;
    }

    .message-attachment-list-item {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      max-width: 100%;
    }

    .message-attachment-list-item__marker {
      display: inline-flex;
      flex: 0 0 auto;
      align-items: center;
      justify-content: flex-end;
      min-width: 1.25em;
      height: 32px;
    }

    .message-attachment-list-item__content {
      flex: 1 1 auto;
      min-width: 0;
      max-width: 100%;
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

    .message-attachment:hover:not(:disabled):not(.message-attachment--unavailable) {
      background: var(--surface-hover, rgba(127, 127, 127, 0.1));
      border-color: color-mix(in srgb, var(--accent, #4f7cff) 28%, transparent);
    }

    .message-attachment:disabled,
    .message-attachment--unavailable {
      cursor: default;
      opacity: 0.7;
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

    .message-attachment__name--with-warning {
      display: flex;
      align-items: center;
      gap: 2px;
    }

    .message-attachment__filename {
      overflow: hidden;
      min-width: 0;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .message-attachment__warning {
      display: inline-grid;
      flex: 0 0 9px;
      width: 9px;
      height: 9px;
      margin-right: 3px;
      color: var(--text-secondary);
      font-size: 7px;
      font-weight: 700;
      line-height: 1;
      border: 1px solid color-mix(in srgb, currentColor 55%, transparent);
      border-radius: 50%;
      cursor: help;
      opacity: 0.6;
      place-items: center;
    }

    .message-attachment__warning:hover {
      opacity: 1;
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
      position: relative;
      inset: auto;
      justify-content: space-between;
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
      --code-block-border: #30363d;
      --code-block-text: #e6edf3;
      --code-block-muted: #8b949e;
    }

    :host(.dark) .code-block-copy:hover,
    :host([data-theme='dark']) .code-block-copy:hover {
      background: #21262d;
      border-color: #8b949e;
    }
    :host(.dark) .hljs-comment,
    :host([data-theme='dark']) .hljs-comment {
      color: #7d8998;
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

    :host(.dark) .markdown-content :not(pre) > code,
    :host([data-theme='dark']) .markdown-content :not(pre) > code {
      background: rgba(110, 118, 129, 0.4);
    }

    :host(.dark) .hljs-comment,
    :host(.dark) .hljs-quote,
    :host([data-theme='dark']) .hljs-comment,
    :host([data-theme='dark']) .hljs-quote {
      color: #8b949e;
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
      background: var(--justdo-chat-thinking-bg, rgba(0, 0, 0, 0.05));
      border-radius: 8px;
      font-size: 13px;
      line-height: 1.5;
      color: var(--justdo-chat-text-secondary, #6b7280);
      margin-top: 2px;
      border: 1px solid var(--justdo-chat-border, rgba(0, 0, 0, 0.04));
      max-height: 18em;
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
      background: color-mix(
        in srgb,
        var(--justdo-chat-assistant-bg, #1f2937)
          var(--justdo-assistant-bubble-background-strength, 100%),
        transparent
      );
      border-color: rgba(255, 255, 255, 0.06);
    }
    :host(.dark) .chat-thinking__content {
      background: rgba(255, 255, 255, 0.06);
      border-color: rgba(255, 255, 255, 0.06);
    }

    .chat-search-mark {
      border-radius: 3px;
      background: rgba(250, 204, 21, 0.75);
      color: #422006;
      box-shadow: 0 0 0 2px rgba(234, 179, 8, 0.45);
    }

    .chat-history-row--revealed {
      border-radius: 14px;
      animation: history-reveal 1.8s ease-out;
    }

    @keyframes history-reveal {
      0%,
      35% {
        background: color-mix(in srgb, var(--justdo-chat-accent, #2563eb) 16%, transparent);
        box-shadow: 0 0 0 4px
          color-mix(in srgb, var(--justdo-chat-accent, #2563eb) 10%, transparent);
      }
      100% {
        background: transparent;
        box-shadow: none;
      }
    }

    .active-turn {
      position: relative;
      width: 100%;
      box-sizing: border-box;
      margin: var(--justdo-active-turn-footer-margin-top, 8px) 0 22px;
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
      line-height: 1.45;
    }
    .active-turn-timeline {
      display: grid;
      gap: max(var(--justdo-timeline-gap, 4px), var(--justdo-assistant-row-gap, 0px));
    }
    .chat-group--timeline {
      padding-block: 0;
    }
    .chat-group--progress-receipt {
      margin-bottom: 2px;
    }
    .chat-group--plan-presentation {
      margin: 3px 0 6px;
    }
    .plan-presentation-card {
      display: grid;
      width: min(100%, 460px);
      grid-template-columns: 32px minmax(0, 1fr) 16px;
      align-items: center;
      gap: 9px;
      border: 1px solid var(--justdo-chat-border, rgba(148, 163, 184, 0.32));
      border-radius: 12px;
      padding: 9px 11px;
      background: var(--justdo-chat-process-bg, rgba(248, 250, 252, 0.72));
      color: var(--justdo-chat-text, #1e293b);
      font: inherit;
      text-align: left;
      cursor: pointer;
      transition:
        border-color 120ms ease,
        background 120ms ease,
        box-shadow 120ms ease;
    }
    .plan-presentation-card:hover,
    .plan-presentation-card:focus-visible {
      border-color: var(--justdo-chat-accent, #2563eb);
      background: rgba(59, 130, 246, 0.07);
      box-shadow: 0 5px 18px rgba(15, 23, 42, 0.07);
      outline: none;
    }
    .plan-presentation-card:disabled {
      cursor: default;
      opacity: 0.65;
    }
    .plan-presentation-card__icon {
      display: grid;
      width: 32px;
      height: 32px;
      place-items: center;
      border-radius: 10px;
      background: rgba(59, 130, 246, 0.1);
      color: var(--justdo-chat-accent, #2563eb);
    }
    .plan-presentation-card__icon svg {
      width: 18px;
      height: 18px;
      stroke: currentColor;
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-width: 1.45;
    }
    .plan-presentation-card__copy {
      display: block;
      min-width: 0;
    }
    .plan-presentation-card__copy strong {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      font-weight: 650;
    }
    .plan-presentation-card__arrow {
      display: grid;
      width: 16px;
      height: 16px;
      place-items: center;
      color: var(--justdo-chat-muted, #64748b);
    }
    .plan-presentation-card__arrow svg {
      width: 14px;
      height: 14px;
      stroke: currentColor;
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-width: 1.8;
    }
    .chat-group--timeline .chat-group__content {
      padding-top: 0;
    }
    .process-summary {
      display: flex;
      width: fit-content;
      max-width: 100%;
      align-items: center;
      gap: 7px;
      border: 0;
      border-radius: 8px;
      padding: var(--justdo-process-summary-padding, 6px 9px);
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
      padding: 6px 8px;
      border-radius: 6px;
      background: var(--justdo-chat-code-bg, rgba(15, 23, 42, 0.05));
      color: var(--justdo-chat-muted, #64748b);
      line-height: 1.5;
      max-height: 18em;
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
    .process-summary__item--edit,
    .process-summary__tool--edit {
      width: 100%;
      box-sizing: border-box;
    }
    .process-summary__tool--edit .process-summary__tool-detail {
      width: calc(100% - 14px);
      box-sizing: border-box;
    }
    .edit-diff {
      --edit-diff-background: #272822;
      --edit-diff-background-deep: #1e1f1c;
      --edit-diff-background-muted: #34352f;
      --edit-diff-border: #414339;
      --edit-diff-foreground: #f8f8f2;
      --edit-diff-muted: #90908a;
      --edit-diff-added: #a6e22e;
      --edit-diff-added-background: #4b661680;
      --edit-diff-removed: #f92672;
      --edit-diff-removed-background: #90274a70;
      width: 100%;
      max-height: 420px;
      box-sizing: border-box;
      overflow: auto;
      border: 1px solid var(--edit-diff-border);
      border-radius: 6px;
      background: var(--edit-diff-background);
      color: var(--edit-diff-foreground);
      font:
        14px/20px Consolas,
        'Courier New',
        monospace;
      font-weight: 400;
      font-variant-ligatures: none;
      scrollbar-color: #75715e var(--edit-diff-background-deep);
    }
    .edit-diff__header {
      position: sticky;
      z-index: 1;
      top: 0;
      left: 0;
      display: flex;
      width: 100%;
      box-sizing: border-box;
      align-items: center;
      gap: 10px;
      border-bottom: 1px solid var(--edit-diff-border);
      padding: 7px 9px;
      background: var(--edit-diff-background-deep);
    }
    .edit-diff__path {
      flex: 1 1 240px;
      min-width: 80px;
      overflow: hidden;
      color: #ccccc7;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .edit-diff__path:empty {
      display: none;
    }
    .edit-diff__stats {
      display: inline-flex;
      flex: 0 0 auto;
      gap: 8px;
      font-weight: 600;
    }
    .edit-diff__stat--added {
      color: var(--edit-diff-added);
    }
    .edit-diff__stat--removed {
      color: var(--edit-diff-removed);
    }
    .edit-diff__mode-switch {
      display: inline-flex;
      flex: 0 0 auto;
      overflow: hidden;
      border: 1px solid var(--edit-diff-border);
      border-radius: 3px;
      background: var(--edit-diff-background);
    }
    .edit-diff__mode-button {
      border: 0;
      padding: 2px 9px;
      background: transparent;
      color: #ccccc7;
      font: inherit;
      line-height: 1.55;
      cursor: pointer;
    }
    .edit-diff__mode-button + .edit-diff__mode-button {
      border-left: 1px solid var(--edit-diff-border);
    }
    .edit-diff__mode-button:hover {
      background: #3e3d32;
      color: var(--edit-diff-foreground);
    }
    .edit-diff__mode-button:focus-visible {
      outline: 2px solid #99947c;
      outline-offset: -2px;
    }
    .edit-diff__mode-button.is-active {
      background: #75715e;
      color: var(--edit-diff-foreground);
    }
    .edit-diff__hunk-header {
      min-width: 100%;
      width: max-content;
      box-sizing: border-box;
      padding: 3px 9px;
      border-bottom: 1px solid var(--edit-diff-border);
      background: var(--edit-diff-background-muted);
      color: #75715e;
    }
    .edit-diff__edits-omitted {
      min-width: 100%;
      width: max-content;
      box-sizing: border-box;
      padding: 5px 9px;
      background: var(--edit-diff-background-muted);
      color: var(--edit-diff-muted);
      font-style: italic;
    }
    .edit-diff__line {
      display: grid;
      grid-template-columns: 28px auto;
      min-width: 100%;
      width: max-content;
      box-sizing: border-box;
    }
    .edit-diff__line--removed {
      background: var(--edit-diff-removed-background);
    }
    .edit-diff__line--added {
      background: var(--edit-diff-added-background);
    }
    .edit-diff__line--omitted {
      background: var(--edit-diff-background-muted);
      color: var(--edit-diff-muted);
      font-style: italic;
    }
    .edit-diff__marker {
      padding: 0 7px;
      border-right: 1px solid #41433980;
      background: #1e1f1c66;
      color: var(--edit-diff-muted);
      text-align: center;
      user-select: none;
    }
    .edit-diff__line--removed .edit-diff__marker {
      color: var(--edit-diff-removed);
    }
    .edit-diff__line--added .edit-diff__marker {
      color: var(--edit-diff-added);
    }
    .edit-diff__line code,
    .edit-diff__split-cell code {
      padding-right: 10px;
      color: inherit;
      font: inherit;
      white-space: pre;
    }
    .edit-diff__monaco-host {
      position: relative;
      min-width: 100%;
      overflow: hidden;
      background: var(--edit-diff-background);
    }
    .edit-diff__monaco-host--split {
      min-width: 720px;
    }
    .edit-diff__monaco-fallback {
      height: 100%;
      overflow: hidden;
    }
    .edit-diff__monaco-host.is-ready .edit-diff__monaco-fallback {
      visibility: hidden;
    }
    .edit-diff__monaco-editor {
      position: absolute;
      inset: 0;
    }
    .edit-diff--monaco-ready .edit-diff__split-header {
      display: none;
    }
    .edit-diff__split-rows {
      min-width: 720px;
    }
    .edit-diff__split-header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      min-width: 720px;
      border-bottom: 1px solid var(--edit-diff-border);
      background: var(--edit-diff-background-muted);
      color: #ccccc7;
    }
    .edit-diff__split-header span {
      padding: 3px 9px;
    }
    .edit-diff__split-header span + span {
      border-left: 1px solid var(--edit-diff-border);
    }
    .edit-diff__split-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    }
    .edit-diff__split-cell {
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr);
      min-width: 0;
      box-sizing: border-box;
    }
    .edit-diff__split-cell code {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .edit-diff__split-cell--after {
      border-left: 1px solid var(--edit-diff-border);
    }
    .edit-diff__split-cell.is-empty {
      min-height: 1.6em;
      background: var(--edit-diff-background-deep);
    }
    .process-live {
      width: min(100%, 680px);
      border-radius: 8px;
      padding: 8px 10px;
      background: var(--justdo-chat-process-bg, rgba(248, 250, 252, 0.58));
      font-size: 12px;
    }
    .process-live--edit {
      width: 100%;
      max-width: none;
      box-sizing: border-box;
    }
    .process-live__tool > summary {
      list-style-position: outside;
    }
    .progress-card-receipt {
      display: flex;
      width: fit-content;
      max-width: 100%;
      min-width: 0;
      align-items: center;
      gap: 7px;
      padding: 4px 7px;
      color: var(--justdo-chat-muted, #64748b);
      font-size: 12px;
      line-height: 1.4;
    }
    .progress-card-receipt__icon {
      display: inline-flex;
      width: 16px;
      height: 16px;
      flex: 0 0 16px;
      align-items: center;
      justify-content: center;
      color: color-mix(in srgb, var(--justdo-chat-muted, #64748b) 86%, transparent);
    }
    .progress-card-receipt__icon svg {
      width: 14px;
      height: 14px;
      stroke: currentColor;
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-width: 1.35;
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
      color: #b91c1c;
      font-size: 13px;
    }
    .process-terminal--error {
      width: var(--justdo-assistant-bubble-width, fit-content);
      max-width: 100%;
      box-sizing: border-box;
      padding: var(--justdo-assistant-bubble-padding, 10px 14px);
      border-radius: var(--justdo-assistant-bubble-radius, 12px 12px 12px 4px);
      background: color-mix(
        in srgb,
        var(--justdo-terminal-error-background, rgba(254, 242, 242, 0.86))
          var(--justdo-assistant-bubble-background-strength, 100%),
        transparent
      );
    }
    .process-terminal--error > span {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .process-terminal--aborted {
      width: fit-content;
      max-width: 100%;
      align-items: center;
      box-sizing: border-box;
      gap: 6px;
      border-radius: 6px;
      padding: 4px 8px;
      background: rgba(254, 242, 242, 0.56);
      color: #b45b5b;
      font-size: 12px;
      line-height: 1.4;
    }
    .process-terminal--aborted > [aria-hidden='true'] {
      font-size: 11px;
      opacity: 0.78;
    }
    .process-terminal__footer {
      min-height: 0;
      margin-top: 2px;
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

    .waiting-status {
      margin-top: 2px;
    }

    .waiting-status__message {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-height: 24px;
      color: var(--justdo-chat-muted, #737373);
      font-size: 12px;
      line-height: 1.5;
    }

    .waiting-status--warning .waiting-status__message {
      color: var(--justdo-chat-warning, #946200);
    }

    .waiting-status__indicator {
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: currentColor;
      opacity: 0.72;
      animation: waiting-status-pulse 1.5s ease-in-out infinite;
    }

    @keyframes waiting-status-pulse {
      0%,
      100% {
        opacity: 0.35;
        transform: scale(0.85);
      }
      50% {
        opacity: 0.9;
        transform: scale(1);
      }
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
      color: #fca5a5;
    }
    :host(.dark) .process-terminal--error {
      --justdo-terminal-error-background: rgba(127, 29, 29, 0.2);
    }
    :host(.dark) .process-terminal--aborted {
      background: rgba(127, 29, 29, 0.12);
      color: #e8a3a3;
    }
    :host(.dark) .waiting-status--warning .waiting-status__message {
      color: var(--justdo-chat-warning, #f6c453);
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

      .edit-diff__header {
        flex-wrap: wrap;
      }

      .edit-diff__path {
        flex-basis: 100%;
      }
    }
  `,
];
