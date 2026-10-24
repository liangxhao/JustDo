import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { nativeDatabaseEnvironment } from './nativeDatabaseEnvironment';

describe('offline native database environment', () => {
  const paths = { stateDir: path.resolve('fixture-state'), configPath: path.resolve('fixture-state/openclaw.json') };
  it('binds only the selected profile and strips inherited native execution/auth overrides without mutating input', () => {
    const inherited = { Path: 'system-tools', OPENCLAW_GATEWAY_TOKEN: 'private', openclaw_home: 'foreign',
      OPENCLAW_UPDATE_IN_PROGRESS: '1', Node_Options: '--require foreign.cjs', NODE_PATH: 'foreign',
      ELECTRON_RUN_AS_NODE: '1', SYSTEMROOT: 'system', LANG: 'zh_CN' };
    const env = nativeDatabaseEnvironment(inherited, paths);
    expect(env).toEqual({ PATH: 'system-tools', SYSTEMROOT: 'system', LANG: 'zh_CN',
      OPENCLAW_HOME: paths.stateDir, OPENCLAW_STATE_DIR: paths.stateDir,
      OPENCLAW_CONFIG_PATH: paths.configPath, OPENCLAW_NO_RESPAWN: '1', OPENCLAW_NO_UPDATE_CHECK: '1' });
    expect(inherited.OPENCLAW_GATEWAY_TOKEN).toBe('private');
  });
  it.each(['relative', `${path.resolve('profile')}\nother`, `${path.resolve('profile')}\0other`])('rejects invalid profile paths: %j', stateDir => {
    expect(() => nativeDatabaseEnvironment({}, { ...paths, stateDir })).toThrow(/absolute profile paths/);
  });
});
