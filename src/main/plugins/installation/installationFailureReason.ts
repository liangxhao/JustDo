import { redactLogText } from '../../../shared/diagnostics/redaction';

const MAX_REASON_INPUT_LENGTH = 64 * 1024;
const MAX_PUBLIC_REASON_LENGTH = 4000;

/** Only use for a host installer's user-facing failure result, never arbitrary SDK output. */
export function sanitizeInstallationFailureReason(
  value: unknown,
  privatePaths: readonly (string | undefined)[] = [],
): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_REASON_INPUT_LENGTH) return undefined;
  let reason = value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .split(/\r?\n/)
    .filter(line => !/^\s+at\s/.test(line))
    .join('\n');
  reason = redactLogText(reason)
    .replace(
      /((?:["']?access[_-]?code["']?)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&}\]]+)/gi,
      '$1[REDACTED]',
    )
    .replace(/(--access[_-]?code\s+)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi, '$1[REDACTED]');
  for (const privatePath of [...privatePaths].sort((a, b) => (b?.length ?? 0) - (a?.length ?? 0))) {
    if (
      !privatePath ||
      !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(privatePath) ||
      /^(?:[A-Za-z]:)?[\\/]+$/.test(privatePath)
    )
      continue;
    const variants = new Set([
      privatePath,
      privatePath.replace(/\\/g, '/'),
      privatePath.replace(/\//g, '\\'),
    ]);
    for (const variant of variants) {
      const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      reason = reason.replace(new RegExp(escaped, 'gi'), '[REDACTED PATH]');
    }
  }
  reason = reason
    .replace(/\b(?:https?|file):\/\/[^\s<>"']+/gi, '[REDACTED URL]')
    .replace(/(["'`])(?:[A-Za-z]:[\\/]|[\\/])[^\r\n]*?\1/g, '$1[REDACTED PATH]$1')
    .replace(
      /(?:[A-Za-z]:[\\/]|\\\\|(?<![\w\\])\\)(?:[^\\/\r\n"'<>|:]+[\\/])*[^\s\\/"'<>|:,;]*/g,
      '[REDACTED PATH]',
    )
    .replace(/(?<![\w.:])\/(?:[^/\r\n"'<>|:]+\/)*[^\s/"'<>|:,;]*/g, '[REDACTED PATH]')
    .trim();
  return reason ? reason.slice(0, MAX_PUBLIC_REASON_LENGTH) : undefined;
}
