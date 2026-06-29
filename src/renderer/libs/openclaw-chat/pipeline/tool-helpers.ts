/**
 * Helper functions for tool card rendering.
 * Copied from OpenClaw ui/src/ui/chat/tool-helpers.ts
 */
import { PREVIEW_MAX_CHARS, PREVIEW_MAX_LINES } from './constants';

export function formatToolOutputForSidebar(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      return '```json\n' + JSON.stringify(parsed, null, 2) + '\n```';
    } catch {
      // Not valid JSON, return as-is
    }
  }
  return text;
}

export function getTruncatedPreview(text: string): string {
  const allLines = text.split('\n');
  const lines = allLines.slice(0, PREVIEW_MAX_LINES);
  const preview = lines.join('\n');
  if (preview.length > PREVIEW_MAX_CHARS) return preview.slice(0, PREVIEW_MAX_CHARS) + '…';
  return lines.length < allLines.length ? preview + '…' : preview;
}
