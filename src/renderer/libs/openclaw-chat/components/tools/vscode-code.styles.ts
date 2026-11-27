import { css, unsafeCSS } from 'lit';

import monokaiCodeStyles from '@/shared/editor/vscode-code.css?inline';
import {
  VS_CODE_MONOKAI_COLORS,
  VS_CODE_MONOKAI_CSS_VARIABLES,
  VS_CODE_MONOKAI_FONT_FAMILY,
  VS_CODE_MONOKAI_FONT_SIZE,
  VS_CODE_MONOKAI_LINE_HEIGHT,
} from '@/shared/editor/vscode-code-theme';

const palette = VS_CODE_MONOKAI_COLORS;
const monokaiVariables = Object.entries(VS_CODE_MONOKAI_CSS_VARIABLES)
  .map(([name, value]) => `${name}: ${value};`)
  .join('\n');

export const vscodeCodeStyles = css`
  ${unsafeCSS(monokaiCodeStyles)}

  .edit-diff {
    --edit-diff-background: ${unsafeCSS(palette.background)};
    --edit-diff-background-deep: ${unsafeCSS(palette.backgroundDeep)};
    --edit-diff-background-muted: ${unsafeCSS(palette.backgroundMuted)};
    --edit-diff-border: ${unsafeCSS(palette.border)};
    --edit-diff-foreground: ${unsafeCSS(palette.foreground)};
    --edit-diff-muted: ${unsafeCSS(palette.lineNumber)};
    --edit-diff-added: ${unsafeCSS(palette.function)};
    --edit-diff-added-background: ${unsafeCSS(palette.addedBackground)};
    --edit-diff-removed: ${unsafeCSS(palette.keyword)};
    --edit-diff-removed-background: ${unsafeCSS(palette.removedBackground)};
    --edit-diff-font-family: ${unsafeCSS(VS_CODE_MONOKAI_FONT_FAMILY)};
    --edit-diff-scrollbar-thumb: ${unsafeCSS(palette.scrollbarThumb)};
  }

  .tool-output-bubble--editor {
    ${unsafeCSS(monokaiVariables)}
    --justdo-chat-bg: var(--monokai-background);
    --justdo-chat-code-bg: var(--monokai-line-highlight);
    --justdo-chat-thinking-bg: var(--monokai-background);
    --justdo-chat-text: var(--monokai-foreground);
    --justdo-chat-muted: var(--monokai-line-number);
    --justdo-chat-text-secondary: var(--monokai-line-number);
    --justdo-chat-accent: var(--monokai-type);
  }

  .edit-diff__monaco-fallback,
  .tool-output-bubble.tool-output-bubble--editor > .tool-output-preview-text {
    font-family: ${unsafeCSS(VS_CODE_MONOKAI_FONT_FAMILY)};
    font-size: ${VS_CODE_MONOKAI_FONT_SIZE}px;
    font-weight: normal;
    line-height: ${VS_CODE_MONOKAI_LINE_HEIGHT}px;
    font-variant-ligatures: none;
  }

  .tool-output-bubble.tool-output-bubble--editor > .tool-output-preview-text {
    position: relative;
    color: var(--justdo-chat-text);
    white-space: pre;
    overflow-wrap: normal;
    overflow-x: auto;
    overflow-y: hidden;
    tab-size: 4;
    scrollbar-width: thin;
    scrollbar-color: var(--monokai-scrollbar-thumb) var(--monokai-background);
  }

  .tool-output-bubble--editor > .tool-output-preview-text:has(> .tool-output-code-gutter) {
    padding-inline-start: calc(6ch + 1.4em);
  }

  .tool-output-code-gutter {
    position: absolute;
    inset-block-start: 8px;
    inset-inline-start: 0;
    width: 6ch;
    padding-inline-end: 0.65em;
    color: var(--justdo-chat-muted);
    font-variant-numeric: tabular-nums;
    text-align: end;
    pointer-events: none;
    user-select: none;
  }

  .tool-output-code-gutter::before {
    display: block;
    white-space: pre;
    content: attr(data-line-numbers);
  }
`;
