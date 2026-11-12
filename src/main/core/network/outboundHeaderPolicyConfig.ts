import { app } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { LOGIN_STORAGE_CONFIG } from '../../../config/loginStorage';
import {
  DEFAULT_OUTBOUND_HEADER_POLICY_CONFIG,
  type OutboundHeaderPolicyConfig,
  type OutboundHeaderPolicyGroup,
  PREDEFINED_OUTBOUND_HEADER_POLICY_CONFIG,
} from '../../../config/outboundHeaders';
import { type OutboundHeaderEntry, parseOutboundHeaderObject } from '../../../shared/plugins/outboundHeaderPolicy';
import { USER_DATA_DIRECTORY_NAME } from '../../../shared/productMetadata';

export type {
  OutboundHeaderPolicyConfig,
  OutboundHeaderPolicyGroup,
} from '../../../config/outboundHeaders';

const USER_INFO_RELATIVE_PATH = path.join(
  USER_DATA_DIRECTORY_NAME,
  LOGIN_STORAGE_CONFIG.directoryName,
  LOGIN_STORAGE_CONFIG.userInfoFileName,
);
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
- \`groups\`: Independent URL/Header mappings. Each group has a
  \`baseUrlWhitelist\` list and a \`headerNames\` list.
- Built-in groups are always loaded from the application code when enabled;
  this file only adds manual groups. A missing file is created with empty groups.

## headerNames requirements

- Use a valid HTTP field name. Examples and recommended custom names start with
  \`X-\`, such as \`X-User-Account\` and \`X-Cookie\`, but this prefix is not
  required.
- A string in \`headerNames\` uses the same name for the outgoing Header and the property in
  \`${LOGIN_STORAGE_CONFIG.userInfoFileName}\`.
- An object such as \`{"name":"X-Account","from":"account_id"}\` reads that exact property
  and injects it under the specified name. \`{"name":"X-Client","value":"desktop"}\`
  uses the configured string directly.
- Header names are compared without regard to case. The first matching string is
  used for legacy declarations. A matching object takes precedence over strings;
  the last matching object wins. Keep secrets in the user info file.

## baseUrlWhitelist matching

- Each entry must be an absolute URL beginning with \`http://\` or \`https://\`.
- Protocols, hostnames, and ports must match exactly.
- Paths are matched on segment boundaries. A trailing slash is optional, so
  \`/v1\` and \`/v1/\` are equivalent and neither matches \`/v10\`.
- Query strings and fragments are ignored.
- Invalid entries are ignored.
- Local loopback URLs are not supported and are ignored. This includes
  \`localhost\`, subdomains of \`localhost\`, any \`127.x.x.x\` address,
  \`0.0.0.0\`, \`::1\`, and IPv4-mapped IPv6 loopback addresses. Loopback
  requests remain direct and never receive injected headers.
- An empty list matches no requests.

Example:

\`\`\`json
{
  "enabled": true,
  "groups": [
    {
      "baseUrlWhitelist": ["https://api-one.example.com/v1/"],
      "headerNames": ["X-User-Account", "X-Cookie"]
    },
    {
      "baseUrlWhitelist": ["https://api-two.example.com/v1/"],
      "headerNames": [
        {"name": "X-Tenant-Id", "from": "tenant_id"},
        {"name": "X-Client", "value": "desktop"}
      ]
    }
  ]
}
\`\`\`
`;

let cachedOutboundHeaderValues: Readonly<Record<string, string>> | null = null;
let cachedOutboundHeaderPolicyConfig = PREDEFINED_OUTBOUND_HEADER_POLICY_CONFIG;

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

export const collectOutboundHeaderSourceKeys = (groups: readonly OutboundHeaderPolicyGroup[]): string[] => {
  const keys = new Set<string>();
  for (const group of groups) {
    for (const entry of group.headerNames) {
      if (typeof entry === 'string') keys.add(entry);
      else if ('from' in entry) keys.add(entry.from);
    }
  }
  return [...keys];
};

export const freezeOutboundHeaderPolicyGroup = (group: OutboundHeaderPolicyGroup): OutboundHeaderPolicyGroup =>
  Object.freeze({
    baseUrlWhitelist: Object.freeze([...group.baseUrlWhitelist]),
    headerNames: Object.freeze(group.headerNames.map(entry =>
      typeof entry === 'string' ? entry : Object.freeze({ ...entry }),
    )),
  });

export const resolveOutboundHeaderUserInfoPath = (): string =>
  path.join(app.getPath('appData'), USER_INFO_RELATIVE_PATH);

export const resolveOutboundHeaderPolicyConfigPath = (): string =>
  path.join(
    app?.getPath('appData') ?? process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
    POLICY_CONFIG_RELATIVE_PATH,
  );

