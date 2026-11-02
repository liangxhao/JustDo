/** Stable delivery versions shared by startup admission and packaging. */
export function parseStableVersion(value: unknown): readonly number[] | null {
  if (typeof value !== 'string' || value.trim() !== value ||
      !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
    return null;
  const parts = value.replace(/^v/, '').split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}
