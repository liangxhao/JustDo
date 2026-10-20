import path from 'node:path';

import { build } from 'esbuild';
import { expect, it } from 'vitest';

async function dependencies(entry: string, platform: 'node' | 'browser' = 'node') {
  const result = await build({
    entryPoints: [path.resolve(entry)],
    bundle: true,
    write: false,
    format: 'esm',
    platform,
    ...(platform === 'node' ? { packages: 'external' as const } : {}),
    metafile: true,
  });
  return Object.keys(result.metafile!.inputs).map(file => file.replaceAll('\\', '/'));
}

it.each(['agent-team', 'runtime-services'])(
  '%s bundles without application implementation',
  async id => {
    const inputs = await dependencies(`plugins/extensions/${id}/index.ts`);
    expect(inputs.some(file => file.startsWith('src/'))).toBe(false);
    expect(inputs.some(file => file.startsWith('plugins/extensions/agent-team/host/'))).toBe(
      false,
    );
    if (id === 'runtime-services')
      expect(inputs.some(file => file.startsWith('plugins/extensions/agent-team/'))).toBe(false);
    expect(inputs.some(file => file.startsWith('plugins/extensions/agent-team/browser/'))).toBe(
      false,
    );
    const historyModules = [
      'collaboration/collaboration-history.ts',
      'discussion/discussion-history.ts',
    ];
    for (const module of historyModules)
      expect(inputs.includes(`plugins/extensions/agent-team/${module}`)).toBe(id === 'agent-team');
    expect(
      inputs.includes(
        'plugins/extensions/runtime-services/agent-team/collaboration/managed-peer-send-guard.ts',
      ),
    ).toBe(id === 'runtime-services');
    expect(
      inputs.includes(
        'plugins/extensions/runtime-services/agent-team/discussion/discussion-offline-control.ts',
      ),
    ).toBe(id === 'runtime-services');
  },
);

it.each([
  'collaboration',
  'teamDiscussion',
  'agentTeamSettings',
  'agentTeamPrompt',
  'agentTeamLaunchText',
  'collaborationContinuationPrompt',
])('application contract %s remains safe for the renderer', async name => {
  const inputs = await dependencies(`plugins/extensions/agent-team/app/contracts/${name}.ts`, 'browser');
  expect(inputs.some(file => file.startsWith('src/main/'))).toBe(false);
  expect(
    inputs
      .filter(file => file.startsWith('plugins/extensions/'))
      .every(file => /\/(contracts|prompt)\//.test(file)),
  ).toBe(true);
});

it.each(['collaboration', 'teamDiscussion', 'agentTeamLaunch'])(
  '%s coordination has no Electron IPC dependency',
  async name => {
    const result = await build({
      entryPoints: [path.resolve(`plugins/extensions/agent-team/host/${{collaboration:'collaboration',teamDiscussion:'discussion',agentTeamLaunch:'launch'}[name]}/${name}Coordinator.ts`)],
      bundle: true,
      write: false,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      metafile: true,
    });
    const imports = Object.values(result.metafile!.inputs).flatMap(input => input.imports);
    expect(imports.some(item => item.path === 'electron')).toBe(false);
    expect(imports.some(item => item.path.startsWith('openclaw/plugin-sdk'))).toBe(false);
    const inputs = Object.keys(result.metafile!.inputs).map(file => file.replaceAll('\\', '/'));
    expect(inputs.filter(file => file.startsWith('src/'))).toEqual([]);
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
  const inputs = await dependencies(`plugins/extensions/agent-team/host/${module}.ts`);
  expect(inputs.some(file => file.startsWith('src/'))).toBe(false);
  expect(inputs.includes(`plugins/extensions/agent-team/host/${module}.ts`)).toBe(true);
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
    `plugins/extensions/agent-team/browser/${module}.ts`,
    'browser',
  );
  expect(inputs.some(file => file.startsWith('src/'))).toBe(false);
  expect(inputs.some(file => file.startsWith('plugins/extensions/agent-team/host/'))).toBe(false);
});
