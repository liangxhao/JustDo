/**
 * Markdown rendering for <justdo-chat>.
 * Replicates OpenClaw webchat's markdown.ts with highlight.js, streaming
 * boundary detection, proper DOMPurify sanitization, and code block styling.
 */

import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import katex from 'katex';
import MarkdownIt from 'markdown-it';
import markdownItTaskLists from 'markdown-it-task-lists';
import markdownItTexMath from 'markdown-it-texmath';

import { i18nService } from '@/services/i18n';

// ── Constants ───────────────────────────────────────────────────────────────

const MARKDOWN_CHAR_LIMIT = 140_000;
const MARKDOWN_PARSE_LIMIT = 40_000;
const MARKDOWN_CACHE_LIMIT = 200;
const MARKDOWN_CACHE_MAX_CHARS = 50_000;
const MARKDOWN_RENDER_CACHE_VERSION = 'markdown-render-v10';
const CJK_URL_TRAILING_PUNCTUATION_RE = /[，。；！？、]/;
const BOX_DRAWING_TOP_RE = /^[ \t]*[┌╔].*[┐╗][ \t]*$/u;
const BOX_DRAWING_BOTTOM_RE = /^[ \t]*[└╚].*[┘╝][ \t]*$/u;
const INLINE_DATA_IMAGE_RE = /^data:image\/[a-z0-9.+-]+;base64,/i;
const FENCE_OPEN_RE = /^[ \t]{0,3}(`{3,}|~{3,})/;
const FENCE_CONTAINER_PREFIX_RE = /^[ \t]{0,3}(?:(?:>\s?)|(?:(?:[-+*]|\d{1,9}[.)])[ \t]+))/;

const allowedTags = [
  'a', 'b', 'blockquote', 'br', 'button', 'code', 'del', 'details', 'div',
  'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'input', 'li', 'ol',
  'p', 'pre', 's', 'span', 'strong', 'summary', 'table', 'tbody', 'td', 'th',
  'thead', 'tr', 'ul', 'img',
];

const allowedAttrs = [
  'checked', 'class', 'disabled', 'href', 'rel', 'target', 'title', 'start',
  'src', 'alt', 'data-code', 'hidden', 'type', 'style', 'aria-hidden', 'aria-label',
];

const sanitizeOptions = {
  ALLOWED_TAGS: allowedTags,
  ALLOWED_ATTR: allowedAttrs,
  ADD_DATA_URI_TAGS: ['img'],
};

// ── highlight.js setup ──────────────────────────────────────────────────────

for (const [language, definition, aliases] of [
  ['bash', bash, ['sh', 'shell']],
  ['c', c, []],
  ['cpp', cpp, ['c++', 'cxx']],
  ['csharp', csharp, ['cs', 'c#']],
  ['css', css, []],
  ['diff', diff, ['patch']],
  ['dockerfile', dockerfile, ['docker']],
  ['go', go, ['golang']],
  ['java', java, []],
  ['javascript', javascript, ['js', 'jsx']],
  ['json', json, []],
  ['kotlin', kotlin, ['kt', 'kts']],
  ['markdown', markdown, ['md']],
  ['php', php, []],
  ['powershell', powershell, ['ps1', 'pwsh']],
  ['python', python, ['py']],
  ['ruby', ruby, ['rb']],
  ['rust', rust, ['rs']],
  ['sql', sql, []],
  ['swift', swift, []],
  ['typescript', typescript, ['ts', 'tsx']],
  ['xml', xml, ['html', 'svg']],
  ['yaml', yaml, ['yml']],
] as const) {
  hljs.registerLanguage(language, definition);
  if (aliases.length > 0) {
    hljs.registerAliases([...aliases], { languageName: language });
  }
}

hljs.registerLanguage('mermaid', () => ({
  name: 'Mermaid',
  case_insensitive: true,
  keywords: {
    keyword:
      'graph flowchart sequenceDiagram classDiagram stateDiagram stateDiagram-v2 erDiagram ' +
      'journey gantt pie gitGraph mindmap timeline quadrantChart requirementDiagram C4Context ' +
      'subgraph end participant actor as activate deactivate note over loop alt else opt par and ' +
      'rect critical break direction click linkStyle classDef class style state title section dateFormat ' +
      'axisFormat excludes includes todayMarker accTitle accDescr',
    literal: 'true false null',
    built_in: 'TB TD BT RL LR',
  },
  contains: [
    hljs.COMMENT('%%', '$'),
    hljs.QUOTE_STRING_MODE,
    hljs.APOS_STRING_MODE,
    hljs.C_NUMBER_MODE,
    {
      className: 'symbol',
      begin: /-->|---|-.->|==>|~~~|--|->|<--|<->/,
    },
    {
      className: 'meta',
      begin: /%%\{/,
      end: /\}%%/,
    },
  ],
}));

const autoHighlightLanguages = [
  'bash', 'c', 'cpp', 'csharp', 'css', 'diff', 'dockerfile', 'go', 'java',
  'javascript', 'json', 'kotlin', 'markdown', 'mermaid', 'php', 'powershell',
  'python', 'ruby', 'rust', 'sql', 'swift', 'typescript', 'xml', 'yaml',
];

const HIGHLIGHT_ALIASES: Record<string, string> = {
  'c#': 'csharp', 'c++': 'cpp', cs: 'csharp', cxx: 'cpp', docker: 'dockerfile',
  js: 'javascript', jsx: 'javascript', kt: 'kotlin', kts: 'kotlin', md: 'markdown',
  ps1: 'powershell', pwsh: 'powershell', rb: 'ruby', sh: 'bash', shell: 'bash',
  ts: 'typescript', tsx: 'typescript',
};

// ── Utility functions ───────────────────────────────────────────────────────

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncateText(text: string, limit: number): { text: string; truncated: boolean; total: number } {
  if (text.length <= limit) return { text, truncated: false, total: text.length };
  return { text: text.slice(0, limit), truncated: true, total: text.length };
}

function highlightCode(text: string, lang: string): string {
  const language = (HIGHLIGHT_ALIASES[lang.trim().toLowerCase()] ?? lang.trim().toLowerCase()) || '';
  try {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(text, { language, ignoreIllegals: true }).value;
    }
    if (!language && text.trim()) {
      const result = hljs.highlightAuto(text, autoHighlightLanguages);
      if (result.relevance >= 2) return result.value;
    }
  } catch {
    // Fall back to escaped plaintext
  }
  return escapeHtml(text);
}

function codeClassAttribute(lang: string, highlighted: string): string {
  const requestedLanguage = lang.trim().toLowerCase();
  const language = HIGHLIGHT_ALIASES[requestedLanguage] ?? requestedLanguage;
  const classes = [
    highlighted.includes('hljs-') ? 'hljs' : '',
    language ? `language-${language}` : '',
    language === 'markdown' || language === 'md' ? 'code-language-markdown' : '',
  ].filter(Boolean);
  return classes.length > 0 ? ` class="${escapeHtml(classes.join(' '))}"` : '';
}

function normalizeMarkdownFenceContent(text: string, lang: string): string {
  const language = lang.trim().toLowerCase();
  if (language !== 'markdown' && language !== 'md') return text;

  return text.replace(/^([ \t]{0,3})(?:\\+`){3,}([ \t]*)$/gm, (line, indent, suffix) => {
    const escapedFence = line.slice(indent.length).match(/^(?:\\+`)+/)?.[0] ?? '';
    const fenceLength = escapedFence.match(/`/g)?.length ?? 0;
    return `${indent}${'`'.repeat(fenceLength)}${suffix}`;
  });
}

