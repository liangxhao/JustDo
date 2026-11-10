import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { expect, it } from 'vitest';

import { assertPluginDataId, resolvePluginDataDirectory } from '../../../../plugins/sdk/app-plugin-sdk/data';
import { preparePluginDataDirectory, preparePluginDataRemoval, removePluginData } from '../data/pluginDataService';
import { AppApprovalStore } from './approvalStore';
import { appPluginStoragePaths } from './storage';

it('shares one root while uninstall cleanup remains limited to plugin-owned data', async () => {
  await mkdir(path.resolve('build'), { recursive: true });
  const buildRoot = await realpath(path.resolve('build'));
  const fixture = await mkdtemp(path.join(buildRoot, 'plugin-storage-'));
  if (path.dirname(fixture) !== buildRoot || !path.basename(fixture).startsWith('plugin-storage-'))
    throw new Error('Unsafe plugin storage test cleanup');
  try {
    const state = path.join(fixture, '资料 with spaces', 'openclaw', 'state');
    await mkdir(state, { recursive: true });
    const paths = appPluginStoragePaths(state);
    const hash = 'a'.repeat(64);
    const approvals = new AppApprovalStore(paths.approvals);
    expect(await approvals.read()).toEqual({});
    expect(existsSync(paths.host)).toBe(false);
    await approvals.approve('sample', hash);
    const data = await preparePluginDataDirectory(state, 'sample', { directory: 'managed-v1' });
    expect(path.dirname(data)).toBe(path.dirname(paths.host));
    expect(resolvePluginDataDirectory(state, 'sample')).toBe(data);
    expect(() => assertPluginDataId(path.basename(paths.host))).toThrow();
    await writeFile(path.join(data, 'model'), 'private model');

    await removePluginData(await preparePluginDataRemoval(state, ['sample']));

    expect(existsSync(data)).toBe(false);
    expect(await approvals.read()).toEqual({ sample: hash });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
