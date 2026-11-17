import type MarkdownIt from 'markdown-it';

export function createMarkdownRenderer(
  install?: (markdown: MarkdownIt) => void,
): (value: unknown, env?: Record<string, unknown>) => string;

export function renderMarkdownHtml(value: unknown): string;
