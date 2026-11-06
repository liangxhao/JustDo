import { createHash } from 'node:crypto';

import { AppServerErrorCode, type AppServerParams,AppServerRpcError } from './appServerProtocol';
import type { AppServerThreadMetadata } from './appServerTypes';
import { codexModelProvider } from './appServerWire';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_KINDS = new Set(['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'subAgentReview', 'subAgentCompact', 'subAgentThreadSpawn', 'subAgentOther', 'unknown']);

export function invalidParams(message: string): never {
  throw new AppServerRpcError(AppServerErrorCode.InvalidParams, message);
}

export const optionalString = (params: AppServerParams, key: string): string | undefined => {
  const value = params[key];
  if (value == null) return undefined;
  if (typeof value !== 'string') invalidParams(`Invalid ${key}.`);
  return value;
};

export const optionalBoolean = (params: AppServerParams, key: string): boolean | undefined => {
  const value = params[key];
  if (value == null) return undefined;
  if (typeof value !== 'boolean') invalidParams(`Invalid ${key}.`);
  return value;
};

const strings = (params: AppServerParams, key: string): string[] => {
  const value = params[key];
  if (value == null) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) invalidParams(`Invalid ${key}.`);
  return value;
};

const limit = (params: AppServerParams): number => {
  const value = params.limit ?? DEFAULT_LIMIT;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_LIMIT)
    invalidParams(`limit must be an integer between 0 and ${MAX_LIMIT}.`);
  return value;
};

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const decode = (cursor: string): Record<string, unknown> => {
  try {
    if (cursor.length > 4096 || !/^[a-zA-Z0-9_-]+$/.test(cursor)) throw new Error();
    const result: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
    return result as Record<string, unknown>;
  } catch {
    invalidParams('Invalid pagination cursor.');
  }
};

export function paginateIds<T>(
  data: readonly T[], params: AppServerParams, kind: string, id: (entry: T) => string,
): { data: T[]; nextCursor: string | null } {
  const size = limit(params);
  const cursor = optionalString(params, 'cursor');
  let start = 0;
  if (cursor) {
    const saved = decode(cursor);
    if (saved.kind !== kind || typeof saved.id !== 'string') invalidParams('Invalid pagination cursor.');
    const index = data.findIndex(entry => id(entry) === saved.id);
    if (index < 0) invalidParams('The pagination cursor is no longer available.');
    start = index + 1;
  }
  const page = data.slice(start, start + size);
  return {
    data: page,
    nextCursor: size > 0 && start + page.length < data.length
      ? encode({ kind, id: id(page[page.length - 1]) }) : null,
  };
}

export function paginateThreads<T extends AppServerThreadMetadata>(
  metadata: T[], params: AppServerParams,
): { data: T[]; nextCursor: string | null; backwardsCursor: null } {
  const size = limit(params);
  const archived = optionalBoolean(params, 'archived') ?? false;
  optionalBoolean(params, 'useStateDbOnly');
  const sortKey = optionalString(params, 'sortKey') ?? 'created_at';
  if (!['created_at', 'updated_at', 'recency_at'].includes(sortKey)) invalidParams('Unsupported sortKey.');
  const direction = optionalString(params, 'sortDirection') ?? 'desc';
  if (direction !== 'asc' && direction !== 'desc') invalidParams('Invalid sortDirection.');
  const modelProviders = strings(params, 'modelProviders');
  const sourceKinds = strings(params, 'sourceKinds');
  if (sourceKinds.some(kind => !SOURCE_KINDS.has(kind))) invalidParams('Invalid sourceKinds.');
  const originators = strings(params, 'originators');
  if (originators.length) invalidParams('Originator filtering is unavailable.');
  if (params.sectionId != null) invalidParams('Thread sections are unavailable.');
  const excluded = strings(params, 'excludedThreadIds');
  if (excluded.length > 100 || excluded.some(id => !THREAD_ID.test(id))) invalidParams('Invalid excludedThreadIds.');
  const searchTerm = optionalString(params, 'searchTerm') ?? '';
  const cwd = params.cwd == null ? [] : typeof params.cwd === 'string' ? [params.cwd] : strings(params, 'cwd');
  const scope = [...new Set(metadata.map(entry => entry.source ?? 'cli'))].sort();
  const fingerprint = createHash('sha256').update(JSON.stringify({ scope, archived, sortKey, direction,
    modelProviders, sourceKinds, excluded, searchTerm, cwd })).digest('base64url');
  const key = (entry: AppServerThreadMetadata) => sortKey === 'created_at' ? entry.createdAt : entry.updatedAt;
  const compare = (left: { id: string; value: number }, right: { id: string; value: number }) => {
    const order = left.value - right.value || (left.id < right.id ? -1 : left.id === right.id ? 0 : 1);
    return direction === 'asc' ? order : -order;
  };
  const cursor = optionalString(params, 'cursor');
  let anchor: { id: string; value: number } | undefined;
  if (cursor) {
    const saved = decode(cursor);
    if (saved.kind !== 'threads' || saved.fingerprint !== fingerprint || typeof saved.id !== 'string'
      || typeof saved.value !== 'number' || !Number.isFinite(saved.value)) invalidParams('Invalid pagination cursor.');
    anchor = { id: saved.id, value: saved.value };
  }
  const data = metadata.filter(entry => !archived && !excluded.includes(entry.id)
    && (!modelProviders.length || modelProviders.includes(codexModelProvider(entry.modelRef)))
    && (!sourceKinds.length || sourceKinds.includes(entry.source ?? 'cli'))
    && (!cwd.length || cwd.includes(entry.cwd))
    && entry.name.toLowerCase().includes(searchTerm.toLowerCase())
    && (!anchor || compare({ id: entry.id, value: key(entry) }, anchor) > 0))
    .sort((left, right) => compare({ id: left.id, value: key(left) }, { id: right.id, value: key(right) }));
  const page = data.slice(0, size);
  const last = page[page.length - 1];
  return {
    data: page,
    nextCursor: size > 0 && data.length > size
      ? encode({ kind: 'threads', fingerprint, id: last.id, value: key(last) }) : null,
    backwardsCursor: null,
  };
}
