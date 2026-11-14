import { getNodeValue, type Node, type ParseError, parseTree } from 'jsonc-parser';

import { redactLogText } from '../diagnostics/redaction';
import type { McpServerConfig, McpServerFormData, McpTransportType } from './mcp';
import {
  isMcpTransferName,
  MCP_TRANSFER_MAX_ROWS,
  type McpExportOptions,
  type McpExportRow,
  type McpImportFormat,
  type McpImportPreviewRow,
  type McpImportRowIssue,
  type McpTransferResult,
} from './mcpTransfer';

type ImportConfig = Omit<McpServerFormData, 'transportType'> & {
  transportType?: McpTransportType;
};

export interface ParsedMcpImportRow {
  preview: McpImportPreviewRow;
  config?: ImportConfig;
}

type ParsedMcpImport = { format: McpImportFormat; rows: ParsedMcpImportRow[] };
type ExportServer = McpServerConfig & { openClawConfig?: Record<string, unknown> };

const inputReference = /\$\{[^}]+\}/u;
const invalidLine = /[\u0000\r\n]/u;
const sensitiveKey =
  /password|passwd|token|secret|api[-_]?key|access[-_]?key|authorization|cookie|credential|signature/i;
const sensitiveQueryKey = /^(?:key|sig|auth|client_assertion)$/i;
const launchFlag = /^(--?[\w-]+)(?:=(.*))?$/u;
const headerName = /^[!#$%&'*+\-.^_`|~\w]+$/u;

const standardFields = new Set(['type', 'command', 'args', 'env', 'url', 'headers', 'description']);
const displayFields = new Set([
  'name',
  'registryUrl',
  'provider',
  'providerUrl',
  'logoUrl',
  'tags',
  'reference',
  'searchKey',
  'configSample',
]);
const nativeFields = new Set([
  'enabled',
  'transport',
  'command',
  'args',
  'env',
  'url',
  'headers',
  'requestTimeoutMs',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const nonemptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined;

const safePreviewText = (value: string | undefined): string | undefined =>
  value
    ? redactLogText(value)
        .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
        .slice(0, 600)
    : undefined;

function normalizeTransport(value: unknown): McpTransportType | undefined {
  if (typeof value !== 'string') return undefined;
  switch (value.toLowerCase()) {
    case 'stdio':
      return 'stdio';
    case 'http':
    case 'streamablehttp':
    case 'streamable-http':
      return 'http';
    case 'sse':
      return 'sse';
    default:
      return undefined;
  }
}

function parseRemoteUrl(value: string | undefined): URL | undefined {
  if (!value || invalidLine.test(value) || inputReference.test(value)) return undefined;
  if (!/^https?:\/\//iu.test(value)) return undefined;
  try {
    const url = new URL(value);
    return url.hostname && !url.username && !url.password ? url : undefined;
  } catch {
    return undefined;
  }
}

const validCommand = (value: string | undefined): value is string =>
  Boolean(value && !invalidLine.test(value) && !inputReference.test(value));

const validArgs = (args: unknown): args is string[] | undefined =>
  args === undefined ||
  (Array.isArray(args) &&
    args.every(
      arg => typeof arg === 'string' && !invalidLine.test(arg) && !inputReference.test(arg),
    ));

function credentials(
  value: unknown,
  transport: 'stdio' | 'remote',
): { values?: Record<string, string>; missing?: string[] } | undefined {
  if (value === undefined) return {};
  if (!isRecord(value)) return undefined;
  const entries: [string, string][] = [];
  const missing: string[] = [];
  const seenKeys = new Set<string>();
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = transport === 'remote' ? key.toLowerCase() : key;
    const text =
      transport === 'stdio' && typeof entry === 'number' && Number.isFinite(entry)
        ? String(entry)
        : entry;
    if (
      seenKeys.has(normalizedKey) ||
      !isMcpTransferName(key) ||
      (transport === 'remote' ? !headerName.test(key) : key.includes('=')) ||
      typeof text !== 'string' ||
      (transport === 'remote' ? invalidLine.test(text) : text.includes('\0'))
    ) {
      return undefined;
    }
    seenKeys.add(normalizedKey);
    if (!text.trim() || inputReference.test(text)) {
      missing.push(key);
      entries.push([key, '']);
    } else {
      entries.push([key, text]);
    }
  }
  return {
    ...(entries.length ? { values: Object.fromEntries(entries) } : {}),
    ...(missing.length ? { missing } : {}),
  };
}

function connectionSummary(
  command: string | undefined,
  args: readonly string[] | undefined,
  url: URL | undefined,
): string | undefined {
  if (url) return safePreviewText(url.origin + url.pathname + (url.search ? '?…' : ''));
  if (!command) return undefined;
  let maskNext = false;
  const safeArgs = (args ?? []).map(arg => {
    if (maskNext) {
      maskNext = false;
      return '[REDACTED]';
    }
    const flag = launchFlag.exec(arg);
    if (flag && sensitiveKey.test(flag[1])) {
      if (flag[2] !== undefined) return flag[1] + '=[REDACTED]';
      maskNext = true;
    }
    return arg;
  });
  return safePreviewText([command, ...safeArgs].join(' '));
}

function isUnsupportedField(key: string, value: unknown): boolean {
  if (standardFields.has(key) || displayFields.has(key)) return false;
  switch (key) {
    case 'enabled':
    case 'disabled':
    case 'longRunning':
    case 'timeout':
      return false;
    case 'disabledTools':
    case 'disabledAutoApproveTools':
    case 'shouldConfig':
      return value !== false && value != null && !(Array.isArray(value) && !value.length);
    case 'sandboxEnabled':
      return value !== false;
    default:
      return true;
  }
}

function parseRow(
  index: number,
  name: string,
  raw: unknown,
  hasWorkspaceSandbox: boolean,
): ParsedMcpImportRow {
  const preview: McpImportPreviewRow = { index, name };
  const fail = (issue: McpImportRowIssue) => ({ preview: { ...preview, issue } });
  if (!isMcpTransferName(name)) return fail('invalid-name');
  if (!isRecord(raw)) return fail('invalid-config');

  const description = typeof raw.description === 'string' ? raw.description : undefined;
  preview.description = safePreviewText(description);
  const command = nonemptyString(raw.command)?.trim();
  const args = validArgs(raw.args) ? raw.args : undefined;
  const url = nonemptyString(raw.url)?.trim();
  const remoteUrl = parseRemoteUrl(url);
  const transportType =
    raw.type === undefined ? (command ? 'stdio' : undefined) : normalizeTransport(raw.type);
  preview.transportType = transportType;
  preview.connectionSummary = connectionSummary(
    validCommand(command) ? command : undefined,
    args,
    remoteUrl,
  );

  if (raw.type !== undefined && !transportType) return fail('invalid-transport');
  if (transportType === 'stdio' && !validCommand(command)) return fail('missing-command');
  if (transportType !== 'stdio' && !remoteUrl) return fail('invalid-url');
  if (transportType === 'stdio' && !validArgs(raw.args)) return fail('invalid-arguments');
  if (
    transportType === 'stdio'
      ? raw.url !== undefined || raw.headers !== undefined
      : raw.command !== undefined || raw.args !== undefined || raw.env !== undefined
  ) {
    return fail('invalid-config');
  }
  if (
    (transportType === 'stdio' && hasWorkspaceSandbox) ||
    (isRecord(raw.env) && Object.values(raw.env).includes(null)) ||
    Object.entries(raw).some(([key, value]) => isUnsupportedField(key, value))
  ) {
    return fail('unsupported-fields');
  }

  const auth =
    transportType === 'stdio' ? credentials(raw.env, 'stdio') : credentials(raw.headers, 'remote');
  if (!auth) return fail('invalid-credentials');
  preview.missingCredentials = auth.missing;
  const config: ImportConfig =
    transportType === 'stdio'
      ? {
          name,
          description,
          transportType,
          command,
          args,
          env: auth.values,
        }
      : { name, description, transportType, url, headers: auth.values };
  return { preview, config };
}

/** Preserve the AST until duplicate keys have been checked instead of accepting last-write-wins. */
function hasAmbiguousObject(node: Node): boolean {
  const seen = new Set<string>();
  const stack = [node];
  while (stack.length) {
    const current = stack.pop()!;
    if (current.type === 'object') {
      seen.clear();
      for (const property of current.children ?? []) {
        const [key, value] = property.children ?? [];
        if (
          typeof key?.value !== 'string' ||
          !value ||
          seen.has(key.value) ||
          key.value === '__proto__'
        ) {
          return true;
        }
        seen.add(key.value);
        stack.push(value);
      }
    } else if (current.children) {
      for (const child of current.children) stack.push(child);
    }
  }
  return false;
}

export function parseMcpImport(text: string): McpTransferResult<ParsedMcpImport> {
  if (!text.trim()) return { success: false, code: 'empty' };
  const errors: ParseError[] = [];
  try {
    const root = parseTree(text.replace(/^\uFEFF/u, ''), errors, { allowTrailingComma: true });
    if (!root || errors.length) return { success: false, code: 'invalid' };
    const sources = root.children?.filter(property => {
      const key = property.children?.[0]?.value;
      return key === 'mcpServers' || key === 'servers';
    });
    const [key, map] = sources?.[0]?.children ?? [];
    if (root.type !== 'object' || sources?.length !== 1 || map?.type !== 'object') {
      return { success: false, code: 'unsupported-format' };
    }
    const entries = map.children ?? [];
    if (!entries.length) return { success: false, code: 'empty' };
    if (entries.length > MCP_TRANSFER_MAX_ROWS) return { success: false, code: 'too-large' };
    const format = key.value as McpImportFormat;
    const hasWorkspaceSandbox =
      format === 'servers' &&
      Boolean(root.children?.some(property => property.children?.[0]?.value === 'sandbox'));
    const names = new Map<string, number>();
    for (const property of entries) {
      const name = String(property.children?.[0]?.value).trim();
      names.set(name, (names.get(name) ?? 0) + 1);
    }
    const rows = entries.map((property, index): ParsedMcpImportRow => {
      const [nameNode, raw] = property.children ?? [];
      const name = String(nameNode?.value).trim();
      if ((names.get(name) ?? 0) > 1) return { preview: { index, name, issue: 'duplicate-name' } };
      if (!raw || hasAmbiguousObject(raw))
        return { preview: { index, name, issue: 'invalid-config' } };
      return parseRow(index, name, getNodeValue(raw), hasWorkspaceSandbox);
    });
    return { success: true, value: { format, rows } };
  } catch {
    return { success: false, code: 'invalid' };
  }
}

function exportConnection(server: ExportServer) {
  const native = server.openClawConfig;
  const field = (key: 'command' | 'args' | 'env' | 'url' | 'headers') =>
    native?.[key] === undefined ? server[key] : native[key];
  return {
    command: field('command'),
    args: field('args'),
    env: field('env'),
    url: field('url'),
    headers: field('headers'),
  };
}

const containsRecognizableSecret = (value: string): boolean =>
  redactLogText(value).includes('[REDACTED');

function hasSensitiveLaunch(text: string, args: readonly string[]): boolean {
  return (
    containsRecognizableSecret(text) ||
    args.some(arg => {
      const flag = launchFlag.exec(arg);
      return containsRecognizableSecret(arg) || Boolean(flag && sensitiveKey.test(flag[1]));
    })
  );
}

export function toMcpExportRow(server: ExportServer): McpExportRow {
  const row: McpExportRow = {
    id: server.id,
    name: server.name,
    description: safePreviewText(server.description),
    transportType: server.transportType,
  };
  if (!isMcpTransferName(server.name)) return { ...row, issue: 'invalid-config' };
  if (Object.keys(server.openClawConfig ?? {}).some(key => !nativeFields.has(key))) {
    return { ...row, issue: 'unsupported-fields' };
  }

  const effective = exportConnection(server);
  const command = nonemptyString(effective.command);
  const rawUrl = nonemptyString(effective.url);
  const url = parseRemoteUrl(rawUrl);
  const args = validArgs(effective.args) ? effective.args : undefined;
  row.connectionSummary = connectionSummary(validCommand(command) ? command : undefined, args, url);
  if (containsRecognizableSecret(server.name)) {
    return {
      ...row,
      name: safePreviewText(server.name) ?? '[REDACTED]',
      issue: 'sensitive-connection',
    };
  }
  if (server.description && containsRecognizableSecret(server.description)) {
    return { ...row, issue: 'sensitive-connection' };
  }
  if (server.transportType === 'stdio') {
    if (
      !validCommand(command) ||
      !validArgs(effective.args) ||
      !credentials(effective.env, 'stdio')
    ) {
      return { ...row, issue: 'invalid-config' };
    }
    if (hasSensitiveLaunch(command, args ?? [])) return { ...row, issue: 'sensitive-connection' };
  } else {
    if (server.transportType !== 'http' && server.transportType !== 'sse') {
      return { ...row, issue: 'invalid-config' };
    }
    if (rawUrl && /^https?:\/\/[^/?#]+@/iu.test(rawUrl)) {
      return { ...row, issue: 'sensitive-connection' };
    }
    if (!rawUrl || !url || !credentials(effective.headers, 'remote')) {
      return { ...row, issue: 'invalid-config' };
    }
    if (
      [...url.searchParams.keys()].some(
        key => sensitiveKey.test(key) || sensitiveQueryKey.test(key),
      ) ||
      containsRecognizableSecret(rawUrl)
    ) {
      return { ...row, issue: 'sensitive-connection' };
    }
  }
  return row;
}

function exportCredentials(
  values: unknown,
  include: boolean | undefined,
  mask: boolean,
): Record<string, string> | undefined {
  if (!isRecord(values)) return undefined;
  const entries = Object.entries(values).map(([key, value]) => {
    if (!include || value === '') return [key, ''];
    return [key, mask ? '••••' : String(value)];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** Callers use toMcpExportRow to exclude entries whose launch cannot be exported safely. */
export function serializeMcpExport(
  servers: readonly ExportServer[],
  options: McpExportOptions = {},
  maskIncludedValues = false,
): string {
  const mcpServers = Object.fromEntries(
    servers.map(server => {
      const { command, args, env, url, headers } = exportConnection(server);
      return [
        server.name,
        {
          type: server.transportType,
          ...(server.transportType === 'stdio'
            ? {
                command,
                args,
                env: exportCredentials(env, options.includeEnvValues, maskIncludedValues),
              }
            : {
                url,
                headers: exportCredentials(
                  headers,
                  options.includeHeaderValues,
                  maskIncludedValues,
                ),
              }),
          ...(server.description ? { description: server.description } : {}),
        },
      ];
    }),
  );
  return JSON.stringify({ mcpServers }, null, 2) + '\n';
}
