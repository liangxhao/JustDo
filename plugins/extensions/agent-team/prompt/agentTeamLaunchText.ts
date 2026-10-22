const DISALLOWED_CHAT_CONTROL_RANGE = `${String.fromCharCode(0x00)}-${String.fromCharCode(0x08)}${String.fromCharCode(0x0b)}${String.fromCharCode(0x0c)}${String.fromCharCode(0x0e)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}`;
const DISALLOWED_CHAT_CONTROL_RE = new RegExp(`[${DISALLOWED_CHAT_CONTROL_RANGE}]`, 'g');

/**
 * Fingerprint text for an explicitly selected ordinary chat.send turn only.
 * Match OpenClaw's chat-input-sanitize and the normal ingress rawMessage.trim:
 * NFC, reject NUL, remove disallowed controls, then trim. Keep native rejection
 * instead of silently stripping NUL. This grants no launch authority and must
 * never replace suffix recognition or rewrite ordinary sends/native history.
 */
export function normalizeAgentTeamLaunchText(prompt: string): string | undefined {
  const normalized = prompt.normalize('NFC');
  if (normalized.includes('\u0000')) return undefined;
  return normalized.replace(DISALLOWED_CHAT_CONTROL_RE, '').trim();
}
