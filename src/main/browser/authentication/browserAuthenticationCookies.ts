type BrowserCookieSameSite = 'Strict' | 'Lax' | 'None';
type BrowserCookiePriority = 'Low' | 'Medium' | 'High';
type BrowserCookieSourceScheme = 'Unset' | 'NonSecure' | 'Secure';
type BrowserCookiePartitionKey = { topLevelSite: string; hasCrossSiteAncestor: boolean };

export type BrowserAuthenticationCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: BrowserCookieSameSite;
  priority: BrowserCookiePriority;
  sourceScheme: BrowserCookieSourceScheme;
  sourcePort: number;
  expires?: number;
  partitionKey?: BrowserCookiePartitionKey;
};

const MAX_COOKIES = 256;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function isWithinCookieDomain(hostname: string, domain: string): boolean {
  return domain.startsWith('.')
    ? hostname === domain.slice(1) || hostname.endsWith(domain)
    : hostname === domain;
}

function isCookiePartitionForOrigin(
  value: unknown,
  origin: URL,
): value is BrowserCookiePartitionKey {
  if (
    !isRecord(value) ||
    typeof value.topLevelSite !== 'string' ||
    typeof value.hasCrossSiteAncestor !== 'boolean'
  )
    return false;
  try {
    const site = new URL(value.topLevelSite);
    return (
      site.origin === value.topLevelSite &&
      site.protocol === origin.protocol &&
      !site.port &&
      isWithinCookieDomain(origin.hostname, `.${site.hostname}`)
    );
  } catch {
    return false;
  }
}

function parseCookie(value: unknown, origin: URL): BrowserAuthenticationCookie | null {
  if (!isRecord(value)) return null;
  const {
    name,
    value: contents,
    domain,
    path,
    secure,
    httpOnly,
    sameSite,
    priority,
    sourceScheme,
    sourcePort,
    expires,
    partitionKey,
  } = value;
  const hasSameSite = sameSite === 'Strict' || sameSite === 'Lax' || sameSite === 'None';
  const hasExpiry = typeof expires === 'number' && Number.isFinite(expires) && expires > 0;
  const hasPartition = isCookiePartitionForOrigin(partitionKey, origin);
  if (
    typeof name !== 'string' ||
    name.length > 4096 ||
    typeof contents !== 'string' ||
    contents.length > 4096 ||
    typeof domain !== 'string' ||
    !/^\.?[a-z0-9.-]+$/u.test(domain) ||
    !isWithinCookieDomain(origin.hostname, domain) ||
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.length > 4096 ||
    typeof secure !== 'boolean' ||
    typeof httpOnly !== 'boolean' ||
    (sameSite !== undefined && !hasSameSite) ||
    (priority !== 'Low' && priority !== 'Medium' && priority !== 'High') ||
    (sourceScheme !== 'Unset' && sourceScheme !== 'NonSecure' && sourceScheme !== 'Secure') ||
    typeof sourcePort !== 'number' ||
    !Number.isInteger(sourcePort) ||
    (sourcePort !== -1 && (sourcePort < 1 || sourcePort > 65_535)) ||
    (expires !== undefined && !hasExpiry) ||
    (partitionKey !== undefined && !hasPartition)
  )
    return null;
  return {
    name,
    value: contents,
    domain,
    path,
    secure,
    httpOnly,
    priority,
    sourceScheme,
    sourcePort,
    ...(hasSameSite ? { sameSite } : {}),
    ...(hasExpiry ? { expires } : {}),
    ...(hasPartition
      ? {
          partitionKey: {
            topLevelSite: partitionKey.topLevelSite,
            hasCrossSiteAncestor: partitionKey.hasCrossSiteAncestor,
          },
        }
      : {}),
  };
}

