import fs from 'node:fs';
import path from 'node:path';

const RUNTIME_ENVIRONMENT_KEYS = [
  'JUSTDO_EXECUTION_PRISTINE_DIR',
  'JUSTDO_EXECUTION_RUNTIME',
  'OPENCLAW_TEST_NATIVE_RUNTIME_DIR',
  'OPENCLAW_RUNTIME_DIR',
  'OPENCLAW_PRISTINE_DIR',
  'GOAL_CONTINUATION_PRISTINE_DIR',
  'GOAL_CONTINUATION_PREVIOUS_DIR',
  'PLUGIN_PUBLICATION_PRISTINE',
] as const;

/** A default current artifact cannot serve as evidence for a historical version. */
export function admitHistoricalRuntime(
  requested: string | undefined,
  version: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!requested) return undefined;
  const requestedBundle = environment.GOAL_CONTINUATION_BUNDLE_FILE;
  const explicitBundle = Boolean(requestedBundle && path.resolve(path.dirname(requestedBundle)) === path.resolve(requested));
  const explicit = explicitBundle || RUNTIME_ENVIRONMENT_KEYS.some(key =>
    environment[key] && path.resolve(environment[key]) === path.resolve(requested));
  const metadata = path.join(requested, 'package.json');
  try {
    if (explicitBundle && !fs.statSync(requestedBundle!).isFile())
      throw new Error('The requested historical Gateway bundle is not a file');
    const value = JSON.parse(fs.readFileSync(metadata, 'utf8'));
    if (value.name === 'openclaw' && value.version === version) return requested;
    if (explicit) throw new Error(`Expected historical openclaw@${version}, received ${value.name}@${value.version}`);
  } catch (error) {
    if (explicit) throw new Error(`Historical runtime admission failed for openclaw@${version}`, { cause: error });
  }
  return undefined;
}

export function historicalRuntimePath(requested: string, version: string): string {
  return admitHistoricalRuntime(requested, version) ?? path.resolve(`build/upgrade-audit/v${version}/unavailable`);
}
