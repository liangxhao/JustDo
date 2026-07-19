import { app, session } from 'electron';

const PROXY_ENV_KEYS = [
  'http_proxy',
  'https_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'no_proxy',
  'NO_PROXY',
] as const;

type ProxyEnvKey = (typeof PROXY_ENV_KEYS)[number];
type ProxyEnvSnapshot = Record<ProxyEnvKey, string | undefined>;

const originalProxyEnv: ProxyEnvSnapshot = PROXY_ENV_KEYS.reduce((acc, key) => {
  acc[key] = process.env[key];
  return acc;
}, {} as ProxyEnvSnapshot);

let systemProxyEnabled = false;
let fixedProxyUrl: string | null = null;
let activeProcessProxyUrl: string | null = null;
let processProxyBypassEntries: readonly string[] = [];
let processProxyForcedBaseUrls: readonly string[] = [];

const LOOPBACK_PROXY_BYPASSES = ['localhost', '127.0.0.1', '::1'] as const;
const OUTBOUND_PROXY_OVERRIDDEN_BYPASSES = new Set(['*', ...LOOPBACK_PROXY_BYPASSES]);
const outboundProxyBypassBaselines = new WeakMap<NodeJS.ProcessEnv, readonly string[]>();

function setEnvValue(key: ProxyEnvKey, value: string | undefined): void {
  if (typeof value === 'string' && value.length > 0) {
    process.env[key] = value;
    return;
  }
  delete process.env[key];
}

function parseProxyRule(rule: string): string | null {
  const normalizedRule = rule.trim();
  if (!normalizedRule || normalizedRule.toUpperCase() === 'DIRECT') {
    return null;
  }

  // Match standard PAC format: TYPE host:port
  // Strictly match host:port to avoid greedy capture of trailing content like ";SOCKS5 ..."
  const match = normalizedRule.match(/^(PROXY|HTTPS?|SOCKS5?|SOCKS4?)\s+([\w.\-]+:\d+)$/i);
  if (!match) {
    // Also try matching URL format: http://host:port (some proxy tools return URLs directly)
    const urlMatch = normalizedRule.match(/^(https?|socks5?|socks4?):\/\/([\w.\-]+:\d+)\/?$/i);
    if (urlMatch) {
      return `${urlMatch[1].toLowerCase()}://${urlMatch[2]}`;
    }
    return null;
  }

  const type = match[1].toUpperCase();
  const hostPort = match[2];

  if (type === 'HTTPS') {
    return `https://${hostPort}`;
  }
  if (type.startsWith('SOCKS4')) {
    return `socks4://${hostPort}`;
  }
  if (type.startsWith('SOCKS')) {
    return `socks5://${hostPort}`;
  }
  return `http://${hostPort}`;
}

function mergeNoProxyEntries(env: NodeJS.ProcessEnv, extraEntries: readonly string[]): void {
  const existingEntries = (env.NO_PROXY || env.no_proxy || '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
  const bypassEntries = Array.from(new Set([...existingEntries, ...extraEntries])).join(',');

  env.no_proxy = bypassEntries;
  env.NO_PROXY = bypassEntries;
}

export function addLoopbackProxyBypass(env: NodeJS.ProcessEnv): void {
  mergeNoProxyEntries(env, LOOPBACK_PROXY_BYPASSES);
}

const normalizeProxyHostname = (hostname: string): string =>
  hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');

export const isLoopbackBaseUrl = (baseUrl: string): boolean => {
  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return false;

    const hostname = normalizeProxyHostname(url.hostname);
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '::1') {
      return true;
    }

    const ipv4 = hostname.split('.');
    return ipv4.length === 4 && ipv4.every(part => /^\d{1,3}$/.test(part)) && ipv4[0] === '127';
  } catch {
    return false;
  }
};

type ForcedProxyTarget = {
  hostname: string;
  port: string;
};

const getForcedProxyTargets = (baseUrls: readonly string[]): ForcedProxyTarget[] =>
  baseUrls.flatMap(baseUrl => {
    try {
      const url = new URL(baseUrl);
      if (!['http:', 'https:'].includes(url.protocol)) {
        return [];
      }
      return [
        {
          hostname: normalizeProxyHostname(url.hostname),
          port: url.port || (url.protocol === 'https:' ? '443' : '80'),
        },
      ];
    } catch {
      return [];
    }
  });

const parseIpv4Address = (hostname: string): number | null => {
  const parts = hostname.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null;
    value = (value << 8) | octet;
  }
  return value >>> 0;
};

const matchesIpv4NoProxyPattern = (targetHost: string, entryHost: string): boolean => {
  const target = parseIpv4Address(targetHost);
  if (target === null) return false;

  const cidrMatch = entryHost.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (cidrMatch) {
    const network = parseIpv4Address(cidrMatch[1]);
    const prefixLength = Number(cidrMatch[2]);
    if (network === null || prefixLength < 0 || prefixLength > 32) return false;
    const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
    return (target & mask) === (network & mask);
  }

  if (!entryHost.includes('*')) return false;
  const targetParts = targetHost.split('.');
  const patternParts = entryHost.split('.');
  if (patternParts.length === 0 || patternParts.length > 4) return false;
  return patternParts.every((part, index) => part === '*' || part === targetParts[index]);
};