// ── DOMPurify hooks ─────────────────────────────────────────────────────────

let hooksInstalled = false;

function installHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;

  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (!(node instanceof HTMLAnchorElement)) return;
    const href = node.getAttribute('href');
    if (!href) return;

    // Block dangerous URL schemes
    try {
      const url = new URL(href, window.location.href);
      if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') {
        node.removeAttribute('href');
        return;
      }
    } catch {
      // Relative URLs are fine
    }

    node.setAttribute('rel', 'noreferrer noopener');
    node.setAttribute('target', '_blank');
  });
}

// ── Streaming boundary detection ────────────────────────────────────────────

function getFenceMarker(line: string): { marker: '`' | '~'; length: number } | null {
  let current = line;
  for (let i = 0; i < 8; i++) {
    const next = current.replace(FENCE_CONTAINER_PREFIX_RE, '');
    if (next === current) break;
    current = next;
  }
  const match = FENCE_OPEN_RE.exec(current);
  if (!match) return null;
  const fence = match[1];
  return { marker: fence[0] as '`' | '~', length: fence.length };
}

function isFenceClose(line: string, fence: { marker: '`' | '~'; length: number }): boolean {
  let current = line;
  for (let i = 0; i < 8; i++) {
    const next = current.replace(FENCE_CONTAINER_PREFIX_RE, '');
    if (next === current) break;
    current = next;
  }
  const trimmed = current.trimEnd();
  const match = FENCE_OPEN_RE.exec(trimmed);
  if (!match) return false;
  const marker = match[1][0];
  if (marker !== fence.marker || match[1].length < fence.length) return false;
  return trimmed.slice(match[0].length).trim() === '';
}

