import { app } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { USER_DATA_DIRECTORY_NAME } from '../../shared/productMetadata';

export type OutboundHeaderPolicyGroup = {
  /** URLs handled by this group. */
  baseUrlWhitelist: readonly string[];
  /** Header names injected when a request matches this group. */
  headerNames: readonly string[];
};

export type OutboundHeaderPolicyConfig = {
  /**
   * Whether startup should rewrite this file with the bundled defaults.
   *
   * Only `false` preserves user edits. Missing or any other value is treated
   * as `true`.
   */
  overwrite: boolean;
  /**
   * Whether outbound header injection is enabled.
   */
  enabled: boolean;
  /**
   * Each group independently maps a list of base URLs to a list of headers.
   * When multiple groups match, their header names are merged in group order.
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
   * - Local loopback addresses are not supported. Entries such as `localhost`,
   *   `127.0.0.1` (or any `127.x.x.x` address), `0.0.0.0`, `::1`, and
   *   IPv4-mapped IPv6 loopback addresses are ignored. Loopback traffic remains
   *   direct and never receives injected headers.
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
  groups: readonly OutboundHeaderPolicyGroup[];
};

export const DEFAULT_OUTBOUND_HEADER_POLICY_CONFIG: OutboundHeaderPolicyConfig = Object.freeze({
  overwrite: true,
  enabled: true,
  groups: Object.freeze([
    Object.freeze({
      baseUrlWhitelist: Object.freeze([]),
      headerNames: Object.freeze(['X-User-Account', 'X-Cookie']),
    }),
  ]),
});

const USER_INFO_RELATIVE_PATH = path.join(USER_DATA_DIRECTORY_NAME, 'huawei', 'user_info.json');
const POLICY_CONFIG_RELATIVE_PATH = path.join(
  USER_DATA_DIRECTORY_NAME,
  'outbound-header-proxy',
  'config.json',
);
const POLICY_CONFIG_README_FILE_NAME = 'config.README.md';
const EMPTY_HEADER_VALUE = '';
const UNSAFE_HEADER_VALUE_PATTERN = /[\u0000-\u001f\u007f]/;
const POLICY_CONFIG_README_CONTENT = `# config.json

This file controls outbound header injection.

- \`enabled\`: Enables or disables outbound header injection.
- \`overwrite\`: Rewrites this file with defaults on startup unless set to \`false\`.
- \`groups\`: Independent URL/Header mappings. Each group has a
  \`baseUrlWhitelist\` list and a \`headerNames\` list.

## headerNames requirements

- Use a valid HTTP field name. Examples and recommended custom names start with
  \`X-\`, such as \`X-User-Account\` and \`X-Cookie\`, but this prefix is not
  required.
- A name in a group's \`headerNames\` must exactly match the corresponding property in
  \`user_info.json\`.
- If a request matches multiple groups, the groups' header lists are merged.
  Header names are deduplicated case-insensitively; the first spelling wins.

## baseUrlWhitelist matching

- Each entry must be an absolute URL beginning with \`http://\` or \`https://\`.
- Protocols, hostnames, and ports must match exactly.
- Paths are matched by prefix.
- Query strings and fragments are ignored.
- Invalid entries are ignored.
- Local loopback URLs are not supported and are ignored. This includes
  \`localhost\`, subdomains of \`localhost\`, any \`127.x.x.x\` address,
  \`0.0.0.0\`, \`::1\`, and IPv4-mapped IPv6 loopback addresses. Loopback
  requests remain direct and never receive injected headers.
- An empty list matches no requests.
- A trailing slash is recommended for directory paths. For example,
  \`https://api.example.com/v1/\` matches \`/v1/models\` without also matching
  \`/v10/models\`.

Example:

\`\`\`json
{
  "overwrite": false,
  "enabled": true,
  "groups": [
    {
      "baseUrlWhitelist": ["https://api-one.example.com/v1/"],
      "headerNames": ["X-User-Account", "X-Cookie"]
    },
    {
      "baseUrlWhitelist": ["https://api-two.example.com/v1/"],
      "headerNames": ["X-Tenant-Id", "X-Access-Token"]
    }
  ]
}
\`\`\`
`;

let cachedOutboundHeaderValues: Readonly<Record<string, string>> | null = null;
let cachedOutboundHeaderPolicyConfig = DEFAULT_OUTBOUND_HEADER_POLICY_CONFIG;
let startupOutboundHeaderEnabled: boolean | null = null;

const normalizeHeaderValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return EMPTY_HEADER_VALUE;
  }
  if (typeof value === 'string') {
    const trimmedValue = value.trim();
    if (UNSAFE_HEADER_VALUE_PATTERN.test(trimmedValue)) {
      console.warn('[OutboundHeaderPolicy] Ignored unsafe outbound header value.');
      return EMPTY_HEADER_VALUE;
    }
    return trimmedValue;
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
    app?.getPath('appData') ?? process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
    POLICY_CONFIG_RELATIVE_PATH,
  );

const readOutboundHeaderPolicyConfig = (configPath: string): OutboundHeaderPolicyConfig => {
  const configDirectory = path.dirname(configPath);
  const readmePath = path.join(configDirectory, POLICY_CONFIG_README_FILE_NAME);
  const writeDefaultConfig = (): void => {
    fs.mkdirSync(configDirectory, { recursive: true });
    fs.writeFileSync(
      configPath,
      `${JSON.stringify(DEFAULT_OUTBOUND_HEADER_POLICY_CONFIG, null, 2)}\n`,
      'utf8',
    );
  };
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
    const config = parsed as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.warn('[OutboundHeaderPolicy] Invalid outbound header policy config; using defaults');
      writeDefaultConfig();
      return DEFAULT_OUTBOUND_HEADER_POLICY_CONFIG;
    }

    if (config.overwrite !== false) {
      writeDefaultConfig();
      return DEFAULT_OUTBOUND_HEADER_POLICY_CONFIG;
    }

    const rawGroups = Array.isArray(config.groups) ? config.groups : null;
    if (typeof config.enabled === 'boolean' && rawGroups) {
      const groups = rawGroups
        .filter(
          (value): value is Record<string, unknown> =>
            !!value && typeof value === 'object' && !Array.isArray(value),
        )
        .filter(group => Array.isArray(group.baseUrlWhitelist) && Array.isArray(group.headerNames))
        .map(group =>
          Object.freeze({
            baseUrlWhitelist: Object.freeze(
              (group.baseUrlWhitelist as unknown[]).filter(
                (value): value is string => typeof value === 'string',
              ),
            ),
            headerNames: Object.freeze(
              (group.headerNames as unknown[]).filter(
                (value): value is string => typeof value === 'string',
              ),
            ),
          }),
        );
      if (groups.length !== rawGroups.length) {
        console.warn(
          '[OutboundHeaderPolicy] Invalid outbound header policy config; using defaults',
        );
        return DEFAULT_OUTBOUND_HEADER_POLICY_CONFIG;
      }
      return Object.freeze({
        overwrite: false,
        enabled: config.enabled as boolean,
        groups: Object.freeze(groups),
      });
    }
    console.warn('[OutboundHeaderPolicy] Invalid outbound header policy config; using defaults');
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === 'ENOENT') {
      writeDefaultConfig();
    } else {
      console.warn('[OutboundHeaderPolicy] Failed to read policy config:', error);
      writeDefaultConfig();
    }
  }
  return DEFAULT_OUTBOUND_HEADER_POLICY_CONFIG;
};

export const captureOutboundHeaderStartupEnabled = (): void => {
  startupOutboundHeaderEnabled ??= cachedOutboundHeaderPolicyConfig.enabled;
};

export const getOutboundHeaderPolicyConfig = (): OutboundHeaderPolicyConfig => {
  if (
    startupOutboundHeaderEnabled === null ||
    startupOutboundHeaderEnabled === cachedOutboundHeaderPolicyConfig.enabled
  ) {
    return cachedOutboundHeaderPolicyConfig;
  }
  return Object.freeze({
    ...cachedOutboundHeaderPolicyConfig,
    enabled: startupOutboundHeaderEnabled,
  });
};

/**
 * Reloads the outbound header policy and user header values from disk.
 *
 * Call without arguments to refresh both default files:
 * - `%APPDATA%/<productName>/outbound-header-proxy/config.json`
 * - `%APPDATA%/<productName>/huawei/user_info.json`
 *
 * Subsequent requests handled by the running outbound header proxy use the
 * refreshed whitelist, header names, and values. The enabled state is captured
 * during application startup and does not change during a runtime refresh. The
 * optional parameters are intended for tests or callers that need to override
 * the default paths or header names.
 *
 * @returns The refreshed header values keyed by configured header name.
 */
export const updateOutboundHeaderUserInfoCache = (
  userInfoPath = resolveOutboundHeaderUserInfoPath(),
  headerNames?: readonly string[],
  configPath = resolveOutboundHeaderPolicyConfigPath(),
): Readonly<Record<string, string>> => {
  cachedOutboundHeaderPolicyConfig = readOutboundHeaderPolicyConfig(configPath);
  const effectiveHeaderNames =
    headerNames ??
    Array.from(
      new Set(cachedOutboundHeaderPolicyConfig.groups.flatMap(group => group.headerNames)),
    );
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
  console.log(
    `[OutboundHeaderPolicy] Cache updated: baseUrlWhitelistCount=${cachedOutboundHeaderPolicyConfig.groups.reduce((count, group) => count + group.baseUrlWhitelist.length, 0)} headerCount=${Object.keys(cachedOutboundHeaderValues).length}`,
  );
  return cachedOutboundHeaderValues;
};

export const getOutboundHeaderUserInfo = (
  userInfoPath?: string,
  headerNames?: readonly string[],
): Readonly<Record<string, string>> => {
  return (
    cachedOutboundHeaderValues ??
    updateOutboundHeaderUserInfoCache(
      userInfoPath ?? resolveOutboundHeaderUserInfoPath(),
      headerNames,
    )
  );
};
