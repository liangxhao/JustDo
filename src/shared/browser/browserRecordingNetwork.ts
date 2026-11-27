import type { BrowserAgentProfile } from './browser';

export const RecordingNetworkType = {
  Document: 'document',
  Fetch: 'fetch',
  Xhr: 'xhr',
  EventSource: 'event-source',
  Preflight: 'preflight',
  Resource: 'resource',
} as const;
export const RecordingNetworkOutcome = {
  Complete: 'complete',
  Failed: 'failed',
  Canceled: 'canceled',
  Redirected: 'redirected',
  Unfinished: 'unfinished',
} as const;
export const RecordingNetworkGroup = {
  Load: 'load',
  Action: 'action',
  Unassigned: 'unassigned',
} as const;
export const RecordingNetworkFailure = {
  Dns: 'dns',
  Tls: 'tls',
  Timeout: 'timeout',
  Blocked: 'blocked',
  Cors: 'cors',
  Other: 'other',
} as const;
export const RecordingNetworkCoverage = {
  Unavailable: 'unavailable',
  LateStart: 'late-start',
  Detached: 'detached',
  Limit: 'limit',
  Unattributed: 'unattributed',
  Clock: 'clock',
  Transfer: 'transfer',
} as const;

export type RecordingNetworkType = (typeof RecordingNetworkType)[keyof typeof RecordingNetworkType];
export type RecordingNetworkOutcome =
  (typeof RecordingNetworkOutcome)[keyof typeof RecordingNetworkOutcome];
export type RecordingNetworkGroup =
  (typeof RecordingNetworkGroup)[keyof typeof RecordingNetworkGroup];
export type RecordingNetworkFailure =
  (typeof RecordingNetworkFailure)[keyof typeof RecordingNetworkFailure];
export type RecordingNetworkCoverageIssue =
  (typeof RecordingNetworkCoverage)[keyof typeof RecordingNetworkCoverage];

export const RECORDING_NETWORK_LIMITS = {
  entries: 500,
  inFlight: 256,
  reservedInFlight: 64,
  segments: 256,
  documents: 256,
  redirects: 8,
  path: 512,
  search: 2048,
  queryParams: 32,
  prepareMs: 750,
  finishMs: 750,
} as const;

export type RecordingNetworkPageRef = {
  resourceSessionId: string;
  targetId: string;
  expectedWebContentsId: number;
};

export type RecordingNetworkLeaseRef = {
  recordingId: string;
  sessionId: string;
  profile: BrowserAgentProfile;
};

export type RecordingNetworkCommand = {
  lease: RecordingNetworkLeaseRef;
  sequence: number;
} & (
  | { action: 'start'; page: RecordingNetworkPageRef | null }
  | { action: 'setTarget'; page: RecordingNetworkPageRef | null; requestedAtMs: number }
  | { action: 'pause' | 'finish'; requestedAtMs: number }
  | {
      action: 'transferTarget';
      from: RecordingNetworkPageRef;
      toSessionId: string;
      requestedAtMs: number;
    }
);

export type RecordingNetworkReply =
  | { status: 'denied' }
  | ({ recordingId: string; sequence: number } & (
      | { status: 'ready'; segmentId: number }
      | { status: 'waiting' | 'paused' | 'transferReady' | 'unavailable' | 'stale' }
      | { status: 'finished'; snapshot: RecordingNetworkSnapshot }
    ));

export type RecordingNetworkAddress = {
  origin: string;
  path: string;
  search?: string;
  urlRedacted?: true;
  urlLimited?: true;
};

type RecordingNetworkRequest = RecordingNetworkAddress & {
  type: RecordingNetworkType;
  method: string;
  outcome: RecordingNetworkOutcome;
  status?: number;
  failure?: RecordingNetworkFailure;
};

export type RecordingNetworkEntry = RecordingNetworkRequest & {
  pageId: string;
  stepId?: string;
  group: RecordingNetworkGroup;
  loadSequence?: number;
};

export type RecordingNetworkObservation = RecordingNetworkRequest & {
  id: string;
  pageId: string;
  segmentId: number;
  startedAtMs: number;
  documentId?: number;
  loadSequence?: number;
  withinLoad?: true;
  frame?: 'child';
};

