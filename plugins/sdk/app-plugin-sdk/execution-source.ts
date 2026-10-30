/** Content-free execution provenance. It never grants tool or parent-session authority. */
export interface AppExecutionSessionQuery {
  sessionKey: string;
  nativeSessionId: string;
  lifecycleRevision?: string | null;
  runId?: string;
  /** Native-owned session metadata or an exact run initiator binding, never tool arguments. */
  ownerPluginId?: string;
}

export interface AppExecutionSourceBinding {
  version: 1;
  ownerPluginId: string;
  sessionKey: string;
  nativeSessionId: string;
  lifecycleRevision?: string | null;
}

export const APP_EXECUTION_SOURCE_BINDING = 'executionSource';
const text = (value: unknown, maximum = 512): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maximum &&
  value.trim() === value &&
  !/[\u0000-\u001f\u007f-\u009f]/.test(value);

export function isAppExecutionSessionQuery(value: unknown): value is AppExecutionSessionQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.values(Object.getOwnPropertyDescriptors(value)).some(entry => !('value' in entry)))
    return false;
  const input = value as Record<string, unknown>;
  return (
    Object.keys(input).every(key =>
      ['sessionKey', 'nativeSessionId', 'lifecycleRevision', 'runId', 'ownerPluginId'].includes(
        key,
      ),
    ) &&
    text(input.sessionKey) &&
    text(input.nativeSessionId) &&
    (input.runId === undefined || text(input.runId)) &&
    (input.lifecycleRevision === undefined ||
      input.lifecycleRevision === null ||
      text(input.lifecycleRevision)) &&
    (input.ownerPluginId === undefined || text(input.ownerPluginId, 128))
  );
}

function parseBinding(value: unknown): AppExecutionSourceBinding | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some(entry => !('value' in entry))) return null;
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      key =>
        ![
          'version',
          'ownerPluginId',
          'sessionKey',
          'nativeSessionId',
          'lifecycleRevision',
        ].includes(key),
    ) ||
    input.version !== 1 ||
    !text(input.ownerPluginId, 128) ||
    !text(input.sessionKey) ||
    !text(input.nativeSessionId) ||
    (input.lifecycleRevision !== undefined &&
      input.lifecycleRevision !== null &&
      !text(input.lifecycleRevision))
  )
    return null;
  const revision =
    typeof input.lifecycleRevision === 'string'
      ? input.lifecycleRevision
      : input.lifecycleRevision === null
        ? null
        : undefined;
  return {
    version: 1,
    ownerPluginId: input.ownerPluginId,
    sessionKey: input.sessionKey,
    nativeSessionId: input.nativeSessionId,
    ...(revision !== undefined ? { lifecycleRevision: revision } : {}),
  };
}

/** Supply through the Native run initiator's public toolBindings/MsgContext port only. */
export function createAppExecutionSourceBindings(
  source: Omit<AppExecutionSourceBinding, 'version'>,
): Readonly<Record<string, unknown>> {
  const binding = parseBinding({ ...source, version: 1 });
  if (!binding) throw new Error('Invalid execution source binding');
  return Object.freeze({ [APP_EXECUTION_SOURCE_BINDING]: Object.freeze(binding) });
}

/** A retained binding cannot follow the same key into another Native incarnation. */
export function readAppExecutionSourceBinding(
  toolBindings: unknown,
  identity: Pick<AppExecutionSessionQuery, 'sessionKey' | 'nativeSessionId' | 'lifecycleRevision'>,
): AppExecutionSourceBinding | null {
  if (!toolBindings || typeof toolBindings !== 'object' || Array.isArray(toolBindings)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(toolBindings, APP_EXECUTION_SOURCE_BINDING);
  if (!descriptor || !('value' in descriptor)) return null;
  const binding = parseBinding(descriptor.value);
  if (
    !binding ||
    binding.sessionKey !== identity.sessionKey ||
    binding.nativeSessionId !== identity.nativeSessionId ||
    (identity.lifecycleRevision !== undefined &&
      binding.lifecycleRevision !== identity.lifecycleRevision)
  )
    return null;
  return binding;
}