export function findStableStreamingMarkdownBoundary(markdownText: string): number {
  let boundary = 0;
  let index = 0;
  let openFence: { marker: '`' | '~'; length: number } | null = null;
  let openBoxDrawingFrame = false;

  while (index < markdownText.length) {
    const nextLineBreak = markdownText.indexOf('\n', index);
    const lineEnd = nextLineBreak === -1 ? markdownText.length : nextLineBreak + 1;
    const line = markdownText.slice(index, nextLineBreak === -1 ? lineEnd : nextLineBreak);

    if (openFence) {
      if (isFenceClose(line, openFence)) {
        openFence = null;
        boundary = lineEnd;
      }
      index = lineEnd;
      continue;
    }

    if (openBoxDrawingFrame) {
      if (BOX_DRAWING_BOTTOM_RE.test(line)) {
        openBoxDrawingFrame = false;
        boundary = lineEnd;
      }
      index = lineEnd;
      continue;
    }

    const openingFence = getFenceMarker(line);
    if (openingFence) {
      openFence = openingFence;
      index = lineEnd;
      continue;
    }

    if (BOX_DRAWING_TOP_RE.test(line)) {
      openBoxDrawingFrame = true;
      index = lineEnd;
      continue;
    }

    if (line.trim() === '') boundary = lineEnd;
    index = lineEnd;
  }
  return boundary;
}

// ── Markdown-it instance ────────────────────────────────────────────────────

const markdownCache = new Map<string, string>();

function getCachedMarkdown(key: string): string | null {
  const cached = markdownCache.get(key);
  if (cached === undefined) return null;
  markdownCache.delete(key);
  markdownCache.set(key, cached);
  return cached;
}

function setCachedMarkdown(key: string, value: string): void {
  markdownCache.set(key, value);
  if (markdownCache.size > MARKDOWN_CACHE_LIMIT) {
    const oldest = markdownCache.keys().next().value;
    if (oldest) markdownCache.delete(oldest);
  }
}

export const md = new MarkdownIt({
  html: true, // Enable HTML recognition so overrides can escape it
  breaks: true,
  linkify: true,
});

md.enable('strikethrough');
md.linkify.set({ fuzzyLink: false });
const trimCjkUrlTrailingText = (
  match: NonNullable<ReturnType<typeof md.linkify.matchAtStart>>,
): void => {
  const punctuationIndex = match.raw.search(CJK_URL_TRAILING_PUNCTUATION_RE);
  if (punctuationIndex === -1) return;

  match.lastIndex = match.index + punctuationIndex;
  match.raw = match.raw.slice(0, punctuationIndex);
  match.text = match.text.slice(0, punctuationIndex);
  match.url = match.url.slice(0, punctuationIndex);
};
const defaultLinkifyMatch = md.linkify.match.bind(md.linkify);
md.linkify.match = (text) => {
  const matches = defaultLinkifyMatch(text);
  if (!matches) return null;

  for (const match of matches) trimCjkUrlTrailingText(match);

  return matches;
};
const defaultLinkifyMatchAtStart = md.linkify.matchAtStart.bind(md.linkify);
md.linkify.matchAtStart = (text) => {
  const match = defaultLinkifyMatchAtStart(text);
  if (match) trimCjkUrlTrailingText(match);
  return match;
};
md.validateLink = () => true;
md.use(markdownItTexMath, {
  engine: katex,
  delimiters: ['dollars', 'brackets'],
  katexOptions: {
    output: 'html',
    throwOnError: false,
    strict: false,
  },
});

