import fs from 'fs';
import { isIP } from 'net';
import path from 'path';

import {
  EXTENSION_OUTBOUND_HEADER_MANIFEST_FILE,
  type ExtensionOutboundHeaderManifestV1,
} from '../../../shared/plugins/outboundHeaderPolicy';
import { t } from '../../core/i18n';

const MAX_MANIFEST_BYTES = 64 * 1024;
const FILE_CHECK = {
  BEFORE_OPEN: 'networkPolicyFileBeforeOpen',
  OPENED: 'networkPolicyFileOpened',
  PATH_RECHECK: 'networkPolicyFilePathRecheck',
  CONTENT: 'networkPolicyFileContent',
} as const;
type FileCheck = typeof FILE_CHECK[keyof typeof FILE_CHECK];
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
        Number.parseInt(mappedIpv4[1], 16) === 0xa9fe ||
        (Number.parseInt(mappedIpv4[1], 16) === 0 && Number.parseInt(mappedIpv4[2], 16) === 0))) ||
    (ipVersion === 6 && firstIpv6Value >= 0xfe80 && firstIpv6Value <= 0xfebf)
  );
};

const normalizeBaseUrl = (raw: unknown, groupIndex: number, urlIndex: number): string => {
  const invalid = (reasonKey: string): Error => new Error(t('networkPolicyUrlInvalid')
    .replace('{file}', EXTENSION_OUTBOUND_HEADER_MANIFEST_FILE)
    .replace('{group}', String(groupIndex + 1))
    .replace('{url}', String(urlIndex + 1))
    .replace('{reason}', t(reasonKey)));
  if (typeof raw !== 'string') throw invalid('networkPolicyUrlType');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid('networkPolicyUrlAbsolute');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw invalid('networkPolicyUrlProtocol');
  if (url.username || url.password) throw invalid('networkPolicyUrlCredentials');
  if (url.href.split('#', 1)[0].includes('?')) throw invalid('networkPolicyUrlQuery');
  if (url.href.includes('#')) throw invalid('networkPolicyUrlFragment');
  if (isDisallowedLocalHostname(url.hostname)) throw invalid('networkPolicyUrlLocal');
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  url.hostname = url.hostname.toLowerCase();
  return url.toString();
};

export type ExtensionNetworkPolicyInspection = {
  manifest: ExtensionOutboundHeaderManifestV1;
};

const fileInspectionError = (check: FileCheck, reason: string): Error =>
  new Error(t('networkPolicyFileInvalid')
    .replace('{file}', EXTENSION_OUTBOUND_HEADER_MANIFEST_FILE)
    .replace('{check}', t(check))
    .replace('{reason}', reason));

const fileSizeReason = (bytes: number): string => t('networkPolicyFileTooLarge')
  .replace('{bytes}', String(bytes))
  .replace('{limit}', String(MAX_MANIFEST_BYTES));

const assertManifestFile = (stat: fs.Stats, check: FileCheck): void => {
  if (stat.isSymbolicLink()) {
    throw fileInspectionError(check, t('networkPolicyFileSymbolicLink'));
  }
  if (!stat.isFile()) {
    throw fileInspectionError(check, t('networkPolicyFileNotRegular'));
  }
  if (stat.size > MAX_MANIFEST_BYTES) {
    throw fileInspectionError(check, fileSizeReason(stat.size));
  }
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
  assertManifestFile(pathStatBefore, FILE_CHECK.BEFORE_OPEN);
  const fileDescriptor = fs.openSync(
    manifestPath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  let rawManifest: string;
  try {
    const stat = fs.fstatSync(fileDescriptor);
    assertManifestFile(stat, FILE_CHECK.OPENED);
    if (stat.dev !== pathStatBefore.dev || stat.ino !== pathStatBefore.ino) {
      throw fileInspectionError(FILE_CHECK.OPENED, t('networkPolicyFileIdentityMismatch'));
    }
    const realManifestPath = fs.realpathSync(manifestPath);
    const relativePath = path.relative(resolvedRoot, realManifestPath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw fileInspectionError(FILE_CHECK.PATH_RECHECK, t('networkPolicyFileOutsideRoot'));
    }
    const pathStatAfter = fs.lstatSync(manifestPath);
    assertManifestFile(pathStatAfter, FILE_CHECK.PATH_RECHECK);
    if (pathStatAfter.dev !== stat.dev || pathStatAfter.ino !== stat.ino) {
      throw fileInspectionError(FILE_CHECK.PATH_RECHECK, t('networkPolicyFileIdentityMismatch'));
    }
    rawManifest = fs.readFileSync(fileDescriptor, 'utf8');
    const bytes = Buffer.byteLength(rawManifest, 'utf8');
    if (bytes > MAX_MANIFEST_BYTES) {
      throw fileInspectionError(FILE_CHECK.CONTENT, fileSizeReason(bytes));
    }
  } finally {
    fs.closeSync(fileDescriptor);
  }

  const parsed: unknown = JSON.parse(rawManifest);
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.groups)) {
    throw new Error(t('networkPolicyManifestShapeInvalid'));
  }

  const groups = parsed.groups.flatMap((rawGroup, groupIndex) => {
    if (!isRecord(rawGroup) || !Array.isArray(rawGroup.baseUrlWhitelist) ||
        !Array.isArray(rawGroup.headerNames)) {
      throw new Error(t('networkPolicyGroupShapeInvalid').replace('{group}', String(groupIndex + 1)));
    }
    if (rawGroup.baseUrlWhitelist.length === 0 || rawGroup.headerNames.length === 0) return [];

    const baseUrlWhitelist = [...new Set(rawGroup.baseUrlWhitelist.map(
      (raw, urlIndex) => normalizeBaseUrl(raw, groupIndex, urlIndex),
    ))].sort();
    const seenHeaderNames = new Map<string, string>();
    for (const [headerIndex, rawHeaderName] of rawGroup.headerNames.entries()) {
      if (typeof rawHeaderName !== 'string' || !HEADER_NAME_PATTERN.test(rawHeaderName)) {
        throw new Error(`Header ${headerIndex} in network policy group ${groupIndex} has an invalid name.`);
      }
      const normalizedName = rawHeaderName.toLowerCase();
      if (FORBIDDEN_HEADER_NAMES.has(normalizedName)) {
        throw new Error(`Header ${rawHeaderName} is forbidden in Extension network policies.`);
      }
      if (!seenHeaderNames.has(normalizedName)) seenHeaderNames.set(normalizedName, rawHeaderName);
    }
    const headerNames = [...seenHeaderNames.values()]
      .sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
    return [{ baseUrlWhitelist, headerNames }];
  });

  const manifest: ExtensionOutboundHeaderManifestV1 = { schemaVersion: 1, groups };
  return { manifest };
};