export const readOutboundHeaderPolicyConfig = (configPath: string): OutboundHeaderPolicyConfig => {
  const configDirectory = path.dirname(configPath);
  const readmePath = path.join(configDirectory, POLICY_CONFIG_README_FILE_NAME);
  const writeDefaultConfig = (): void => {
    fs.mkdirSync(configDirectory, { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(DEFAULT_OUTBOUND_HEADER_POLICY_CONFIG, null, 2)}\n`, 'utf8');
  };
  const replaceInvalidConfig = (): OutboundHeaderPolicyConfig => {
    console.warn('[OutboundHeaderPolicy] Invalid outbound header policy config; resetting to default');
    try {
      writeDefaultConfig();
    } catch (error) {
      console.warn('[OutboundHeaderPolicy] Failed to reset invalid policy config:', error);
    }
    return DEFAULT_OUTBOUND_HEADER_POLICY_CONFIG;
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
      return replaceInvalidConfig();
    }

    if (typeof config.enabled !== 'boolean' || !Array.isArray(config.groups)) {
      return replaceInvalidConfig();
    }
    const groups: OutboundHeaderPolicyGroup[] = [];
    for (const group of config.groups) {
      if (!group || typeof group !== 'object' || Array.isArray(group) ||
          !Array.isArray(group.baseUrlWhitelist) || !group.baseUrlWhitelist.every((value: unknown) => typeof value === 'string') ||
          !Array.isArray(group.headerNames)) return replaceInvalidConfig();

      const headerNames: OutboundHeaderEntry[] = [];
      for (const entry of group.headerNames) {
        const parsedEntry = typeof entry === 'string' ? entry : parseOutboundHeaderObject(entry);
        if (parsedEntry === null) return replaceInvalidConfig();
        headerNames.push(parsedEntry);
      }
      groups.push(freezeOutboundHeaderPolicyGroup({ baseUrlWhitelist: group.baseUrlWhitelist, headerNames }));
    }
    return Object.freeze({ enabled: config.enabled, groups: Object.freeze(groups) });
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode === 'ENOENT') {
      try {
        writeDefaultConfig();
      } catch (writeError) {
        console.warn('[OutboundHeaderPolicy] Failed to create default policy config:', writeError);
      }
      return DEFAULT_OUTBOUND_HEADER_POLICY_CONFIG;
    } else if (error instanceof SyntaxError) {
      return replaceInvalidConfig();
    } else {
      console.warn('[OutboundHeaderPolicy] Failed to read policy config:', error);
    }
  }
  return DEFAULT_OUTBOUND_HEADER_POLICY_CONFIG;
};

export const getOutboundHeaderPolicyConfig = (): OutboundHeaderPolicyConfig =>
  cachedOutboundHeaderPolicyConfig;

/**
 * Loads a manual policy file and its header values from disk. Runtime policy
 * activation normally goes through OutboundHeaderPolicyService so Extension
 * contributions are included.
 *
 * Call without arguments to read both default files:
 * - `%APPDATA%/<productName>/outbound-header-proxy/config.json`
 * - Login user info file selected by `LOGIN_STORAGE_CONFIG` under `%APPDATA%/<productName>`.
 *
 * The optional parameters are intended for tests or callers that need to
 * override the default paths or user-info keys.
 *
 * @returns The refreshed values keyed by their user-info fields.
 */
export const loadOutboundHeaderPolicyAndUserInfoCache = (
  userInfoPath = resolveOutboundHeaderUserInfoPath(),
  headerNames?: readonly string[],
  configPath = resolveOutboundHeaderPolicyConfigPath(),
): Readonly<Record<string, string>> => {
  cachedOutboundHeaderPolicyConfig = readOutboundHeaderPolicyConfig(configPath);
  const values = updateOutboundHeaderUserInfoCache(userInfoPath, headerNames);
  console.log(
    `[OutboundHeaderPolicy] Cache updated: baseUrlWhitelistCount=${cachedOutboundHeaderPolicyConfig.groups.reduce((count, group) => count + group.baseUrlWhitelist.length, 0)} headerCount=${Object.keys(values).length}`,
  );
  return values;
};

/** Refreshes only user_info.json while preserving the active manual and Extension policy.
 * Call after a login, logout, or scheduled cookie update writes user_info.json.
 */
export const updateOutboundHeaderUserInfoCache = (
  userInfoPath = resolveOutboundHeaderUserInfoPath(),
  sourceKeys: readonly string[] = collectOutboundHeaderSourceKeys(cachedOutboundHeaderPolicyConfig.groups),
): Readonly<Record<string, string>> => {
  if (sourceKeys.length === 0) return publishOutboundHeaderUserInfoCache({}, sourceKeys);
  let userInfo: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(userInfoPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      userInfo = parsed as Record<string, unknown>;
    }
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code;
    if (errorCode !== 'ENOENT') {
      console.warn(
        '[OutboundHeaderPolicy] Failed to read login user info:',
        error instanceof SyntaxError ? 'Invalid JSON' : 'File read failed',
      );
    }
  }

  return publishOutboundHeaderUserInfoCache(userInfo, sourceKeys);
};

/** Uses the login values already committed by Main, without reopening the file. */
export const publishOutboundHeaderUserInfoCache = (
  userInfo: Readonly<Record<string, unknown>>,
  sourceKeys: readonly string[] = collectOutboundHeaderSourceKeys(cachedOutboundHeaderPolicyConfig.groups),
): Readonly<Record<string, string>> => {
  cachedOutboundHeaderValues = Object.freeze(
    Object.fromEntries(
      sourceKeys.map(key => [
        key,
        Object.hasOwn(userInfo, key) ? normalizeHeaderValue(userInfo[key]) : EMPTY_HEADER_VALUE,
      ]),
    ),
  );
  return cachedOutboundHeaderValues;
};

/** Activates an already validated effective policy without materializing it to config.json. */
export const activateOutboundHeaderPolicyConfig = (
  policy: OutboundHeaderPolicyConfig,
  userInfoPath = resolveOutboundHeaderUserInfoPath(),
): Readonly<Record<string, string>> => {
  cachedOutboundHeaderPolicyConfig = Object.freeze({
    enabled: policy.enabled,
    groups: Object.freeze(policy.groups.map(freezeOutboundHeaderPolicyGroup)),
  });
  return updateOutboundHeaderUserInfoCache(userInfoPath);
};

export const getOutboundHeaderUserInfo = (
  userInfoPath?: string,
  sourceKeys?: readonly string[],
): Readonly<Record<string, string>> => {
  return (
    cachedOutboundHeaderValues ??
    updateOutboundHeaderUserInfoCache(
      userInfoPath ?? resolveOutboundHeaderUserInfoPath(),
      sourceKeys,
    )
  );
};
