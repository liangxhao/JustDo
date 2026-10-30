import type { AppUiState } from '../../../../../plugins/sdk/app-plugin-sdk/browser';

const MAX_BYTES = 32 * 1024 * 1024;
/** Local memory only. Larger than IPC wire limits; contains no live objects or executable values. */
export class AppUiStateStore implements AppUiState {
  private readonly entries = new Map<string, { value: unknown; size: number }>();
  private bytes = 0;
  get(key: string): unknown {
    assertKey(key);
    const entry = this.entries.get(key);
    return entry ? cloneData(entry.value).value : undefined;
  }
  set(key: string, value: unknown): void {
    assertKey(key);
    const previous = this.entries.get(key);
    if (value === undefined) {
      this.bytes -= previous?.size ?? 0;
      this.entries.delete(key);
      return;
    }
    const next = cloneData(value);
    const bytes = this.bytes - (previous?.size ?? 0) + next.size;
    if (bytes > MAX_BYTES || (!previous && this.entries.size >= 512))
      throw new Error('appPluginInvalidRequest');
    this.entries.set(key, next);
    this.bytes = bytes;
  }
}
function assertKey(key: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u.test(key)) throw new Error('appPluginInvalidRequest');
}
function cloneData(source: unknown): { value: unknown; size: number } {
  const ancestors = new Set<object>();
  let size = 0;
  let nodes = 0;
  const invalid = (): never => {
    throw new Error('appPluginInvalidRequest');
  };
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 200000 || depth > 32 || size > MAX_BYTES) return invalid();
    if (value === null || value === undefined || typeof value === 'boolean') {
      size += 8;
      return value;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return invalid();
      size += 8;
      return value;
    }
    if (typeof value === 'string') {
      size += value.length * 2;
      if (size > MAX_BYTES) return invalid();
      return value;
    }
    if (typeof value !== 'object' || ancestors.has(value)) return invalid();
    const array = Array.isArray(value);
    if (array && value.length > 200000) return invalid();
    if (!array && ![null, Object.prototype].includes(Object.getPrototypeOf(value)))
      return invalid();
    ancestors.add(value);
    const result: Record<string, unknown> | unknown[] = array ? [] : {};
    for (const key of Reflect.ownKeys(value)) {
      if (array && key === 'length') continue;
      if (
        typeof key !== 'string' ||
        ['__proto__', 'constructor', 'prototype'].includes(key) ||
        (array && !/^(?:0|[1-9]\d*)$/u.test(key))
      )
        return invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor) || !descriptor.enumerable) return invalid();
      size += key.length * 2;
      (result as Record<string, unknown>)[key] = visit(descriptor.value, depth + 1);
    }
    ancestors.delete(value);
    return result;
  };
  return { value: visit(source, 0), size };
}
