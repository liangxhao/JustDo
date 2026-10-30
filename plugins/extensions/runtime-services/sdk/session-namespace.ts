export const SESSION_NAMESPACE_METHOD = 'runtimeServices.sessionNamespace';
export const SESSION_NAMESPACE_MAX_BYTES = 64 * 1024;
const MAX_NODES = 8192;
const MAX_DEPTH = 32;

export interface SessionNamespaceIdentity {
  sessionKey: string;
  nativeSessionId: string;
  lifecycleRevision: string | null;
}
export interface SessionNamespaceSelector {
  pluginId: string;
  namespace: string;
}
export interface SessionNamespaceReadInput extends SessionNamespaceIdentity, SessionNamespaceSelector {}
export interface SessionNamespaceSnapshot extends SessionNamespaceReadInput {
  present: boolean;
  value?: unknown;
}
export type SessionNamespaceRequester = (method: string, params: SessionNamespaceReadInput) => Promise<unknown>;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum;

export function isSessionNamespaceReadInput(value: unknown): value is SessionNamespaceReadInput {
  return record(value) &&
    Object.keys(value).sort().join(',') === 'lifecycleRevision,namespace,nativeSessionId,pluginId,sessionKey' &&
    identifier(value.sessionKey, 1024) && identifier(value.nativeSessionId, 256) &&
    (value.lifecycleRevision === null || identifier(value.lifecycleRevision, 256)) &&
    typeof value.pluginId === 'string' && /^[a-z][a-z0-9-]{0,95}$/u.test(value.pluginId) &&
    typeof value.namespace === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,95}$/u.test(value.namespace);
}

/** A namespace is JSON data, never executable objects or a lossy JSON projection. */
export function cloneSessionNamespaceValue(value: unknown): unknown {
  let nodes = 0;
  const visiting = new Set<object>();
  const clone = (input: unknown, depth: number): unknown => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw new Error('Native namespace exceeds snapshot limits.');
    if (input === null || typeof input === 'boolean' || typeof input === 'string') return input;
    if (typeof input === 'number' && Number.isFinite(input)) return input;
    if (!input || typeof input !== 'object' || visiting.has(input) || Object.getOwnPropertySymbols(input).length)
      throw new Error('Native namespace is not a readable JSON value.');
    const prototype = Object.getPrototypeOf(input) as object | null;
    if (!Array.isArray(input) && prototype !== null &&
        Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value?.name !== 'Object')
      throw new Error('Native namespace is not a JSON record.');
    visiting.add(input);
    let result: unknown;
    if (Array.isArray(input)) {
      if (input.length > MAX_NODES) throw new Error('Native namespace exceeds snapshot limits.');
      const items: unknown[] = [];
      for (let index = 0; index < input.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor?.enumerable || !('value' in descriptor)) throw new Error('Native namespace contains an unreadable value.');
        items.push(clone(descriptor.value, depth + 1));
      }
      if (Object.getOwnPropertyNames(input).some(key => key !== 'length' &&
          (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= input.length)))
        throw new Error('Native namespace array contains unsupported properties.');
      result = items;
    } else {
      const output: Record<string, unknown> = Object.create(null);
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
        if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('Native namespace contains an unreadable value.');
        output[key] = clone(descriptor.value, depth + 1);
      }
      result = output;
    }
    visiting.delete(input);
    return result;
  };
  const snapshot = clone(value, 0);
  const bytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
  if (bytes > SESSION_NAMESPACE_MAX_BYTES) throw new Error('Native namespace exceeds snapshot limits.');
  return snapshot;
}

/** The transport retains its real caller/profile permissions; identities are not grants. */
export async function readSessionNamespace(
  request: SessionNamespaceRequester,
  input: SessionNamespaceReadInput,
): Promise<SessionNamespaceSnapshot> {
  if (!isSessionNamespaceReadInput(input)) throw new Error('Exact native namespace identity is required.');
  const value = await request(SESSION_NAMESPACE_METHOD, { ...input });
  if (!record(value) || Object.keys(input).some(key => value[key] !== input[key as keyof typeof input]) ||
      typeof value.present !== 'boolean' ||
      Object.keys(value).some(key => ![...Object.keys(input), 'present', 'value'].includes(key)) ||
      value.present !== Object.hasOwn(value, 'value'))
    throw new Error('Native namespace snapshot is unavailable or belongs to another incarnation.');
  return { ...input, present: value.present,
    ...(value.present ? { value: cloneSessionNamespaceValue(value.value) } : {}) };
}
