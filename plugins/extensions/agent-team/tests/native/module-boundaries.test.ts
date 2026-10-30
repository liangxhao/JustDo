import path from 'node:path';

import { build } from 'esbuild';
import { expect, it } from 'vitest';

const pluginRoot = path.resolve(import.meta.dirname, '../..');

async function dependencies(entry: string, platform: 'node' | 'browser' = 'node') {
  const result = await build({
    absWorkingDir: pluginRoot,
    entryPoints: [path.resolve(pluginRoot, entry)],
    bundle: true,
    write: false,
    format: 'esm',
    platform,
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
    ...(platform === 'node' ? { packages: 'external' as const } : {}),
    metafile: true,
  });
  return Object.keys(result.metafile!.inputs).map(file => file.replaceAll('\\', '/'));
}

it('Native bundles without application, Main, Browser or private sibling implementations', async () => {
    const inputs = await dependencies('index.ts');
    expect(inputs.some(file => file.startsWith('../') || path.isAbsolute(file))).toBe(false);
    expect(inputs.some(file => file.startsWith('host/'))).toBe(false);
    expect(inputs.some(file => file.startsWith('browser/'))).toBe(false);
    const historyModules = [
      'collaboration/collaboration-history.ts',
      'discussion/discussion-history.ts',
    ];
    for (const module of historyModules)
      expect(inputs.includes(module)).toBe(true);
});

it.each([
  'collaboration',
  'teamDiscussion',
  'agentTeamSettings',
  'agentTeamPrompt',
  'agentTeamLaunchText',
  'collaborationContinuationPrompt',
])('application contract %s remains safe for the renderer', async name => {
  const inputs = await dependencies(`app/contracts/${name}.ts`, 'browser');
  expect(inputs.some(file => /(?:^|\/)src\/main\//u.test(file))).toBe(false);
  expect(
    inputs
      .filter(file => !file.startsWith('../') && !file.includes('node_modules/'))
      .every(file => /(?:^|\/)(contracts|prompt)\//.test(file)),
  ).toBe(true);
});

it.each(['collaboration', 'teamDiscussion', 'agentTeamLaunch'])(
  '%s coordination has no Electron IPC dependency',
  async name => {
    const result = await build({
      absWorkingDir: pluginRoot,
      entryPoints: [path.resolve(pluginRoot, `host/${{collaboration:'collaboration',teamDiscussion:'discussion',agentTeamLaunch:'launch'}[name]}/${name}Coordinator.ts`)],
      bundle: true,
      write: false,
      platform: 'node',
      format: 'esm',
      tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
      packages: 'external',
      metafile: true,
    });
    const imports = Object.values(result.metafile!.inputs).flatMap(input => input.imports);
    expect(imports.some(item => item.path === 'electron')).toBe(false);
    expect(imports.some(item => item.path.startsWith('openclaw/plugin-sdk'))).toBe(false);
    const inputs = Object.keys(result.metafile!.inputs).map(file => file.replaceAll('\\', '/'));
    expect(inputs.filter(file => file.startsWith('../') || path.isAbsolute(file))).toEqual([]);
  },
);

it.each([
  'data/agentTeamSettingsService',
  'data/collaborationStore',
  'data/collaborationReviewStore',
  'data/teamDiscussionStore',
  'data/teamDiscussionQueueStore',
  'collaboration/collaborationCoordinator',
  'discussion/teamDiscussionCoordinator',
  'discussion/teamDiscussionQueue',
  'discussion/teamDiscussionAttachments',
  'launch/agentTeamLaunchCoordinator',
])('host implementation %s bundles independently of the application', async module => {
  const inputs = await dependencies(`host/${module}.ts`);
  expect(inputs.some(file => file.startsWith('../') || path.isAbsolute(file))).toBe(false);
  expect(inputs.includes(`host/${module}.ts`)).toBe(true);
});

it.each([
  'discussion/discussionExport',
  'discussion/discussionMentions',
  'discussion/teamDiscussionQueue',
  'discussion/teamDiscussionDraft',
  'collaboration/collaborationContinueDraft',
  'collaboration/collaborationContinueStatus',
])('browser implementation %s bundles independently of the application', async module => {
  const inputs = await dependencies(
    `browser/${module}.ts`,
    'browser',
  );
  expect(inputs.some(file => /(?:^|\/)src\//u.test(file) && !file.includes('node_modules/'))).toBe(false);
  expect(inputs.some(file => file.startsWith('host/'))).toBe(false);
});
