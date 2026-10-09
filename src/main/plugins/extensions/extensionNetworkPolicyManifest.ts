import fs from 'fs';
import { isIP } from 'net';
import path from 'path';

import {
  EXTENSION_OUTBOUND_HEADER_MANIFEST_FILE,
  type ExtensionOutboundHeaderManifestV1,
} from '../../../shared/plugins/outboundHeaderPolicy';

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_GROUPS = 32;
const MAX_BASE_URLS = 64;
const MAX_HEADERS = 32;
const MAX_URL_LENGTH = 2_048;
const MAX_HEADER_LENGTH = 128;
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const FORBIDDEN_HEADER_NAMES = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every(key => keys.includes(key)) && keys.every(key => key in value);

const isDisallowedLocalHostname = (hostname: string): boolean => {
  const normalized = hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  const mappedIpv4 = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  const firstIpv6Group = normalized.split(':', 1)[0];
  const firstIpv6Value = Number.parseInt(firstIpv6Group, 16);
  const ipVersion = isIP(normalized);
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '::1' ||
    normalized === '::' ||
    normalized === '0.0.0.0' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized) ||
    /^169\.254(?:\.\d{1,3}){2}$/.test(normalized) ||
    /^::ffff:127(?:\.\d{1,3}){3}$/.test(normalized) ||
    /^::ffff:169\.254(?:\.\d{1,3}){2}$/.test(normalized) ||
    (!!mappedIpv4 &&
      (Number.parseInt(mappedIpv4[1], 16) >> 8 === 127 ||
        Number.parseInt(mappedIpv4[1], 16) === 0xa9fe)) ||
    (ipVersion === 6 && firstIpv6Value >= 0xfe80 && firstIpv6Value <= 0xfebf)
  );
};

const normalizeBaseUrl = (raw: unknown): string => {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    throw new Error(
      'Network policy base URLs must be non-empty strings of at most 2048 characters.',
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Network policy base URL is invalid.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    isDisallowedLocalHostname(url.hostname)
  ) {
    throw new Error('Network policy base URL is not an allowed HTTPS target.');
  }
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  url.hostname = url.hostname.toLowerCase();
  if (url.port === '443') url.port = '';
  return url.toString();
};

export type ExtensionNetworkPolicyInspection = {
  manifest: ExtensionOutboundHeaderManifestV1;
};

export const inspectExtensionNetworkPolicyManifest = (
  extensionRoot: string,
): ExtensionNetworkPolicyInspection | null => {
  const resolvedRoot = fs.realpathSync(extensionRoot);
  const manifestPath = path.join(resolvedRoot, EXTENSION_OUTBOUND_HEADER_MANIFEST_FILE);
  let pathStatBefore: fs.Stats;
  try {
    pathStatBefore = fs.lstatSync(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (
    !pathStatBefore.isFile() ||
    pathStatBefore.isSymbolicLink() ||
    pathStatBefore.size > MAX_MANIFEST_BYTES ||
    pathStatBefore.nlink !== 1
  ) {
    throw new Error(
      'The Extension network policy must be a regular, unlinked file no larger than 64 KiB.',
    );
  }
  const fileDescriptor = fs.openSync(
    manifestPath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  let rawManifest: string;
  try {
    const stat = fs.fstatSync(fileDescriptor);
    if (
      !stat.isFile() ||
      stat.size > MAX_MANIFEST_BYTES ||
      stat.nlink !== 1 ||
      stat.dev !== pathStatBefore.dev ||
      stat.ino !== pathStatBefore.ino
    ) {
      throw new Error(
        'The Extension network policy must be a regular, unlinked file no larger than 64 KiB.',
      );
    }
    const realManifestPath = fs.realpathSync(manifestPath);
    const relativePath = path.relative(resolvedRoot, realManifestPath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error('The Extension network policy must stay inside the Extension root.');
    }
    const pathStatAfter = fs.lstatSync(manifestPath);
    if (
      !pathStatAfter.isFile() ||
      pathStatAfter.isSymbolicLink() ||
      pathStatAfter.nlink !== 1 ||
      pathStatAfter.dev !== stat.dev ||
      pathStatAfter.ino !== stat.ino
    ) {
      throw new Error('The Extension network policy changed while it was being read.');
    }
    rawManifest = fs.readFileSync(fileDescriptor, 'utf8');
    if (Buffer.byteLength(rawManifest, 'utf8') > MAX_MANIFEST_BYTES) {
      throw new Error('The Extension network policy must be no larger than 64 KiB.');
    }
  } finally {
    fs.closeSync(fileDescriptor);
  }

  const parsed: unknown = JSON.parse(rawManifest);
  if (!isRecord(parsed) || !hasOnlyKeys(parsed, ['schemaVersion', 'groups'])) {
    throw new Error('The Extension network policy has unsupported top-level fields.');
  }
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.groups)) {
    throw new Error('The Extension network policy schemaVersion must be 1.');
  }
  if (parsed.groups.length < 1 || parsed.groups.length > MAX_GROUPS) {
    throw new Error('The Extension network policy must declare between 1 and 32 groups.');
  }

  const groups = parsed.groups.map((rawGroup, groupIndex) => {
    if (!isRecord(rawGroup) || !hasOnlyKeys(rawGroup, ['baseUrlWhitelist', 'headerNames'])) {
      throw new Error(`Network policy group at index ${groupIndex} has unsupported fields.`);
    }
    if (
      !Array.isArray(rawGroup.baseUrlWhitelist) ||
      rawGroup.baseUrlWhitelist.length < 1 ||
      rawGroup.baseUrlWhitelist.length > MAX_BASE_URLS
    ) {
      throw new Error(
        `Network policy group at index ${groupIndex} must declare between 1 and 64 base URLs.`,
      );
    }
    if (
      !Array.isArray(rawGroup.headerNames) ||
      rawGroup.headerNames.length < 1 ||
      rawGroup.headerNames.length > MAX_HEADERS
    ) {
      throw new Error(
        `Network policy group at index ${groupIndex} must declare between 1 and 32 headers.`,
      );
    }

    const baseUrlWhitelist = [...new Set(rawGroup.baseUrlWhitelist.map(normalizeBaseUrl))].sort();
    const seenHeaderNames = new Set<string>();
    const headerNames = rawGroup.headerNames
      .map((rawHeaderName, headerIndex) => {
        if (
          typeof rawHeaderName !== 'string' ||
          rawHeaderName.length > MAX_HEADER_LENGTH ||
          !HEADER_NAME_PATTERN.test(rawHeaderName)
        ) {
          throw new Error(
            `Header ${headerIndex} in network policy group ${groupIndex} has an invalid name.`,
          );
        }
        const normalizedName = rawHeaderName.toLowerCase();
        if (FORBIDDEN_HEADER_NAMES.has(normalizedName)) {
          throw new Error(`Header ${rawHeaderName} is forbidden in Extension network policies.`);
        }
        if (seenHeaderNames.has(normalizedName)) {
          throw new Error(
            `Header ${rawHeaderName} is duplicated in network policy group ${groupIndex}.`,
          );
        }
        seenHeaderNames.add(normalizedName);
        return rawHeaderName;
      })
      .sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
    return { baseUrlWhitelist, headerNames };
  });

  const manifest: ExtensionOutboundHeaderManifestV1 = { schemaVersion: 1, groups };
  return { manifest };
};