const parseNoProxyEntry = (entry: string): { hostname: string; port?: string } | null => {
  const normalizedEntry = entry.trim().toLowerCase();
  if (!normalizedEntry) return null;
  if (normalizedEntry === '*') return { hostname: '*' };
  if (normalizedEntry.startsWith('[')) {
    const match = normalizedEntry.match(/^\[([^\]]+)\](?::(\d+))?$/);
    return match ? { hostname: match[1], ...(match[2] ? { port: match[2] } : {}) } : null;
  }

  const firstColonIndex = normalizedEntry.indexOf(':');
  const lastColonIndex = normalizedEntry.lastIndexOf(':');
  if (
    firstColonIndex > -1 &&
    firstColonIndex === lastColonIndex &&
    /^\d+$/.test(normalizedEntry.slice(lastColonIndex + 1))
  ) {
    return {
      hostname: normalizedEntry.slice(0, lastColonIndex),
      port: normalizedEntry.slice(lastColonIndex + 1),
    };
  }
  return { hostname: normalizedEntry };
};

const doesNoProxyEntryMatchTarget = (entry: string, target: ForcedProxyTarget): boolean => {
  const parsedEntry = parseNoProxyEntry(entry);
  if (!parsedEntry) return false;
  if (parsedEntry.hostname === '*') return true;
  if (parsedEntry.port && parsedEntry.port !== target.port) return false;

  const normalizedEntryHost = normalizeProxyHostname(parsedEntry.hostname)
    .replace(/^\*\./, '')
    .replace(/^\./, '');
  if (!normalizedEntryHost) return false;
  if (matchesIpv4NoProxyPattern(target.hostname, normalizedEntryHost)) return true;
  return (
    target.hostname === normalizedEntryHost || target.hostname.endsWith(`.${normalizedEntryHost}`)
  );
};

export const configureForcedProxyRouting = (
  env: NodeJS.ProcessEnv,
  explicitBypassEntries: readonly string[],
  forcedBaseUrls: readonly string[],
): void => {
  addLoopbackProxyBypass(env);
  const forcedTargets = getForcedProxyTargets(forcedBaseUrls);
  const existingEntries = [env.NO_PROXY, env.no_proxy]
    .flatMap(value => (value || '').split(','))
    .map(entry => entry.trim())
    .filter(
      entry => entry && !forcedTargets.some(target => doesNoProxyEntryMatchTarget(entry, target)),
    );
  const bypassEntries = Array.from(new Set([...existingEntries, ...explicitBypassEntries])).join(
    ',',
  );
  env.no_proxy = bypassEntries;
  env.NO_PROXY = bypassEntries;
};

export function configureOutboundProxyBypass(
  env: NodeJS.ProcessEnv,
  explicitEntries: readonly string[],
): void {
  let baselineEntries = outboundProxyBypassBaselines.get(env);
  if (!baselineEntries) {
    baselineEntries = [env.NO_PROXY, env.no_proxy]
      .flatMap(value => (value || '').split(','))
      .map(entry => entry.trim())
      .filter(entry => entry && !OUTBOUND_PROXY_OVERRIDDEN_BYPASSES.has(entry.toLowerCase()));
    outboundProxyBypassBaselines.set(env, baselineEntries);
  }
  const bypassEntries = Array.from(new Set([...baselineEntries, ...explicitEntries])).join(',');

  env.no_proxy = bypassEntries;
  env.NO_PROXY = bypassEntries;
}

export function isSystemProxyEnabled(): boolean {
  return systemProxyEnabled;
}

export function setSystemProxyEnabled(enabled: boolean): void {
  systemProxyEnabled = enabled;
}

export function getFixedProxyUrl(): string | null {
  return fixedProxyUrl;
}

export function setFixedProxyUrl(proxyUrl: string | null): void {
  fixedProxyUrl = proxyUrl;
}

export function setProcessProxyRouting(options: {
  bypassEntries: readonly string[];
  forcedBaseUrls: readonly string[];
}): void {
  processProxyBypassEntries = Array.from(
    new Set(options.bypassEntries.map(entry => entry.trim()).filter(Boolean)),
  );
  processProxyForcedBaseUrls = Array.from(
    new Set(options.forcedBaseUrls.map(baseUrl => baseUrl.trim()).filter(Boolean)),
  );
  if (activeProcessProxyUrl) {
    applySystemProxyEnv(activeProcessProxyUrl);
  }
}

export function restoreOriginalProxyEnv(): void {
  activeProcessProxyUrl = null;
  PROXY_ENV_KEYS.forEach(key => {
    setEnvValue(key, originalProxyEnv[key]);
  });
}

export function applySystemProxyEnv(proxyUrl: string | null): void {
  // Always start from original env so toggling is reversible and predictable.
  restoreOriginalProxyEnv();
  activeProcessProxyUrl = proxyUrl;
  if (!proxyUrl) {
    return;
  }

  setEnvValue('http_proxy', proxyUrl);
  setEnvValue('https_proxy', proxyUrl);
  setEnvValue('HTTP_PROXY', proxyUrl);
  setEnvValue('HTTPS_PROXY', proxyUrl);
  // System and custom proxy modes share the same process routing. They differ
  // only in how proxyUrl is resolved by applySystemProxyPreference().
  configureForcedProxyRouting(process.env, processProxyBypassEntries, processProxyForcedBaseUrls);
}

export async function resolveSystemProxyUrl(targetUrl: string): Promise<string | null> {
  if (!app.isReady()) {
    return null;
  }

  try {
    const proxyResult = await session.defaultSession.resolveProxy(targetUrl);
    if (!proxyResult) {
      return null;
    }

    const rules = proxyResult.split(';');
    for (const rule of rules) {
      const proxyUrl = parseProxyRule(rule);
      if (proxyUrl) {
        return proxyUrl;
      }
    }
  } catch (error) {
    console.error('Failed to resolve system proxy:', error);
  }

  return null;
}
