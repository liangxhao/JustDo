import type { BatchPlan } from './batch-contract.js';

export function validateBatchPlan(value: unknown): BatchPlan | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid batch descriptor.');
  const batch = value as Record<string, unknown>;
  if (
    Object.keys(batch).some(key => key !== 'source') ||
    !batch.source ||
    typeof batch.source !== 'object' ||
    Array.isArray(batch.source)
  )
    throw new Error('A batch requires one input source.');
  const source = batch.source as Record<string, unknown>;
  if (
    !['files', 'jsonl'].includes(String(source.kind)) ||
    typeof source.path !== 'string' ||
    !source.path.trim() ||
    source.path.length > 1024 ||
    source.path.includes('\0') ||
    Object.keys(source).some(
      key => !['kind', 'path', ...(source.kind === 'files' ? ['pattern'] : [])].includes(key),
    )
  )
    throw new Error('Invalid batch input source.');
  if (
    source.pattern !== undefined &&
    (typeof source.pattern !== 'string' ||
      !source.pattern ||
      source.pattern.length > 200 ||
      source.pattern.startsWith('/') ||
      source.pattern.includes('\\') ||
      source.pattern.split('/').includes('..'))
  )
    throw new Error('Invalid batch file pattern.');
  return source.kind === 'files'
    ? {
        source: {
          kind: 'files',
          path: source.path,
          ...(source.pattern ? { pattern: source.pattern as string } : {}),
        },
      }
    : { source: { kind: 'jsonl', path: source.path } };
}
