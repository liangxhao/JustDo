import path from 'node:path';

const lockCodes = [
  'EBUSY', 'EAGAIN', 'ETXTBSY', 'EACCES', 'EPERM',
  'SQLITE_BUSY', 'SQLITE_BUSY_RECOVERY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_BUSY_TIMEOUT',
  'SQLITE_LOCKED', 'SQLITE_LOCKED_SHAREDCACHE', 'SQLITE_LOCKED_VTAB',
] as const;

type RelocationLockCode = (typeof lockCodes)[number];

export function isRelocationLockCode(code: unknown): code is RelocationLockCode {
  return typeof code === 'string' && lockCodes.includes(code as RelocationLockCode);
}

/** A worker can report an exact failing path, but cannot name a locking process. */
export const NATIVE_RELOCATION_FAILURE_DETAILS = String.raw`
const relocationLockCodes = new Set(${JSON.stringify(lockCodes)});
function relocationNativeFailureDetails(error, roots, fallbackCode) {
  const pending = [error];
  const seen = new Set();
  let code = fallbackCode;
  while (pending.length && seen.size < 16) {
    const cause = pending.shift();
    if (!cause || typeof cause !== 'object' || seen.has(cause)) continue;
    seen.add(cause);
    const lockCode = relocationLockCodes.has(cause.code) ? cause.code
      : cause.code === 'ERR_SQLITE_ERROR' && Number.isSafeInteger(cause.errcode) &&
        cause.errcode > 0 && cause.errcode < 2 ** 31
        ? { 5: 'SQLITE_BUSY', 6: 'SQLITE_LOCKED' }[cause.errcode & 255] : undefined;
    if (lockCode) {
      code ??= lockCode;
      const filename = cause.path;
      if (typeof filename === 'string' && path.isAbsolute(filename) && !/[\r\n\0]/u.test(filename) &&
          roots.some(root => {
            const relative = path.relative(root, filename);
            return relative && !path.isAbsolute(relative) &&
              relative !== '..' && !relative.startsWith('..' + path.sep);
          })) return { code: lockCode, path: filename };
    }
    pending.push(cause.cause);
    if (Array.isArray(cause.errors)) pending.push(...cause.errors.slice(0, 16));
  }
  return code ? { code } : {};
}
`;

/** Recheck the IPC scope; the OS diagnostics owner separately admits the current file. */
export function decodeRelocationNativeFailure(
  message: string,
  receipt: Record<string, unknown>,
  roots: readonly string[],
  extraCodes: readonly string[] = [],
): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(message);
  if (typeof receipt.code !== 'string') return error;
  const isLockCode = isRelocationLockCode(receipt.code);
  if (!isLockCode && !extraCodes.includes(receipt.code)) return error;
  error.code = receipt.code;
  const filename = receipt.path;
  if (isLockCode && typeof filename === 'string' && path.isAbsolute(filename) && !/[\r\n\0]/u.test(filename) &&
      roots.some(root => {
        const relative = path.relative(root, filename);
        return relative && !path.isAbsolute(relative) &&
          relative !== '..' && !relative.startsWith(`..${path.sep}`);
      })) error.path = filename;
  return error;
}
