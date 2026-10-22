import { HistoryRecoveryKind } from '../../../shared/app/startup/history';

export const HISTORY_SOURCE_CHANGED = 'HISTORY_SOURCE_CHANGED';

export function historySourceChanged(message: string): Error {
  return Object.assign(new Error(message), { code: HISTORY_SOURCE_CHANGED });
}

/** Recover advice codes from the bounded native error envelope, never transcript content. */
export function nativeHistoryError(message: string, ...diagnostics: unknown[]): Error {
  const codes: string[] = [];
  let remaining = 64;
  const visit = (value: unknown, depth = 0): void => {
    if (--remaining < 0 || depth > 6) return;
    if (typeof value === 'string') {
      if (value.length <= 256 * 1024 && /^[\s]*[\[{]/.test(value)) {
        try {
          visit(JSON.parse(value), depth + 1);
          return;
        } catch {
          /* bounded text fallback */
        }
      }
      const text = value.slice(0, 8192);
      codes.push(
        ...(text.match(
          /\b(?:SQLITE_(?:FULL|BUSY(?:_[A-Z_]+)?|LOCKED(?:_[A-Z_]+)?|READONLY(?:_[A-Z_]+)?|CANTOPEN)|ENOSPC|EDQUOT|EBUSY|EAGAIN|ETXTBSY|EACCES|EPERM|EROFS)\b/g,
        ) ?? []),
      );
      if (/database or disk is full|no space left on device/i.test(text)) codes.push('SQLITE_FULL');
      if (/database (?:table )?is locked/i.test(text)) codes.push('SQLITE_BUSY');
      if (/permission denied|access is denied/i.test(text)) codes.push('EACCES');
    } else if (Array.isArray(value)) {
      for (const entry of value.slice(0, 16)) visit(entry, depth + 1);
    } else if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      for (const key of ['code', 'error', 'cause', 'message', 'detail', 'issues', 'targets'])
        if (record[key] !== undefined) visit(record[key], depth + 1);
    }
  };
  for (const diagnostic of diagnostics) visit(diagnostic);
  const error = new Error(message);
  for (const kind of [
    HistoryRecoveryKind.Space,
    HistoryRecoveryKind.Busy,
    HistoryRecoveryKind.Access,
  ]) {
    const code = codes.find(value => classifyHistoryFailure({ code: value }) === kind);
    if (code) return Object.assign(error, { code });
  }
  return error;
}

/** Advice only; the actual error and durable recovery stage retain their authority. */
export function classifyHistoryFailure(error: unknown): HistoryRecoveryKind {
  const codes: string[] = [];
  let current = error;
  const visited = new Set<unknown>();
  while (current && typeof current === 'object' && !visited.has(current) && visited.size < 8) {
    visited.add(current);
    const value = current as { code?: unknown; cause?: unknown };
    if (typeof value.code === 'string') codes.push(value.code);
    current = value.cause;
  }
  if (codes.some(code => ['ENOSPC', 'EDQUOT', 'SQLITE_FULL'].includes(code)))
    return HistoryRecoveryKind.Space;
  if (codes.includes(HISTORY_SOURCE_CHANGED)) return HistoryRecoveryKind.Changing;
  if (
    codes.some(
      code =>
        /^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(code) ||
        ['EBUSY', 'EAGAIN', 'ETXTBSY'].includes(code),
    )
  )
    return HistoryRecoveryKind.Busy;
  if (
    codes.some(
      code =>
        ['EACCES', 'EPERM', 'EROFS', 'SQLITE_CANTOPEN'].includes(code) ||
        /^SQLITE_READONLY(_|$)/.test(code),
    )
  )
    return HistoryRecoveryKind.Access;
  return HistoryRecoveryKind.Other;
}
