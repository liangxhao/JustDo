import { app } from 'electron';
import fs from 'fs';
import path from 'path';

export const OUTBOUND_HEADER_POLICY_CONFIG = {
  /**
   * Only requests matching one of these base URLs receive the configured headers.
   *
   * Matching rules:
   * - Every entry must be an absolute URL and must include `http://` or `https://`.
   * - HTTP and HTTPS are different. `http://api.example.com/` does not match
   *   `https://api.example.com/`; add both entries when both protocols are needed.
   * - Hostnames must match exactly. `https://example.com/` does not match
   *   `https://api.example.com/` or any other subdomain.
   * - Ports must match exactly. An omitted port means the protocol default
   *   (80 for HTTP, 443 for HTTPS). `http://127.0.0.1:4000/` only matches port 4000.
   * - Paths are matched by prefix after protocol, hostname, and port match.
   *   `https://api.example.com/v1/` matches `/v1/models` and `/v1/chat/completions`,
   *   but does not match `/v2/models`.
   * - Prefer a trailing slash for directory-style path prefixes. For example,
   *   use `/v1/` instead of `/v1` so it cannot accidentally match `/v10/...`.
   * - Query strings and URL fragments are not part of the whitelist prefix check.
   * - Invalid entries, relative paths, and non-HTTP protocols are ignored.
   * - An empty list disables header injection for every URL.
   *
   * Examples:
   * - `http://127.0.0.1:4000/` matches every path on the local port 4000 server.
   * - `https://api.example.com/` matches every HTTPS endpoint on that exact host.
   * - `https://api.example.com/v1/` restricts injection to the `/v1/` API.
   * - To allow both protocols, add:
   *   `http://api.example.com/` and `https://api.example.com/`.
   * - To allow two subdomains, add each explicitly:
   *   `https://api.example.com/` and `https://files.example.com/`.
   */
  baseUrlWhitelist: [],
  headerNames: ['user_id', 'user_cookie'],
} as const satisfies {
  baseUrlWhitelist: readonly string[];
  headerNames: readonly string[];
};

const USER_INFO_RELATIVE_PATH = path.join('JustDo', 'huawei', 'user_info.json');
const EMPTY_HEADER_VALUE = '';

let cachedOutboundHeaderValues: Readonly<Record<string, string>> | null = null;

const normalizeHeaderValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return EMPTY_HEADER_VALUE;
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return EMPTY_HEADER_VALUE;
};

export const resolveOutboundHeaderUserInfoPath = (): string =>
  path.join(app.getPath('appData'), USER_INFO_RELATIVE_PATH);

export const updateOutboundHeaderUserInfoCache = (
  userInfoPath = resolveOutboundHeaderUserInfoPath(),
  headerNames: readonly string[] = OUTBOUND_HEADER_POLICY_CONFIG.headerNames,
): Readonly<Record<string, string>> => {
  let userInfo: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(userInfoPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      userInfo = parsed as Record<string, unknown>;
    }
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode !== 'ENOENT') {
      console.warn('[OutboundHeaderPolicy] Failed to read user_info.json:', error);
    }
  }

  cachedOutboundHeaderValues = Object.freeze(
    Object.fromEntries(
      headerNames.map(headerName => [headerName, normalizeHeaderValue(userInfo[headerName])]),
    ),
  );
  return cachedOutboundHeaderValues;
};

export const getOutboundHeaderUserInfo = (
  userInfoPath = resolveOutboundHeaderUserInfoPath(),
  headerNames: readonly string[] = OUTBOUND_HEADER_POLICY_CONFIG.headerNames,
): Readonly<Record<string, string>> => {
  return cachedOutboundHeaderValues
    ?? updateOutboundHeaderUserInfoCache(userInfoPath, headerNames);
};
