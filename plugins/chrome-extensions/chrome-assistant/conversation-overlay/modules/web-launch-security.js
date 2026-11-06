import {
  WebLaunchErrorCode,
  WebLaunchLimits,
  canonicalWebLaunchInput,
} from '../../contracts/webLaunch.ts';

export const WEB_BRIDGE = 'browser-conversation-bridge-v1';
export const WEB_RUNTIME = 'web-launch:document:';
export const BIND_ATTRIBUTE = 'data-browser-conversation-binding';

const record = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const bytes = value => new TextEncoder().encode(value).byteLength;

export function validIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

/** getRandomValues remains available on explicitly permitted HTTP intranet pages. */
export function randomIdentifier(cryptoApi = crypto) {
  if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  const value = cryptoApi.getRandomValues(new Uint8Array(16));
  value[6] = (value[6] & 15) | 64;
  value[8] = (value[8] & 63) | 128;
  const hex = [...value].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function normalizeInput(value) {
  if (
    !record(value) ||
    Object.keys(value).some(key => !['prompt', 'context', 'mode', 'result'].includes(key))
  )
    return null;
  if (
    typeof value.prompt !== 'string' ||
    !value.prompt.trim() ||
    value.prompt.length > WebLaunchLimits.promptCharacters
  )
    return null;
  if (
    value.context !== undefined &&
    (!record(value.context) ||
      Object.keys(value.context).join(',') !== 'text' ||
      typeof value.context.text !== 'string' ||
      value.context.text.length > WebLaunchLimits.contextCharacters)
  )
    return null;
  const input = {
    prompt: value.prompt,
    ...(value.context ? { context: { text: value.context.text } } : {}),
    mode: value.mode ?? 'draft',
    result: value.result ?? 'none',
  };
  if (!['draft', 'send'].includes(input.mode) || !['none', 'final'].includes(input.result))
    return null;
  if (bytes(canonicalWebLaunchInput(input)) > WebLaunchLimits.requestBytes) return null;
  if (input.context) Object.freeze(input.context);
  return Object.freeze(input);
}

export function exactOrigin(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.origin !== 'null'
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

export function trustedExtensionPage(sender, chromeApi = chrome) {
  if (sender?.id !== chromeApi.runtime.id || typeof sender.url !== 'string') return false;
  try {
    const url = new URL(sender.url);
    return (
      url.protocol === 'chrome-extension:' &&
      url.hostname === chromeApi.runtime.id &&
      ['/sidepanel.html', '/options.html', '/popup.html'].includes(url.pathname) &&
      !url.search &&
      (sender.frameId === undefined || sender.frameId === 0)
    );
  } catch {
    return false;
  }
}

export function validDocumentIdentity(sender, chromeApi = chrome) {
  return (
    sender?.id === chromeApi.runtime.id &&
    sender.frameId === 0 &&
    validIdentifier(sender.documentId) &&
    Number.isSafeInteger(sender.tab?.id) &&
    Number.isSafeInteger(sender.tab?.windowId) &&
    exactOrigin(sender.url) === sender.origin
  );
}

export function validDocumentSender(sender, chromeApi = chrome) {
  return validDocumentIdentity(sender, chromeApi) && sender.documentLifecycle === 'active';
}

export async function inputDigest(input, cryptoApi = crypto) {
  const digest = await cryptoApi.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalWebLaunchInput(input)),
  );
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const requestStates = new Set([
  'drafted',
  'awaiting-confirmation',
  'submitting',
  'submitted',
  'rejected',
  'cancelled',
  'expired',
]);
const executionStates = new Set([
  'not-started',
  'running',
  'unknown',
  'completed',
  'failed',
  'interrupted',
]);
const outputStates = new Set([
  'not-requested',
  'awaiting-consent',
  'pending',
  'available',
  'empty',
  'unsupported',
  'unavailable',
  'withheld',
]);
const deliveryStates = new Set(['connected', 'disconnected', 'acknowledged', 'revoked']);
export const PUBLIC_ERROR_CODES = new Set([
  ...Object.values(WebLaunchErrorCode),
  'BRIDGE_UNAVAILABLE',
  'FORBIDDEN',
  'PERMISSION_REQUIRED',
  'WINDOW_BUSY',
  'REQUEST_TIMEOUT',
  'NATIVE_HOST_UNAVAILABLE',
  'CONNECTION_UNAVAILABLE',
  'INCOMPATIBLE_VERSION',
  'UNKNOWN_REQUEST',
  'LEASE_REVOKED',
  'CONFLICT',
  'CANCEL_PENDING',
]);

export function publicErrorCode(error) {
  return PUBLIC_ERROR_CODES.has(error?.code) ? error.code : 'CONNECTION_UNAVAILABLE';
}

/** Rebuild each field; never forward arbitrary Main payloads to a webpage. */
export function publicReceipt(value, allowResult = false) {
  if (
    !record(value) ||
    !validIdentifier(value.requestId) ||
    !validIdentifier(value.launchId) ||
    !Number.isSafeInteger(value.receiptRevision) ||
    !requestStates.has(value.request?.status) ||
    !executionStates.has(value.execution?.status) ||
    !outputStates.has(value.output?.status) ||
    !deliveryStates.has(value.delivery?.status)
  )
    return null;
  const output = { status: value.output.status };
  if (
    allowResult &&
    value.execution.executionSettled === true &&
    typeof value.output.text === 'string' &&
    bytes(value.output.text) <= WebLaunchLimits.resultBytes &&
    value.output.status === 'available'
  ) {
    output.text = value.output.text;
    output.format = 'text';
  }
  const result = {
    requestId: value.requestId,
    launchId: value.launchId,
    receiptRevision: value.receiptRevision,
    request: { status: value.request.status },
    execution: {
      status: value.execution.status,
      executionSettled: value.execution.executionSettled === true,
    },
    output,
    delivery: { status: value.delivery.status },
  };
  if (PUBLIC_ERROR_CODES.has(value.error?.code))
    result.error = { code: value.error.code, messageKey: `webLaunchError${value.error.code}` };
  return result;
}