/** Keep only cookies Chromium exposed for the business landing and entry URLs. */
export function readBrowserAuthenticationCookies(
  value: unknown,
  entry: URL,
): BrowserAuthenticationCookie[] {
  if (!Array.isArray(value) || value.length > MAX_COOKIES) return [];
  return value.flatMap(raw => {
    if (!isRecord(raw) || raw.partitionKeyOpaque || typeof raw.session !== 'boolean') return [];
    const cookie = parseCookie({ ...raw, expires: raw.session ? undefined : raw.expires }, entry);
    return cookie ? [cookie] : [];
  });
}

type BrowserAuthenticationCookieIdentity = Pick<
  BrowserAuthenticationCookie,
  'name' | 'domain' | 'path' | 'partitionKey'
>;

export function browserAuthenticationCookieKey(
  cookie: BrowserAuthenticationCookieIdentity,
): string {
  return JSON.stringify([
    cookie.name,
    cookie.domain,
    cookie.path,
    cookie.partitionKey?.topLevelSite,
    cookie.partitionKey?.hasCrossSiteAncestor,
  ]);
}

export function readExistingBrowserAuthenticationCookies(
  value: unknown,
  entry: URL,
  keys: ReadonlySet<string>,
): Map<string, BrowserAuthenticationCookie> {
  if (!Array.isArray(value)) throw new Error('Browser authentication cookies could not be read.');
  const matching = value.filter(cookie => {
    if (
      !isRecord(cookie) ||
      typeof cookie.name !== 'string' ||
      typeof cookie.domain !== 'string' ||
      typeof cookie.path !== 'string' ||
      cookie.partitionKeyOpaque
    )
      return false;
    const partitionKey = isCookiePartitionForOrigin(cookie.partitionKey, entry)
      ? cookie.partitionKey
      : undefined;
    if (cookie.partitionKey !== undefined && !partitionKey) return false;
    return keys.has(
      browserAuthenticationCookieKey({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
        partitionKey,
      }),
    );
  });
  const cookies = readBrowserAuthenticationCookies(matching, entry);
  const unique = new Map(cookies.map(cookie => [browserAuthenticationCookieKey(cookie), cookie]));
  if (unique.size !== matching.length)
    throw new Error('Browser authentication cookies could not be read.');
  return unique;
}

/** Apply the same scope check again at the receiving process boundary. */
export function validateBrowserAuthenticationCookies(
  value: unknown,
  entry: URL,
): BrowserAuthenticationCookie[] {
  if (!Array.isArray(value) || value.length > MAX_COOKIES)
    throw new Error('Invalid browser authentication cookies.');
  const cookies = value.map(cookie => parseCookie(cookie, entry));
  if (!cookies.length || cookies.some(cookie => !cookie))
    throw new Error('Invalid browser authentication cookies.');
  return cookies as BrowserAuthenticationCookie[];
}

export function browserAuthenticationCookieUrls(
  entry: URL,
  cookies: readonly BrowserAuthenticationCookie[],
): string[] {
  return [
    ...new Set([
      entry.href,
      ...cookies.map(cookie => {
        const url = new URL(entry.origin);
        url.pathname = cookie.path;
        return url.href;
      }),
    ]),
  ];
}

export function matchesBrowserAuthenticationCookie(
  expected: BrowserAuthenticationCookie,
  actual: BrowserAuthenticationCookie,
): boolean {
  return (
    expected.name === actual.name &&
    expected.value === actual.value &&
    expected.domain === actual.domain &&
    expected.path === actual.path &&
    expected.secure === actual.secure &&
    expected.httpOnly === actual.httpOnly &&
    expected.sameSite === actual.sameSite &&
    expected.priority === actual.priority &&
    expected.sourceScheme === actual.sourceScheme &&
    expected.sourcePort === actual.sourcePort &&
    (expected.expires === actual.expires ||
      (expected.expires !== undefined &&
        actual.expires !== undefined &&
        Math.abs(expected.expires - actual.expires) <= 1)) &&
    expected.partitionKey?.topLevelSite === actual.partitionKey?.topLevelSite &&
    expected.partitionKey?.hasCrossSiteAncestor === actual.partitionKey?.hasCrossSiteAncestor
  );
}
