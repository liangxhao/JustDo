/** Pure App-to-Native registration receipts. Native execution authority stays in OpenClaw. */
export interface AppNativeBinding {
  readonly pluginId: string;
  readonly registrationId: string;
  readonly processId: number;
  readonly gatewayMethods: readonly AppNativeGatewayMethod[];
}

export interface AppNativeGatewayMethod {
  readonly method: string;
  readonly alias: string;
}
export const APP_NATIVE_MAX_GATEWAY_METHODS = 1024;

export interface AppNativeHandshake extends AppNativeBinding {
  readonly nativeEntry: string;
  /** Entry bytes observed once at registration; this is not an ESM execution proof. */
  readonly sourceSha256: string;
}
export type AppNativeHandshakeReceipt = AppNativeHandshake;

export interface AppNativeDispatchOptions {
  readonly expectFinal?: boolean;
  readonly timeoutMs?: number;
}

export interface AppNativeDispatchRequest {
  readonly registrationId: string;
  readonly processId: number;
  readonly method: string;
  readonly params?: unknown;
  readonly options?: AppNativeDispatchOptions;
}

/** The bridge entered Native dispatch but cannot publish an authoritative outcome. */
export const APP_NATIVE_UNKNOWN_OUTCOME = 'app-native-dispatch-unknown-v1';
export interface AppNativeUnknownOutcome
  extends Pick<AppNativeBinding, 'pluginId' | 'registrationId' | 'processId'> {
  readonly kind: typeof APP_NATIVE_UNKNOWN_OUTCOME;
  readonly method: string;
}

const pluginIdPattern = /^[a-z][a-z0-9-]{0,95}$/u;
const registrationPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u;

export function createAppNativeUnknownOutcome(
  binding: AppNativeBinding,
  method: string,
): AppNativeUnknownOutcome {
  return Object.freeze({
    kind: APP_NATIVE_UNKNOWN_OUTCOME,
    pluginId: binding.pluginId,
    registrationId: binding.registrationId,
    processId: binding.processId,
    method,
  });
}

/** A remote marker applies only to the exact registration and RPC admitted by Main. */
export function isAppNativeUnknownOutcome(
  value: unknown,
  expected: AppNativeBinding,
  method: string,
): value is AppNativeUnknownOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  return (
    Object.keys(marker).length === 5 &&
    marker.kind === APP_NATIVE_UNKNOWN_OUTCOME &&
    marker.pluginId === expected.pluginId &&
    typeof marker.pluginId === 'string' &&
    pluginIdPattern.test(marker.pluginId) &&
    marker.registrationId === expected.registrationId &&
    typeof marker.registrationId === 'string' &&
    registrationPattern.test(marker.registrationId) &&
    marker.processId === expected.processId &&
    Number.isSafeInteger(marker.processId) &&
    Number(marker.processId) > 0 &&
    marker.method === method &&
    typeof marker.method === 'string' &&
    /^[A-Za-z][A-Za-z0-9_.:-]{0,255}$/u.test(marker.method)
  );
}

function methodPrefix(pluginId: string): string {
  if (!pluginIdPattern.test(pluginId)) throw new Error('Invalid App Native plugin ID');
  return `${pluginId}.app`;
}
export function appNativeHandshakeMethod(pluginId: string): string {
  return `${methodPrefix(pluginId)}.handshake`;
}
export function appNativeDispatchMethod(pluginId: string): string {
  return `${methodPrefix(pluginId)}.dispatch`;
}

export function appNativeGatewayMethodAlias(
  binding: Pick<AppNativeBinding, 'pluginId' | 'registrationId' | 'processId'>,
  ordinal: number,
): string {
  if (
    !registrationPattern.test(binding.registrationId) ||
    !Number.isSafeInteger(binding.processId) || binding.processId < 1 ||
    !Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= APP_NATIVE_MAX_GATEWAY_METHODS
  ) throw new Error('Invalid App Native gateway alias');
  const alias = `${methodPrefix(binding.pluginId)}.rpc.${binding.registrationId}.${binding.processId}.${ordinal}`;
  if (alias.length > 256) throw new Error('App Native gateway alias exceeds the method limit');
  return alias;
}

export function isAppNativeGatewayMethods(
  binding: Pick<AppNativeBinding, 'pluginId' | 'registrationId' | 'processId'>,
  value: unknown,
): value is readonly AppNativeGatewayMethod[] {
  if (!Array.isArray(value) || value.length > APP_NATIVE_MAX_GATEWAY_METHODS) return false;
  const methods = new Set<string>();
  return value.every((entry, ordinal) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      Object.keys(entry).length !== 2 || typeof entry.method !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_.:-]{0,255}$/u.test(entry.method) ||
      /\.app\.(?:handshake|dispatch|rpc)(?:\.|$)/u.test(entry.method) ||
      methods.has(entry.method)) return false;
    methods.add(entry.method);
    try { return entry.alias === appNativeGatewayMethodAlias(binding, ordinal); }
    catch { return false; }
  });
}

export function isAppNativeBinding(value: unknown): value is AppNativeBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const binding = value as AppNativeBinding;
  return Object.keys(value).length === 4 &&
    typeof binding.pluginId === 'string' && pluginIdPattern.test(binding.pluginId) &&
    typeof binding.registrationId === 'string' && registrationPattern.test(binding.registrationId) &&
    Number.isSafeInteger(binding.processId) && binding.processId > 0 &&
    isAppNativeGatewayMethods(binding, binding.gatewayMethods);
}

export function isAppNativeHandshake(value: unknown): value is AppNativeHandshake {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  return (
    Object.keys(receipt).length === 6 &&
    typeof receipt.pluginId === 'string' &&
    pluginIdPattern.test(receipt.pluginId) &&
    typeof receipt.registrationId === 'string' &&
    registrationPattern.test(receipt.registrationId) &&
    Number.isSafeInteger(receipt.processId) &&
    Number(receipt.processId) > 0 &&
    typeof receipt.nativeEntry === 'string' &&
    receipt.nativeEntry.length > 0 &&
    receipt.nativeEntry.length <= 32_768 &&
    !receipt.nativeEntry.includes('\0') &&
    typeof receipt.sourceSha256 === 'string' &&
    /^[a-f0-9]{64}$/u.test(receipt.sourceSha256) &&
    isAppNativeGatewayMethods(receipt as unknown as AppNativeBinding, receipt.gatewayMethods)
  );
}

export function parseAppNativeHandshakeReceipt(value: unknown): AppNativeHandshake {
  if (!isAppNativeHandshake(value)) throw new Error('Invalid App Native registration receipt');
  return Object.freeze({
    pluginId: value.pluginId,
    registrationId: value.registrationId,
    processId: value.processId,
    nativeEntry: value.nativeEntry,
    sourceSha256: value.sourceSha256,
    gatewayMethods: Object.freeze(value.gatewayMethods.map(entry => Object.freeze({ ...entry }))),
  });
}
