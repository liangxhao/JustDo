import { app } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

export type OutboundHeaderPolicyConfig = {
  /**
   * Whether outbound header injection is enabled.
   */
  enabled: boolean;
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
  baseUrlWhitelist: readonly string[];
  /**
   * Header names whose values are read from user_info.json and injected into
   * matching outbound requests.
   */
  headerNames: readonly string[];
};

export const DEFAULT_OUTBOUND_HEADER_POLICY_CONFIG: OutboundHeaderPolicyConfig = Object.freeze({
  enabled: true,
  baseUrlWhitelist: [],
  headerNames: ['User-Account', 'Cookie'],
});

const USER_INFO_RELATIVE_PATH = path.join('JustDo', 'huawei', 'user_info.json');
const POLICY_CONFIG_RELATIVE_PATH = path.join(
  'JustDo',
  'outbound-header-proxy',
  'config.json',
);
const POLICY_CONFIG_README_FILE_NAME = 'config.README.md';
const EMPTY_HEADER_VALUE = '';
const POLICY_CONFIG_README_CONTENT = `# config.json

This file controls outbound header injection.

- \`enabled\`: Enables or disables outbound header injection.
- \`headerNames\`: Header names to read from \`user_info.json\` and inject.
- \`baseUrlWhitelist\`: Only matching request URLs receive the configured headers.

## baseUrlWhitelist matching

- Each entry must be an absolute URL beginning with \`http://\` or \`https://\`.
- Protocols, hostnames, and ports must match exactly.
- Paths are matched by prefix.
- Query strings and fragments are ignored.
- Invalid entries are ignored.
- An empty list matches no requests.
- A trailing slash is recommended for directory paths. For example,
  \`https://api.example.com/v1/\` matches \`/v1/models\` without also matching
  \`/v10/models\`.

Example:

\`\`\`json
{
  "enabled": true,
  "baseUrlWhitelist": ["https://api.example.com/v1/"],
  "headerNames": ["User-Account", "Cookie"]
}
\`\`\`
`;

let cachedOutboundHeaderValues: Readonly<Record<string, string>> | null = null;
let cachedOutboundHeaderPolicyConfig = DEFAULT_OUTBOUND_HEADER_POLICY_CONFIG;

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

export const resolveOutboundHeaderPolicyConfigPath = (): string =>
  path.join(
    app?.getPath('appData')
      ?? process.env.APPDATA
      ?? path.join(os.homedir(), 'AppData', 'Roaming'),
    POLICY_CONFIG_RELATIVE_PATH,
  );

const readOutboundHeaderPolicyConfig = (
  configPath: string,
): OutboundHeaderPolicyConfig => {
  const configDirectory = path.dirname(configPath);
  const readmePath = path.join(configDirectory, POLICY_CONFIG_README_FILE_NAME);
  try {
    fs.mkdirSync(configDirectory, { recursive: true });
    if (!fs.existsSync(readmePath)) {
      fs.writeFileSync(readmePath, POLICY_CONFIG_README_CONTENT, 'utf8');
    }
  } catch (error) {
    console.warn('[OutboundHeaderPolicy] Failed to create config README:', error);
  }

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (
      parsed
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && typeof (parsed as Record<string, unknown>).enabled === 'boolean'
      && Array.isArray((parsed as Record<string, unknown>).baseUrlWhitelist)
      && Array.isArray((parsed as Record<string, unknown>).headerNames)
    ) {
      const config = parsed as Record<string, unknown>;
      return Object.freeze({
        enabled: config.enabled as boolean,
        baseUrlWhitelist: Object.freeze(
          (config.baseUrlWhitelist as unknown[]).filter(
            (value): value is string => typeof value === 'string',
          ),
        ),
        headerNames: Object.freeze(
          (config.headerNames as unknown[]).filter(
            (value): value is string => typeof value === 'string',
          ),
        ),
      });
    }
    console.warn('[OutboundHeaderPolicy] Invalid outbound header policy config; using defaults');
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === 'ENOENT') {
      fs.mkdirSync(configDirectory, { recursive: true });
      fs.writeFileSync(
        configPath,
        `${JSON.stringify(DEFAULT_OUTBOUND_HEADER_POLICY_CONFIG, null, 2)}\n`,
        'utf8',
      );
    } else {
      console.warn('[OutboundHeaderPolicy] Failed to read policy config:', error);
    }
  }
  return DEFAULT_OUTBOUND_HEADER_POLICY_CONFIG;
};

export const getOutboundHeaderPolicyConfig = (): OutboundHeaderPolicyConfig =>
  cachedOutboundHeaderPolicyConfig;

/**
 * Reloads the outbound header policy and user header values from disk.
 *
 * Call without arguments to refresh both default files:
 * - `%APPDATA%/JustDo/outbound-header-proxy/config.json`
 * - `%APPDATA%/JustDo/huawei/user_info.json`
 *
 * Subsequent requests handled by the running outbound header proxy use the
 * refreshed policy and values. The optional parameters are intended for tests
 * or callers that need to override the default paths or header names.
 *
 * @returns The refreshed header values keyed by configured header name.
 */
export const updateOutboundHeaderUserInfoCache = (
  userInfoPath = resolveOutboundHeaderUserInfoPath(),
  headerNames?: readonly string[],
  configPath = resolveOutboundHeaderPolicyConfigPath(),
): Readonly<Record<string, string>> => {
  cachedOutboundHeaderPolicyConfig = readOutboundHeaderPolicyConfig(configPath);
  const effectiveHeaderNames = headerNames ?? cachedOutboundHeaderPolicyConfig.headerNames;
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
      effectiveHeaderNames.map(headerName => [
        headerName,
        normalizeHeaderValue(userInfo[headerName]),
      ]),
    ),
  );
  return cachedOutboundHeaderValues;
};

export const getOutboundHeaderUserInfo = (
  userInfoPath = resolveOutboundHeaderUserInfoPath(),
  headerNames?: readonly string[],
): Readonly<Record<string, string>> => {
  return cachedOutboundHeaderValues
    ?? updateOutboundHeaderUserInfoCache(userInfoPath, headerNames);
};