// Treat complete, unfenced box-drawing frames as literal blocks. This runs as a
// paragraph terminator, so prose and other Markdown around a diagram keep their
// normal rendering, while the diagram itself retains every space and newline.
md.block.ruler.before(
  'paragraph',
  'box_drawing_diagram',
  (state, startLine, endLine, silent) => {
    const firstLine = state.src.slice(
      state.bMarks[startLine] + state.tShift[startLine],
      state.eMarks[startLine],
    );
    if (!BOX_DRAWING_TOP_RE.test(firstLine)) return false;

    let closingLine = startLine + 1;
    while (closingLine < endLine) {
      const line = state.src.slice(
        state.bMarks[closingLine] + state.tShift[closingLine],
        state.eMarks[closingLine],
      );
      if (BOX_DRAWING_BOTTOM_RE.test(line)) break;
      closingLine += 1;
    }
    if (closingLine >= endLine || closingLine <= startLine + 1) return false;
    if (silent) return true;

    const token = state.push('box_drawing_diagram', 'div', 0);
    token.block = true;
    token.map = [startLine, closingLine + 1];
    token.content = state
      .getLines(startLine, closingLine + 1, state.blkIndent, false)
      .replace(/\n$/u, '');
    state.line = closingLine + 1;
    return true;
  },
  { alt: ['paragraph'] },
);

md.renderer.rules.box_drawing_diagram = (tokens, idx) =>
  `<div class="markdown-box-drawing-diagram">${escapeHtml(tokens[idx].content)}</div>\n`;

// Override html_block/html_inline to escape raw HTML
md.renderer.rules.html_block = (tokens, idx) => escapeHtml(tokens[idx].content) + '\n';
md.renderer.rules.html_inline = (tokens, idx) => {
  const token = tokens[idx];
  if (token.meta?.taskListPlugin === true) return token.content;
  return escapeHtml(token.content);
};

// Override image to only allow base64 data URIs
md.renderer.rules.image = (tokens, idx) => {
  const token = tokens[idx];
  const src = token.attrGet('src')?.trim() ?? '';
  const alt = token.content?.trim() || 'image';
  if (!INLINE_DATA_IMAGE_RE.test(src)) return escapeHtml(alt);
  return `<img class="markdown-inline-image" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">`;
};

// Keep wide tables readable without expanding or compressing the message bubble.
md.renderer.rules.table_open = () => '<div class="markdown-table-scroll"><table>\n';
md.renderer.rules.table_close = () => '</table></div>\n';

// Override fenced code blocks with copy button + JSON collapse
md.renderer.rules.fence = (tokens, idx, _options, env) => {
  const token = tokens[idx];
  const lang = token.info.trim().split(/\s+/)[0] || '';
  const isMarkdownCodeBlock = ['markdown', 'md'].includes(lang.trim().toLowerCase());
  const text = normalizeMarkdownFenceContent(token.content, lang);
  const highlighted = highlightCode(text, lang);
  const classAttr = codeClassAttribute(lang, highlighted);
  const codeBlock = `<pre><code${classAttr}>${highlighted}</code></pre>`;

  const envChrome = (env as { codeBlockChrome?: string })?.codeBlockChrome;
  if (envChrome === 'none') return codeBlock;

  if (lang.toLowerCase() === 'mermaid') {
    const showCodeLabel = escapeHtml(i18nService.t('showCode'));
    const toggleBtn = `<button type="button" class="mermaid-toggle" aria-label="${showCodeLabel}" title="${showCodeLabel}"><span aria-hidden="true">▶</span></button>`;
    const header = `<div class="code-block-header"><span class="code-block-lang">mermaid (rendered)</span>${toggleBtn}</div>`;
    return `<div class="code-block-wrapper mermaid-block">${header}<div class="mermaid-preview" aria-live="polite"></div><div class="mermaid-source" hidden>${codeBlock}</div></div>`;
  }

  const langLabel = lang ? `<span class="code-block-lang">${escapeHtml(lang)}</span>` : '';
  const attrSafe = escapeHtml(text);
  const copyLabel = escapeHtml(i18nService.t('copy'));
  const copiedLabel = escapeHtml(i18nService.t('copied'));
  const copyAriaLabel = escapeHtml(i18nService.t('copyToClipboard'));
  const copyBtn = `<button type="button" class="code-block-copy" data-code="${attrSafe}" aria-label="${copyAriaLabel}"><span class="code-block-copy__idle">${copyLabel}</span><span class="code-block-copy__done">${copiedLabel}</span></button>`;
  const header = `<div class="code-block-header">${langLabel}${copyBtn}</div>`;

  const trimmed = text.trim();
  const isJson = lang === 'json' || (!lang &&
    ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
     (trimmed.startsWith('[') && trimmed.endsWith(']'))));

  if (isJson) {
    const lineCount = text.split('\n').length;
    const label = lineCount > 1 ? `JSON · ${lineCount} lines` : 'JSON';
    return `<details class="json-collapse"><summary>${label}</summary><div class="code-block-wrapper">${header}${codeBlock}</div></details>`;
  }
  const wrapperClass = isMarkdownCodeBlock
    ? 'code-block-wrapper code-block-wrapper--markdown'
    : 'code-block-wrapper';
  return `<div class="${wrapperClass}">${header}${codeBlock}</div>`;
};

