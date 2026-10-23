import fs from 'node:fs';
import path from 'node:path';

import type { ExternalMcpCloseRequest, ExternalMcpOpenRequest } from '../contracts/external-mcp';

export const MAX_SERVERS = 16;
export const MAX_TOOLS = 128;
export const MAX_CATALOG_BYTES = 512 * 1024;
export const MAX_ARGUMENT_BYTES = 256 * 1024;
export const MAX_RESULT_BYTES = 2 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 120_000;
export const STARTUP_TIMEOUT_MS = 20_000;

export type RecordValue = Record<string, unknown>;
export const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const boundedString = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0\r\n]/.test(value);

export function canonicalDirectory(value: string): string {
  if (!path.isAbsolute(value) || !fs.statSync(value).isDirectory())
    throw new Error('Invalid external MCP workspace.');
  const resolved = fs.realpathSync(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function allowedEnvironmentName(value: string): boolean {
  const upper = value.toUpperCase();
  return (
    /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value) &&
    !upper.startsWith('OPENCLAW_') &&
    !upper.startsWith('ELECTRON_') &&
    !upper.startsWith('JUSTDO_') &&
    ![
      'NODE_OPTIONS',
      'NODE_PATH',
      'NODE_ENV',
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'DYLD_INSERT_LIBRARIES',
      'DYLD_LIBRARY_PATH',
    ].includes(upper)
  );
}

export function parseCloseRequest(value: unknown): ExternalMcpCloseRequest {
  if (
    !record(value) ||
    !boundedString(value.leaseId, 128) ||
    !boundedString(value.sessionKey, 1024) ||
    !boundedString(value.sessionId, 256)
  )
    throw new Error('Invalid external MCP identity.');
  return { leaseId: value.leaseId, sessionKey: value.sessionKey, sessionId: value.sessionId };
}

export function parseOpenRequest(value: unknown): ExternalMcpOpenRequest {
  const identity = parseCloseRequest(value);
  if (
    !record(value) ||
    !boundedString(value.cwd, 32768) ||
    !Array.isArray(value.servers) ||
    value.servers.length > MAX_SERVERS ||
    Buffer.byteLength(JSON.stringify(value)) > MAX_CATALOG_BYTES
  )
    throw new Error('Invalid external MCP configuration.');
  const names = new Set<string>();
  const servers = value.servers.map(server => {
    if (
      !record(server) ||
      !boundedString(server.name, 128) ||
      names.has(server.name) ||
      !boundedString(server.command, 32768) ||
      !Array.isArray(server.args) ||
      server.args.length > 128 ||
      server.args.some(
        arg => typeof arg !== 'string' || arg.length > 32768 || arg.includes('\0'),
      ) ||
      !Array.isArray(server.env) ||
      server.env.length > 128
    )
      throw new Error('Invalid external MCP server.');
    names.add(server.name);
    const envNames = new Set<string>();
    const env = server.env.map(entry => {
      if (
        !record(entry) ||
        typeof entry.name !== 'string' ||
        !allowedEnvironmentName(entry.name) ||
        envNames.has(entry.name.toUpperCase()) ||
        typeof entry.value !== 'string' ||
        entry.value.length > 32768 ||
        entry.value.includes('\0')
      )
        throw new Error('Invalid external MCP environment.');
      envNames.add(entry.name.toUpperCase());
      return { name: entry.name, value: entry.value };
    });
    return { name: server.name, command: server.command, args: [...server.args] as string[], env };
  });
  return { ...identity, cwd: canonicalDirectory(value.cwd), servers };
}

/** Stable JSON binds approval to exact arguments even when native cloning reorders keys. */
export function stableJson(value: unknown, depth = 0): string {
  if (depth > 32) throw new Error('External MCP input nesting is too deep.');
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item, depth + 1)).join(',')}]`;
  if (record(value))
    return `{${Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${stableJson(value[key], depth + 1)}`)
      .join(',')}}`;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value);
  throw new Error('External MCP values must be JSON.');
}
