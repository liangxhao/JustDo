import path from 'node:path';

/** Inspection must precede configuration projection, tokens, ports, or product-store admission. */
export function nativeDatabaseEnvironment(
  inherited: NodeJS.ProcessEnv,
  paths: { stateDir: string; configPath: string },
): NodeJS.ProcessEnv {
  for (const value of [paths.stateDir, paths.configPath]) {
    if (!path.isAbsolute(value) || /[\r\n\0]/u.test(value)) {
      throw new Error('Native database maintenance requires absolute profile paths.');
    }
  }
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) =>
    !/^OPENCLAW_/iu.test(key) && !/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE)$/iu.test(key)));
  // Windows environment keys are case insensitive; a plain object is not.
  const pathEntry = Object.entries(inherited).find(([key]) => key.toUpperCase() === 'PATH');
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  if (pathEntry?.[1]) env.PATH = pathEntry[1];
  return {
    ...env,
    OPENCLAW_HOME: paths.stateDir,
    OPENCLAW_STATE_DIR: paths.stateDir,
    OPENCLAW_CONFIG_PATH: paths.configPath,
    OPENCLAW_NO_RESPAWN: '1',
    OPENCLAW_NO_UPDATE_CHECK: '1',
  };
}