// Override indented code blocks
md.renderer.rules.code_block = (tokens, idx, _options, env) => {
  const token = tokens[idx];
  const text = token.content;
  const highlighted = highlightCode(text, '');
  const classAttr = codeClassAttribute('', highlighted);
  const codeBlock = `<pre><code${classAttr}>${highlighted}</code></pre>`;

  const envChrome = (env as { codeBlockChrome?: string })?.codeBlockChrome;
  if (envChrome === 'none') return codeBlock;

  const attrSafe = escapeHtml(text);
  const copyLabel = escapeHtml(i18nService.t('copy'));
  const copiedLabel = escapeHtml(i18nService.t('copied'));
  const copyAriaLabel = escapeHtml(i18nService.t('copyToClipboard'));
  const copyBtn = `<button type="button" class="code-block-copy" data-code="${attrSafe}" aria-label="${copyAriaLabel}"><span class="code-block-copy__idle">${copyLabel}</span><span class="code-block-copy__done">${copiedLabel}</span></button>`;
  const header = `<div class="code-block-header">${copyBtn}</div>`;
  return `<div class="code-block-wrapper">${header}${codeBlock}</div>`;
};

// Task lists
md.use(markdownItTaskLists, { enabled: false, label: false });

// ── Public API ──────────────────────────────────────────────────────────────

function toEscapedPlainTextHtml(value: string): string {
  return `<div class="markdown-plain-text-fallback">${escapeHtml(value.replace(/\r\n?/g, '\n'))}</div>`;
}

export interface MarkdownRenderOptions {
  parseLimit?: number;
}

export function toSanitizedMarkdownHtml(text: string, options: MarkdownRenderOptions = {}): string {
  if (!text) return '';
  installHooks();

  const input = text.trim().replace(/\r\n?/g, '\n');
  if (!input) return '';
  const parseLimit = Math.min(
    Math.max(options.parseLimit ?? MARKDOWN_PARSE_LIMIT, 1),
    MARKDOWN_CHAR_LIMIT,
  );

  const cacheKey = `${MARKDOWN_RENDER_CACHE_VERSION}:${parseLimit}:${i18nService.getLanguage()}:${input}`;
  if (input.length <= MARKDOWN_CACHE_MAX_CHARS) {
    const cached = getCachedMarkdown(cacheKey);
    if (cached !== null) return cached;
  }

  const truncated = truncateText(input, MARKDOWN_CHAR_LIMIT);
  const suffix = truncated.truncated
    ? `\n\n… truncated (${truncated.total} chars, showing first ${truncated.text.length}).`
    : '';

  if (truncated.text.length > parseLimit) {
    const html = toEscapedPlainTextHtml(`${truncated.text}${suffix}`);
    const sanitized = DOMPurify.sanitize(html, sanitizeOptions) as unknown as string;
    if (input.length <= MARKDOWN_CACHE_MAX_CHARS) setCachedMarkdown(cacheKey, sanitized);
    return sanitized;
  }

  let rendered: string;
  try {
    rendered = md.render(`${truncated.text}${suffix}`);
  } catch {
    rendered = `<pre class="code-block">${escapeHtml(`${truncated.text}${suffix}`)}</pre>`;
  }

  const sanitized = DOMPurify.sanitize(rendered, sanitizeOptions) as unknown as string;
  if (input.length <= MARKDOWN_CACHE_MAX_CHARS) setCachedMarkdown(cacheKey, sanitized);
  return sanitized;
}

export function toStreamingMarkdownHtml(text: string): string {
  if (!text) return '';
  const input = text.trim().replace(/\r\n?/g, '\n');
  if (!input) return '';

  const boundary = findStableStreamingMarkdownBoundary(input);
  if (boundary <= 0) return toEscapedPlainTextHtml(input);

  const stableMarkdown = input.slice(0, boundary);
  const streamingTail = input.slice(boundary);
  const stableHtml = toSanitizedMarkdownHtml(stableMarkdown);
  if (!streamingTail.trim()) return stableHtml;
  return `${stableHtml}${toEscapedPlainTextHtml(streamingTail)}`;
}