export type RecordingNetworkDocument = {
  id: number;
  startedAtMs: number;
  committedAtMs?: number;
  endedAtMs?: number;
  loadSequence?: number;
};

export type RecordingNetworkSegment = {
  id: number;
  pageId: string;
  webContentsId: number;
  startedAtMs: number;
  endedAtMs: number;
  documents: RecordingNetworkDocument[];
};

export type RecordingNetworkSnapshot = {
  entries: RecordingNetworkObservation[];
  segments: RecordingNetworkSegment[];
  coverage: RecordingNetworkCoverageIssue[];
  omittedCount: number;
};

export type RecordingNetworkCapturedEntry = RecordingNetworkEntry & { id: string };

export type RecordingNetworkCapture = {
  entries: RecordingNetworkCapturedEntry[];
  coverage: RecordingNetworkCoverageIssue[];
  omittedCount: number;
  include?: boolean;
  selections?: Record<string, boolean>;
  addressModes?: Record<string, 'without-query' | 'origin'>;
};

export type RecordingNetworkSummary = {
  entries: RecordingNetworkEntry[];
  partial?: true;
  omittedCount?: number;
};

const HTTP_METHODS = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'CONNECT',
  'TRACE',
]);
const SESSION_CREDENTIAL_FIELDS = new Set([
  'jsessionid',
  'phpsessid',
  'asp.net_sessionid',
  'asp.net_session_id',
]);
const CREDENTIAL_FIELDS = new Set([
  ...SESSION_CREDENTIAL_FIELDS,
  'access_token',
  'refresh_token',
  'id_token',
  'auth_token',
  'oauth_token',
  'code_verifier',
  'session_token',
  'token',
  'password',
  'passwd',
  'api_key',
  'apikey',
  'x_api_key',
  'client_secret',
  'authorization',
  'signature',
  'saml_response',
  'samlresponse',
  'x_amz_signature',
  'x_amz_credential',
  'x_amz_security_token',
  'x_goog_signature',
  'x_goog_credential',
]);
const CREDENTIAL_PATHS = new Set(['reset-password', 'magic-link', 'verify-token', 'access-token']);
const CREDENTIAL_PATH_ACTIONS = new Set([
  'request',
  'send',
  'resend',
  'verify',
  'confirm',
  'complete',
  'status',
  'callback',
  'new',
  'start',
]);
const RETURN_URL_FIELDS = new Set([
  'return',
  'return_to',
  'return_url',
  'redirect',
  'redirect_uri',
  'redirect_url',
  'next',
  'continue',
  'callback',
]);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const REDACTED = '%5Bredacted%5D';
const MAX_URL_INPUT = 32_768;

export function recordingNetworkMethod(value: unknown): string {
  if (typeof value !== 'string') return 'OTHER';
  const method = value.toUpperCase();
  return HTTP_METHODS.has(method) ? method : 'OTHER';
}

function decodePart(value: string, query = false): string | undefined {
  try {
    const decoded = decodeURIComponent(query ? value.replace(/\+/g, ' ') : value);
    return CONTROL.test(decoded) ? undefined : decoded;
  } catch {
    return undefined;
  }
}

function fieldName(value: string): string {
  return value
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase();
}

function isCredentialValue(value: string): boolean {
  return (
    /^(?:Bearer|Basic) [^\s]+$/i.test(value) ||
    /^eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(value)
  );
}

function queryField(value: string): string {
  const key = value.split('=', 1)[0];
  return fieldName(decodePart(key, true) ?? '');
}

function signedQuery(keys: readonly string[]): boolean {
  // Azure SAS carries its signature alongside version, expiry and permissions/resource fields.
  return (
    keys.includes('signature') ||
    keys.includes('x_amz_signature') ||
    keys.includes('x_goog_signature') ||
    (keys.includes('sig') &&
      keys.includes('sv') &&
      (keys.includes('se') || keys.includes('si')) &&
      keys.some(key => key === 'sp' || key === 'sr' || key === 'ss'))
  );
}

function credentialField(key: string, auth: boolean, signed: boolean): boolean {
  return (
    CREDENTIAL_FIELDS.has(key) ||
    (auth && (key === 'code' || key === 'state')) ||
    (signed && (key === 'key' || key === 'sig'))
  );
}

