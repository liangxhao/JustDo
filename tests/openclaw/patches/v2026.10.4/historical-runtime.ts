import fs from 'node:fs';
import path from 'node:path';

/** Historical native probes must never execute the active version's owners. */
export function historicalRuntime(requested: string | undefined): string | undefined {
  if (!requested) return undefined;
  const metadata = path.join(requested, 'package.json');
  if (!fs.existsSync(metadata)) return undefined;
  const value = JSON.parse(fs.readFileSync(metadata, 'utf8'));
  return value.name === 'openclaw' && value.version === '2026.10.4' ? requested : undefined;
}

export function historicalRuntimeOrUnavailable(requested: string): string {
  return historicalRuntime(requested) ?? path.resolve('build/upgrade-audit/v2026.10.4/unavailable');
}
