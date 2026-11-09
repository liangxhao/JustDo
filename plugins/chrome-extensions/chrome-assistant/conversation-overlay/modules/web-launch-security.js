import {
  WebLaunchErrorCode,
  WebLaunchLimits,
  canonicalWebLaunchInput,
} from '../../contracts/webLaunch.ts';

export const WEB_BRIDGE = 'browser-conversation-bridge-v1';
export const WEB_RUNTIME = 'web-launch:document:';
export const WEB_CONNECTION = 'web-launch:connection';
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

export function validExternalDocumentSender(sender, allowInactive = false) {
  return (
    sender?.id === undefined &&
    sender.frameId === 0 &&
    (allowInactive || sender.documentLifecycle === 'active') &&
    validIdentifier(sender.documentId) &&
    Number.isSafeInteger(sender.tab?.id) &&
    Number.isSafeInteger(sender.tab?.windowId) &&
    exactOrigin(sender.url) !== null &&
    exactOrigin(sender.url) === sender.origin
  );
}

/** SHA-256 for explicitly supported HTTP pages, where SubtleCrypto is unavailable. */
function sha256(bytes) {
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const state = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const buffer = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  const data = new DataView(buffer.buffer);
  data.setUint32(buffer.length - 8, Math.floor(bytes.length / 0x20000000));
  data.setUint32(buffer.length - 4, bytes.length * 8);
  const rotate = (value, bits) => (value >>> bits) | (value << (32 - bits));
  for (let offset = 0; offset < buffer.length; offset += 64) {
    const words = new Uint32Array(64);
    for (let index = 0; index < 16; index++) words[index] = data.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index++) {
      const x = words[index - 15],
        y = words[index - 2];
      words[index] =
        words[index - 16] +
        (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) +
        words[index - 7] +
        (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10));
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index++) {
      const first =
        (h +
          (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
          ((e & f) ^ (~e & g)) +
          constants[index] +
          words[index]) |
        0;
      const second =
        ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      [a, b, c, d, e, f, g, h] = [(first + second) | 0, a, b, c, (d + first) | 0, e, f, g];
    }
    [a, b, c, d, e, f, g, h].forEach((value, index) => {
      state[index] = (state[index] + value) >>> 0;
    });
  }
  return state.map(value => value.toString(16).padStart(8, '0')).join('');
}

export async function inputDigest(input, cryptoApi = crypto) {
  if (!cryptoApi.subtle) return sha256(new TextEncoder().encode(canonicalWebLaunchInput(input)));
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
  'PANEL_OPEN_FAILED',
  'CONNECTION_REJECTED',
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
