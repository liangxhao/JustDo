/**
 * Chat avatar rendering — aligned with OpenClaw webchat.
 * Uses SVG icons as fallbacks instead of broken image URLs.
 */
import { html, type TemplateResult } from 'lit';
import { normalizeRoleForGrouping } from '../pipeline/role-normalizer';

const USER_SVG = html`
  <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
    <circle cx="12" cy="8" r="4" />
    <path d="M20 21a8 8 0 1 0-16 0" />
  </svg>
`;

const ASSISTANT_SVG = html`
  <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
    <path d="M12 2l2.4 7.2H22l-6 4.8 2.4 7.2L12 16l-6.4 5.2L8 14 2 9.2h7.6z" />
  </svg>
`;

const TOOL_SVG = html`
  <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
    <path d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5m7.43-2.53c.05-.33.07-.66.07-1s-.02-.67-.07-.97l2.11-1.63a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.15 7.15 0 0 0-1.69-.98l-.38-2.65A.49.49 0 0 0 14 2h-4a.49.49 0 0 0-.49.42l-.38 2.65a7.15 7.15 0 0 0-1.69.98l-2.49-1a.5.5 0 0 0-.61.22l-2 3.46a.49.49 0 0 0 .12.64L4.57 11a7.9 7.9 0 0 0 0 1.94l-2.11 1.69a.49.49 0 0 0-.12.64l2 3.46a.5.5 0 0 0 .61.22l2.49-1c.52.4 1.08.72 1.69.98l.38 2.65c.05.24.26.42.49.42h4c.23 0 .44-.18.49-.42l.38-2.65a7.15 7.15 0 0 0 1.69-.98l2.49 1a.5.5 0 0 0 .61-.22l2-3.46a.49.49 0 0 0-.12-.64z" />
  </svg>
`;

const OTHER_SVG = html`
  <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
    <circle cx="12" cy="12" r="10" />
    <text x="12" y="16.5" text-anchor="middle" font-size="14" font-weight="600" fill="var(--bg, #fff)">?</text>
  </svg>
`;

export function renderChatAvatar(role: string): TemplateResult {
  const normalized = normalizeRoleForGrouping(role);
  const className =
    normalized === 'user' ? 'user'
    : normalized === 'assistant' ? 'assistant'
    : normalized === 'tool' ? 'tool'
    : 'other';

  const icon =
    normalized === 'user' ? USER_SVG
    : normalized === 'assistant' ? ASSISTANT_SVG
    : normalized === 'tool' ? TOOL_SVG
    : OTHER_SVG;

  return html`<div class="chat-avatar ${className}">${icon}</div>`;
}