function authenticationQuery(keys: readonly string[], path: string): boolean {
  return path.split('/').some(segment => {
    const decoded = decodePart(segment) ?? '';
    return (
      /^(?:oauth2?|oidc|saml|signin-oidc|oauth-callback)$/i.test(decoded) ||
      (/^(?:callback|authorize)$/i.test(decoded) && keys.includes('code') && keys.includes('state'))
    );
  });
}

function redactSessionPathParameters(segment: string): string {
  const [name, ...parameters] = segment.split(';');
  if (!parameters.length) return segment;
  return [
    name,
    ...parameters.map(parameter => {
      const equals = parameter.indexOf('=');
      if (equals <= 0 || equals === parameter.length - 1) return parameter;
      const key = parameter.slice(0, equals);
      return SESSION_CREDENTIAL_FIELDS.has(fieldName(decodePart(key) ?? ''))
        ? `${key}=${REDACTED}`
        : parameter;
    }),
  ].join(';');
}

function recordingAddressUrl(value: string, base?: string): URL | null {
  if ((!base && !/^https?:\/\//i.test(value)) || CONTROL.test(value)) return null;
  try {
    const url = new URL(value, base);
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.origin.length <= 512 &&
      url.hostname
      ? url
      : null;
  } catch {
    return null;
  }
}

type CredentialMatcher = (key: string) => boolean;
type UrlProjection = { value: string; redacted: boolean; limited: boolean };

function projectUrlQuery(
  query: string,
  url: URL,
  depth: number,
  extraCredential?: CredentialMatcher,
  route = '',
): UrlProjection {
  const fields = query ? query.split('&') : [];
  const keys = fields.map(queryField);
  const auth = authenticationQuery(keys, url.pathname) || authenticationQuery(keys, route);
  const signed = signedQuery(keys);
  const search: string[] = [];
  let redacted = false;
  let limited = false;
  let searchLength = 0;
  for (const [index, part] of fields.entries()) {
    if (search.length >= RECORDING_NETWORK_LIMITS.queryParams) {
      limited = true;
      break;
    }
    const separator = part.indexOf('=');
    const encodedKey = separator === -1 ? part : part.slice(0, separator);
    const decodedKey = decodePart(encodedKey, true);
    const decoded = decodePart(separator === -1 ? '' : part.slice(separator + 1), true);
    if (decoded === undefined || decodedKey === undefined) {
      limited = true;
      continue;
    }
    const key = keys[index];
    let output = part;
    const relativeReturn =
      RETURN_URL_FIELDS.has(key) && /[/?#]/.test(decoded) && !/^[a-z][a-z\d+.-]*:/i.test(decoded);
    if (
      decoded &&
      (credentialField(key, auth, signed) ||
        extraCredential?.(decodedKey) ||
        isCredentialValue(decoded))
    ) {
      redacted = true;
      output = `${encodedKey}=${REDACTED}`;
    } else if (relativeReturn || /^https?:\/\//i.test(decoded)) {
      if (depth >= 2) {
        limited = true;
        continue;
      }
      const nestedUrl = recordingAddressUrl(
        decoded,
        relativeReturn ? `${url.origin}${url.pathname}` : undefined,
      );
      const nested =
        nestedUrl && sanitizeRecordingAddress(nestedUrl.href, depth + 1, extraCredential);
      if (!nested || !nestedUrl) {
        limited = true;
        continue;
      }
      const { address, fragment } = nested;
      if (address.urlRedacted || address.urlLimited) {
        redacted ||= address.urlRedacted === true;
        limited ||= address.urlLimited === true;
        const protocolRelative = relativeReturn && decoded.startsWith('//');
        const origin = protocolRelative
          ? address.origin.replace(/^https?:/i, '')
          : relativeReturn
            ? ''
            : address.origin;
        const path =
          relativeReturn && !protocolRelative && address.path === nestedUrl.pathname
            ? decoded.split(/[?#]/, 1)[0]
            : address.path;
        output = `${encodedKey}=${encodeURIComponent(`${origin}${path}${address.search ?? ''}${fragment}`)}`;
      }
    }
    if (searchLength + output.length + 1 > RECORDING_NETWORK_LIMITS.search) {
      limited = true;
      continue;
    }
    search.push(output);
    searchLength += output.length + 1;
  }
  return { value: search.join('&'), redacted, limited };
}

function projectUrlFragment(
  url: URL,
  depth: number,
  extraCredential?: CredentialMatcher,
): UrlProjection {
  const fragment = url.hash.slice(1);
  if (isCredentialValue(decodePart(fragment) ?? ''))
    return { value: `#${REDACTED}`, redacted: true, limited: false };
  const questionMark = fragment.indexOf('?');
  const route = questionMark > 0 ? fragment.slice(0, questionMark) : '';
  const hasRoute = !!route && !route.includes('=');
  const query = hasRoute ? fragment.slice(questionMark + 1) : fragment;
  if (!query.includes('=')) return { value: url.hash, redacted: false, limited: false };
  const projection = projectUrlQuery(query, url, depth, extraCredential, hasRoute ? route : '');
  const content = hasRoute
    ? `${route}${projection.value ? `?${projection.value}` : ''}`
    : projection.value;
  return { ...projection, value: content ? `#${content}` : '' };
}

function sanitizeRecordingAddress(
  value: string,
  depth: number,
  extraCredential?: CredentialMatcher,
  pathLimit: number = RECORDING_NETWORK_LIMITS.path,
): { address: RecordingNetworkAddress; fragment: string } | null {
  const oversized = value.length > MAX_URL_INPUT;
  const url = recordingAddressUrl(
    oversized
      ? (value.slice(0, 1025).match(/^https?:\/\/[^/?#\\\s]+(?=[/?#])/i)?.[0] ?? '')
      : value,
  );
  if (!url) return null;

  let redacted = Boolean(url.username || url.password);
  let limited = oversized;
  let path = oversized ? '' : url.pathname;
  if (path.length > pathLimit) {
    path = '';
    limited = true;
  }
  if (path) {
    const parts = path.split('/');
    const decodedPath = parts.map(part => decodePart(part));
    if (decodedPath.some(part => part === undefined)) {
      path = '';
      limited = true;
    } else {
      path = parts
        .map((part, index) => {
          const decoded = decodedPath[index] ?? '';
          const previous = decodedPath[index - 1]?.toLowerCase() ?? '';
          if (
            isCredentialValue(decoded) ||
            (CREDENTIAL_PATHS.has(previous) &&
              decoded &&
              !CREDENTIAL_PATH_ACTIONS.has(decoded.toLowerCase()))
          ) {
            redacted = true;
            return REDACTED;
          }
          const projected = redactSessionPathParameters(part);
          redacted ||= projected !== part;
          return projected;
        })
        .join('/');
    }
  }

  const query = projectUrlQuery(url.search.slice(1), url, depth, extraCredential);
  const fragment = projectUrlFragment(url, depth, extraCredential);
  return {
    address: {
      origin: url.origin,
      path,
      ...(query.value ? { search: `?${query.value}` } : {}),
      ...(redacted || query.redacted || fragment.redacted ? { urlRedacted: true } : {}),
      ...(limited || query.limited || fragment.limited ? { urlLimited: true } : {}),
    },
    fragment: fragment.value,
  };
}

export function sanitizeRecordingNetworkAddress(value: unknown): RecordingNetworkAddress | null {
  return typeof value === 'string' ? (sanitizeRecordingAddress(value, 0)?.address ?? null) : null;
}

export function sanitizeRecordingLocation(
  value: string,
  extraCredential?: CredentialMatcher,
): string {
  const projected = sanitizeRecordingAddress(value, 0, extraCredential, 800);
  if (!projected) return '';
  const { address, fragment } = projected;
  return `${address.origin}${address.path || '/'}${address.search ?? ''}${fragment}`.slice(0, 800);
}

export function recordingNetworkAddressText(
  address: RecordingNetworkAddress,
  hiddenLabel = '[redacted]',
): string {
  const url = `${address.origin}${address.path}${address.search ?? ''}`;
  return address.urlRedacted ? url.split(REDACTED).join(hiddenLabel) : url;
}

export function isRecordingNetworkEntrySelected(
  capture: RecordingNetworkCapture,
  entry: RecordingNetworkCapturedEntry,
): boolean {
  const selected = capture.selections?.[entry.id];
  if (typeof selected === 'boolean') return selected;
  if (entry.type === RecordingNetworkType.Resource || entry.type === RecordingNetworkType.Preflight)
    return false;
  return (
    entry.outcome === RecordingNetworkOutcome.Failed ||
    (entry.status ?? 0) >= 400 ||
    entry.group !== RecordingNetworkGroup.Unassigned ||
    ['POST', 'PUT', 'PATCH', 'DELETE'].includes(entry.method)
  );
}

type RecordingNetworkStep = { id: string; pageId: string; action: string; sensitive?: boolean };

const LOAD_ACTIONS = new Set(['navigate', 'openTab']);
const NETWORK_ACTIONS = new Set(['click', 'doubleClick', 'input', 'select', 'key']);
const MAX_COUNT = 1_000_000_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 80 && !CONTROL.test(value)
    ? value
    : undefined;
}

function integer(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : undefined;
}

function member<T extends string>(value: unknown, values: Record<string, T>): value is T {
  return typeof value === 'string' && (Object.values(values) as readonly string[]).includes(value);
}

function readAddress(value: Record<string, unknown>): RecordingNetworkAddress | null {
  const { origin, path, search } = value;
  if (
    typeof origin !== 'string' ||
    origin.length > 512 ||
    recordingAddressUrl(origin)?.origin !== origin
  ) {
    return null;
  }
  const validPath =
    typeof path === 'string' && (path === '' || path.startsWith('/')) && !/[?#\\]/.test(path);
  const validSearch =
    search === undefined ||
    (typeof search === 'string' && search.startsWith('?') && !search.includes('#'));
  const target = `${origin}${validPath ? path : ''}${validSearch ? (search ?? '') : ''}`;
  const projected = sanitizeRecordingNetworkAddress(target);
  if (!projected || projected.origin !== origin) return null;
  return {
    ...projected,
    ...(path === '' || !validPath ? { path: '' } : {}),
    ...(value.urlRedacted === true ? { urlRedacted: true } : {}),
    ...(value.urlLimited === true || !validPath || !validSearch ? { urlLimited: true } : {}),
  };
}

function readEntry(
  source: unknown,
  steps: ReadonlyMap<string, RecordingNetworkStep>,
): RecordingNetworkEntry | undefined {
  const value = record(source);
  if (!value) return undefined;
  const { type, group, outcome } = value;
  const pageId = safeId(value.pageId);
  const stepId = safeId(value.stepId);
  const loadSequence = integer(value.loadSequence, 1, RECORDING_NETWORK_LIMITS.documents);
  if (
    !pageId ||
    !member(type, RecordingNetworkType) ||
    !member(group, RecordingNetworkGroup) ||
    !member(outcome, RecordingNetworkOutcome) ||
    (type === RecordingNetworkType.Document && group !== RecordingNetworkGroup.Load) ||
    (group === RecordingNetworkGroup.Load && loadSequence === undefined) ||
    (group === RecordingNetworkGroup.Action && !stepId) ||
    (group === RecordingNetworkGroup.Unassigned && value.stepId !== undefined)
  )
    return undefined;
  if (value.stepId !== undefined) {
    const step = stepId ? steps.get(stepId) : undefined;
    if (
      !step ||
      step.pageId !== pageId ||
      step.sensitive ||
      !(group === RecordingNetworkGroup.Load ? LOAD_ACTIONS : NETWORK_ACTIONS).has(step.action)
    )
      return undefined;
  }
  const address = readAddress(value);
  if (!address) return undefined;
  const status = integer(value.status, 100, 599);
  return {
    pageId,
    ...(stepId ? { stepId } : {}),
    group,
    ...(group === RecordingNetworkGroup.Load ? { loadSequence } : {}),
    type,
    method: recordingNetworkMethod(value.method),
    ...address,
    outcome,
    ...(status === undefined ? {} : { status }),
    ...(member(value.failure, RecordingNetworkFailure) ? { failure: value.failure } : {}),
  };
}

export function readRecordingNetworkSummary(
  source: unknown,
  steps: readonly RecordingNetworkStep[],
): { summary?: RecordingNetworkSummary; comparable: boolean } {
  if (source === undefined) return { comparable: true };
  const value = record(source);
  if (!value || !Array.isArray(value.entries)) return { comparable: false };
  const refs = new Map(steps.map(step => [step.id, step]));
  let comparable = value.entries.length <= RECORDING_NETWORK_LIMITS.entries;
  const entries = value.entries.slice(0, RECORDING_NETWORK_LIMITS.entries).flatMap(entry => {
    const parsed = readEntry(entry, refs);
    const original = record(entry);
    comparable &&= Boolean(
      parsed &&
      original &&
      original.path === parsed.path &&
      original.search === parsed.search &&
      original.urlRedacted === parsed.urlRedacted &&
      original.urlLimited === parsed.urlLimited &&
      original.method === parsed.method &&
      original.status === parsed.status,
    );
    return parsed ? [parsed] : [];
  });
  if (!entries.length) return { comparable: false };
  const omittedCount = integer(value.omittedCount, 1, MAX_COUNT);
  return {
    summary: {
      entries,
      ...(value.partial === true ? { partial: true } : {}),
      ...(omittedCount ? { omittedCount } : {}),
    },
    comparable,
  };
}

function entryPriority(entry: RecordingNetworkEntry): number {
  if (entry.outcome === RecordingNetworkOutcome.Failed || (entry.status ?? 0) >= 400) return 0;
  if (entry.group === RecordingNetworkGroup.Action) return 1;
  if (entry.group === RecordingNetworkGroup.Load) return 2;
  return 3;
}

export function projectRecordingNetwork(
  capture: RecordingNetworkCapture | undefined,
  history: RecordingNetworkSummary | undefined,
  steps: readonly RecordingNetworkStep[],
  available: number,
  stringify: (value: unknown) => string,
): { summary?: RecordingNetworkSummary; omittedCount: number } {
  if (capture && !capture.include) return { omittedCount: 0 };
  const refs = new Map(steps.map(step => [step.id, step]));
  const entries = capture
    ? capture.entries
        .filter(entry => isRecordingNetworkEntrySelected(capture, entry))
        .map(entry => {
          const mode = capture.addressModes?.[entry.id];
          return mode
            ? { ...entry, path: mode === 'origin' ? '' : entry.path, search: undefined }
            : entry;
        })
    : (history?.entries ?? []);
  if (!entries.length) return { omittedCount: 0 };

  const partial =
    history?.partial ||
    (capture &&
      (capture.omittedCount > 0 ||
        capture.coverage.some(
          issue =>
            issue === RecordingNetworkCoverage.Unavailable ||
            issue === RecordingNetworkCoverage.Detached ||
            issue === RecordingNetworkCoverage.Limit ||
            issue === RecordingNetworkCoverage.LateStart ||
            issue === RecordingNetworkCoverage.Unattributed ||
            issue === RecordingNetworkCoverage.Transfer,
        )));
  const previousOmitted = capture?.omittedCount ?? history?.omittedCount ?? 0;
  const candidates = entries.flatMap((entry, index) => {
    const validated = readEntry(entry, refs);
    return validated ? [{ entry: validated, index }] : [];
  });
  if (!candidates.length) return { omittedCount: 0 };
  const summaryWith = (
    validEntries: RecordingNetworkEntry[],
    omittedCount: number,
  ): RecordingNetworkSummary => {
    const totalOmitted = Math.min(MAX_COUNT, previousOmitted + omittedCount);
    return {
      entries: validEntries,
      ...(partial || omittedCount ? { partial: true } : {}),
      ...(totalOmitted ? { omittedCount: totalOmitted } : {}),
    };
  };
  const complete = summaryWith(
    candidates.map(candidate => candidate.entry),
    0,
  );
  if (stringify(complete).length <= available) return { summary: complete, omittedCount: 0 };
  candidates.sort((a, b) => entryPriority(a.entry) - entryPriority(b.entry) || a.index - b.index);

  const selected: typeof candidates = [];
  let entriesLength = 0;
  for (const candidate of candidates) {
    const addition = stringify(candidate.entry).length + (selected.length ? 1 : 0);
    const overhead = stringify(summaryWith([], candidates.length - selected.length - 1)).length;
    if (overhead + entriesLength + addition > available) continue;
    selected.push(candidate);
    entriesLength += addition;
  }
  const omittedCount = candidates.length - selected.length;
  if (!selected.length) return { omittedCount };
  selected.sort((a, b) => a.index - b.index);
  return {
    summary: summaryWith(
      selected.map(candidate => candidate.entry),
      omittedCount,
    ),
    omittedCount,
  };
}
