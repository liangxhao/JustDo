import fs from 'fs';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { MarketplaceInstallOperation, PluginKind } from '../../../shared/plugins/marketplace';
import type { GatewaySkillEntry, GatewaySkillStatus } from '../../engine/types';
import { PluginInstallationService, PluginInstallOrigin } from '../../plugins/installation';
import { OpenClawSkillService } from '../../plugins/skills';
import { SkillStateConfirmationError } from '../../plugins/skills/openclawSkillService';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

import { registerSkillHandlers } from './skills';

const createSkill = (
  source: GatewaySkillEntry['source'],
  overrides: Partial<GatewaySkillEntry> = {},
): GatewaySkillEntry => ({
  name: 'Example skill',
  description: 'Example description',
  source,
  bundled: false,
  filePath: 'C:/skills/example/SKILL.md',
  baseDir: 'C:/skills/example',
  skillKey: 'example',
  always: false,
  eligible: true,
  disabled: false,
  blockedByAllowlist: false,
  missing: { bins: [], env: [], config: [], os: [] },
  install: [],
  configChecks: [],
  ...overrides,
});

const createStatus = (skill: GatewaySkillEntry): GatewaySkillStatus => ({
  workspaceDir: 'C:/workspace',
  managedSkillsDir: 'C:/skills',
  skills: [skill],
});

beforeEach(() => {
  handlers.clear();
  vi.restoreAllMocks();
});

afterEach(() => vi.useRealTimers());

test.each([
  'openclaw-managed',
  'openclaw-workspace',
  'agents-skills-project',
  'agents-skills-personal',
] as const)('deletes skills whose source is %s end to end', async source => {
  const skill = createSkill(source);
  const getStatus = vi
    .fn<() => Promise<GatewaySkillStatus>>()
    .mockResolvedValueOnce(createStatus(skill))
    .mockResolvedValueOnce({ ...createStatus(skill), skills: [] });
  const deleteDirectory = vi.fn();

  registerSkillHandlers({
    skillService: { getStatus } as unknown as OpenClawSkillService,
    skillFileService: { deleteDirectory },
    installationService: new PluginInstallationService(),
  });

  await expect(
    handlers.get('skills:delete')?.(undefined, {
      id: skill.skillKey,
      source,
    }),
  ).resolves.toMatchObject({ success: true, skills: [] });
  expect(deleteDirectory).toHaveBeenCalledWith(skill.baseDir);
});

test('rejects noncanonical source names', async () => {
  const getStatus = vi.fn();

  registerSkillHandlers({
    skillService: { getStatus } as unknown as OpenClawSkillService,
    skillFileService: { deleteDirectory: vi.fn() },
    installationService: new PluginInstallationService(),
  });

  await expect(
    handlers.get('skills:delete')?.(undefined, { id: 'example', source: 'managed' }),
  ).resolves.toEqual({ success: false, error: 'Skill id and source are required' });
  expect(getStatus).not.toHaveBeenCalled();
});

test('keeps committed skill deletion successful when the native status refresh fails', async () => {
  const removed = createSkill('openclaw-managed');
  const retained = createSkill('openclaw-workspace', {
    filePath: 'C:/workspace/skills/example/SKILL.md',
    baseDir: 'C:/workspace/skills/example',
  });
  const sibling = createSkill('openclaw-managed', {
    name: 'Unrelated skill',
    skillKey: 'sibling',
    filePath: 'C:/skills/sibling/SKILL.md',
    baseDir: 'C:/skills/sibling',
  });
  const getStatus = vi
    .fn<() => Promise<GatewaySkillStatus>>()
    .mockResolvedValueOnce({ ...createStatus(removed), skills: [removed, retained, sibling] })
    .mockRejectedValueOnce(new Error('Gateway not connected'));
  const deleteDirectory = vi.fn();
  const onMarketplacePluginDeleted = vi.fn();
  registerSkillHandlers({
    skillService: { getStatus } as unknown as OpenClawSkillService,
    skillFileService: { deleteDirectory },
    installationService: new PluginInstallationService(),
    onMarketplacePluginDeleted,
  });

  const result = await handlers.get('skills:delete')?.(undefined, {
    id: removed.skillKey,
    source: removed.source,
  });

  expect(result).toMatchObject({
    success: true,
    skills: [
      { id: retained.skillKey, source: retained.source, skillPath: retained.filePath },
      { id: sibling.skillKey, source: sibling.source, skillPath: sibling.filePath },
    ],
  });
  expect((result as { skills: unknown[] }).skills).toHaveLength(2);
  expect(deleteDirectory).toHaveBeenCalledExactlyOnceWith(removed.baseDir);
  expect(onMarketplacePluginDeleted).toHaveBeenCalledExactlyOnceWith(
    PluginKind.SKILL,
    removed.skillKey,
    removed.baseDir,
  );
  expect(getStatus).toHaveBeenCalledTimes(2);
});

test('reports an actual skill deletion failure without reading a replacement inventory', async () => {
  const skill = createSkill('openclaw-managed');
  const getStatus = vi.fn(async () => createStatus(skill));
  const deleteDirectory = vi.fn().mockRejectedValue(new Error('Directory is locked'));
  const onMarketplacePluginDeleted = vi.fn();
  registerSkillHandlers({
    skillService: { getStatus } as unknown as OpenClawSkillService,
    skillFileService: { deleteDirectory },
    installationService: new PluginInstallationService(),
    onMarketplacePluginDeleted,
  });

  await expect(
    handlers.get('skills:delete')?.(undefined, {
      id: skill.skillKey,
      source: skill.source,
    }),
  ).resolves.toEqual({ success: false, error: 'Directory is locked' });
  expect(getStatus).toHaveBeenCalledOnce();
  expect(onMarketplacePluginDeleted).not.toHaveBeenCalled();
});

test('refreshes native discovery after a successful archive import', async () => {
  const skill = createSkill('openclaw-managed');
  const requestGateway = vi.fn().mockResolvedValueOnce(createStatus(skill));
  const importPath = vi.fn().mockResolvedValue({ success: true, skillId: skill.name });
  registerSkillHandlers({
    skillService: new OpenClawSkillService(
      () => ({ requestGateway }),
      () => ({ request: requestGateway }),
    ),
    skillFileService: {
      importPath,
      deleteDirectory: vi.fn(),
      getManagedSkillPath: () => skill.baseDir,
    },
    installationService: new PluginInstallationService(),
  });

  await expect(
    handlers.get('skills:import')?.(undefined, 'C:/imports/skill.zip'),
  ).resolves.toMatchObject({ success: true, skillId: skill.name });

  expect(importPath).toHaveBeenCalledExactlyOnceWith('C:/imports/skill.zip');
  expect(requestGateway).toHaveBeenCalledExactlyOnceWith(
    'skills.status',
    { agentId: 'main' },
    expect.any(Object),
  );
});

test('keeps successful imports successful if native discovery is disconnected', async () => {
  const requestGateway = vi.fn().mockRejectedValue(new Error('Gateway disconnected'));
  const importPath = vi.fn().mockResolvedValue({ success: true, skillId: 'example' });
  registerSkillHandlers({
    skillService: new OpenClawSkillService(
      () => ({ requestGateway }),
      () => ({ request: requestGateway }),
    ),
    skillFileService: {
      importPath,
      deleteDirectory: vi.fn(),
      getManagedSkillPath: () => 'C:/skills/example',
    },
    installationService: new PluginInstallationService(),
  });

  await expect(
    handlers.get('skills:import')?.(undefined, 'C:/imports/skill.zip'),
  ).resolves.toMatchObject({ success: true, skillId: 'example' });
  expect(importPath).toHaveBeenCalledOnce();
});

test('returns the authoritative same-name fallback from refreshed native discovery after deletion', async () => {
  const removed = createSkill('openclaw-managed');
  const fallback = createSkill('openclaw-bundled', {
    bundled: true,
    baseDir: 'C:/runtime/skills/example',
    filePath: 'C:/runtime/skills/example/SKILL.md',
  });
  const requestGateway = vi
    .fn()
    .mockResolvedValueOnce(createStatus(removed))
    .mockResolvedValueOnce(createStatus(fallback));
  const deleteDirectory = vi.fn();
  registerSkillHandlers({
    skillService: new OpenClawSkillService(
      () => ({ requestGateway }),
      () => ({ request: requestGateway }),
    ),
    skillFileService: { deleteDirectory },
    installationService: new PluginInstallationService(),
  });

  await expect(
    handlers.get('skills:delete')?.(undefined, {
      id: removed.skillKey,
      source: removed.source,
    }),
  ).resolves.toMatchObject({
    success: true,
    skills: [{ source: fallback.source, skillPath: fallback.filePath }],
  });
  expect(deleteDirectory).toHaveBeenCalledExactlyOnceWith(removed.baseDir);
  expect(requestGateway).toHaveBeenNthCalledWith(
    2,
    'skills.status',
    { agentId: 'main' },
    expect.any(Object),
  );
});

test('preserves a same-directory skill reimported by another operation before deletion refresh', async () => {
  vi.spyOn(fs, 'existsSync').mockReturnValue(true);
  const removed = createSkill('openclaw-managed');
  const reimported = createSkill('openclaw-managed', { description: 'New incarnation' });
  const requestGateway = vi
    .fn()
    .mockResolvedValueOnce(createStatus(removed))
    .mockResolvedValueOnce(createStatus(reimported));
  const deleteDirectory = vi.fn();
  registerSkillHandlers({
    skillService: new OpenClawSkillService(
      () => ({ requestGateway }),
      () => ({ request: requestGateway }),
    ),
    skillFileService: { deleteDirectory },
    installationService: new PluginInstallationService(),
  });

  await expect(
    handlers.get('skills:delete')?.(undefined, {
      id: removed.skillKey,
      source: removed.source,
    }),
  ).resolves.toMatchObject({ success: true, skills: [{ description: 'New incarnation' }] });
  expect(deleteDirectory).toHaveBeenCalledOnce();
});

test('does not restore a deleted skill from the native watcher cache before discovery catches up', async () => {
  vi.spyOn(fs, 'existsSync').mockReturnValue(false);
  const removed = createSkill('openclaw-managed');
  const getStatus = vi.fn().mockResolvedValue(createStatus(removed));
  const deleteDirectory = vi.fn();
  registerSkillHandlers({
    skillService: { getStatus } as unknown as OpenClawSkillService,
    skillFileService: { deleteDirectory },
    installationService: new PluginInstallationService(),
  });

  await expect(
    handlers.get('skills:delete')!(undefined, { id: removed.skillKey, source: removed.source }),
  ).resolves.toMatchObject({ success: true, skills: [] });
  expect(deleteDirectory).toHaveBeenCalledExactlyOnceWith(removed.baseDir);
  expect(getStatus).toHaveBeenCalledTimes(2);
  expect(getStatus).toHaveBeenLastCalledWith(undefined, { connectedOnly: true });
});

test('inventory reads use an existing connection without entering Gateway startup', async () => {
  const requestGateway = vi.fn();
  registerSkillHandlers({
    skillService: new OpenClawSkillService(() => ({ requestGateway })),
    skillFileService: { deleteDirectory: vi.fn() },
    installationService: new PluginInstallationService(),
  });
  await expect(handlers.get('skills:list')!()).resolves.toMatchObject({
    success: false,
    gatewayOffline: true,
  });
  expect(requestGateway).not.toHaveBeenCalled();
});

test('serializes file mutations through native inventory convergence across callers', async () => {
  const skill = createSkill('openclaw-managed');
  let finishRefresh!: (status: GatewaySkillStatus) => void;
  const getStatus = vi
    .fn()
    .mockResolvedValueOnce(createStatus(skill))
    .mockReturnValueOnce(
      new Promise(resolve => {
        finishRefresh = resolve;
      }),
    )
    .mockResolvedValue(createStatus(skill));
  const importPath = vi.fn().mockResolvedValue({ success: true, skillId: skill.name });
  registerSkillHandlers({
    skillService: { getStatus } as unknown as OpenClawSkillService,
    skillFileService: { importPath, deleteDirectory: vi.fn() },
    installationService: new PluginInstallationService(),
  });
  const deletion = handlers.get('skills:delete')!(undefined, {
    id: skill.skillKey,
    source: skill.source,
  });
  await vi.waitFor(() => expect(getStatus).toHaveBeenCalledTimes(2));
  const importing = handlers.get('skills:import')!(undefined, 'C:/imports/skill.zip');
  await Promise.resolve();
  expect(importPath).not.toHaveBeenCalled();

  finishRefresh({ ...createStatus(skill), skills: [] });

  await expect(deletion).resolves.toMatchObject({ success: true, skills: [] });
  await expect(importing).resolves.toMatchObject({ success: true });
  expect(importPath).toHaveBeenCalledOnce();
});

test('returns the skill import validation error to the renderer', async () => {
  const importPath = vi.fn(async () => ({
    success: false,
    error:
      'SKILL.md "name" must be 1-64 characters and contain only lowercase letters, numbers, and single hyphens.',
  }));

  registerSkillHandlers({
    skillService: {} as OpenClawSkillService,
    skillFileService: { importPath },
    installationService: new PluginInstallationService(),
  });

  await expect(
    handlers.get('skills:import')?.(undefined, 'C:/skills/invalid-skill'),
  ).resolves.toEqual({
    success: false,
    skillId: undefined,
    error:
      'SKILL.md "name" must be 1-64 characters and contain only lowercase letters, numbers, and single hyphens.',
  });
  expect(importPath).toHaveBeenCalledWith('C:/skills/invalid-skill');
});

test('does not delete a same-key skill from a different source', async () => {
  const skill = createSkill('openclaw-workspace');
  const deleteDirectory = vi.fn();

  registerSkillHandlers({
    skillService: {
      getStatus: vi.fn(async () => createStatus(skill)),
    } as unknown as OpenClawSkillService,
    skillFileService: { deleteDirectory },
    installationService: new PluginInstallationService(),
  });

  await expect(
    handlers.get('skills:delete')?.(undefined, {
      id: skill.skillKey,
      source: 'openclaw-managed',
    }),
  ).resolves.toEqual({ success: false, error: 'Only user-owned skills can be deleted' });
  expect(deleteDirectory).not.toHaveBeenCalled();
});

test('does not delete bundled skills even when their source looks user-owned', async () => {
  const skill = createSkill('openclaw-managed', { bundled: true });
  const deleteDirectory = vi.fn();

  registerSkillHandlers({
    skillService: {
      getStatus: vi.fn(async () => createStatus(skill)),
    } as unknown as OpenClawSkillService,
    skillFileService: { deleteDirectory },
    installationService: new PluginInstallationService(),
  });

  await expect(
    handlers.get('skills:delete')?.(undefined, {
      id: skill.skillKey,
      source: skill.source,
    }),
  ).resolves.toEqual({ success: false, error: 'Only user-owned skills can be deleted' });
  expect(deleteDirectory).not.toHaveBeenCalled();
});

test('returns scope and action capabilities with the authoritative skill list', async () => {
  const skill = createSkill('openclaw-custodian', { bundled: true });
  registerSkillHandlers({
    skillService: {
      getStatus: vi.fn(async () => createStatus(skill)),
    } as unknown as OpenClawSkillService,
    skillFileService: { deleteDirectory: vi.fn() },
    installationService: new PluginInstallationService(),
  });

  const result = await handlers.get('skills:list')?.();

  expect(result).toMatchObject({
    success: true,
    skills: [
      {
        id: 'example',
        scope: 'system',
        management: {
          disable: { allowed: true },
          remove: { allowed: false, reason: 'managed-by-system' },
        },
      },
    ],
  });
});

test('marks generated plugin skills as plugin managed instead of other source', async () => {
  const skill = createSkill('openclaw-extra', {
    filePath: 'C:/state/plugin-skills/browser-automation/SKILL.md',
    baseDir: 'C:/state/plugin-skills/browser-automation',
  });
  registerSkillHandlers({
    skillService: {
      getStatus: vi.fn(async () => createStatus(skill)),
    } as unknown as OpenClawSkillService,
    skillFileService: { deleteDirectory: vi.fn() },
    installationService: new PluginInstallationService(),
  });

  const result = await handlers.get('skills:list')?.();

  expect(result).toMatchObject({
    success: true,
    skills: [
      {
        scope: 'extension',
        ownershipScope: 'personal',
        management: {
          disable: { allowed: false, reason: 'managed-by-extension' },
          remove: { allowed: false, reason: 'managed-by-extension' },
        },
      },
    ],
  });
});

test('allows enabling configuration for a skill with missing runtime requirements', async () => {
  const skill = createSkill('openclaw-managed', { eligible: false, disabled: true });
  const getStatus = vi
    .fn(async () => createStatus({ ...skill, disabled: false }))
    .mockResolvedValueOnce(createStatus(skill));
  const updateConfig = vi.fn(async () => ({ ok: true }));
  registerSkillHandlers({
    skillService: {
      getStatus,
      updateConfig,
      waitForEnabledStatus: OpenClawSkillService.prototype.waitForEnabledStatus,
    } as unknown as OpenClawSkillService,
    skillFileService: { deleteDirectory: vi.fn() },
    installationService: new PluginInstallationService(),
  });

  await expect(
    handlers.get('skills:setEnabled')?.(undefined, { id: skill.skillKey, enabled: true }),
  ).resolves.toMatchObject({ success: true, skills: [{ enabled: true, eligible: false }] });
  expect(updateConfig).toHaveBeenCalledWith({ skillKey: skill.skillKey, enabled: true });
});

test('reports an opt-in skill as disabled until its native enable requirement is satisfied', async () => {
  const skill = createSkill('openclaw-bundled', {
    name: 'coding-agent',
    skillKey: 'coding-agent',
    bundled: true,
    eligible: false,
    disabled: false,
    missing: {
      bins: [],
      anyBins: ['claude', 'codex', 'opencode'],
      env: [],
      config: ['skills.entries.coding-agent.enabled'],
      os: [],
    },
  });
  const getStatus = vi.fn(async () => createStatus(skill));
  const updateConfig = vi.fn(async () => ({ ok: true }));
  registerSkillHandlers({
    skillService: {
      getStatus,
      updateConfig,
      waitForEnabledStatus: OpenClawSkillService.prototype.waitForEnabledStatus,
    } as unknown as OpenClawSkillService,
    skillFileService: { deleteDirectory: vi.fn() },
    installationService: new PluginInstallationService(),
  });

  await expect(handlers.get('skills:list')?.()).resolves.toMatchObject({
    skills: [{ enabled: false, management: { enable: { allowed: true } } }],
  });
  getStatus.mockResolvedValueOnce(createStatus(skill)).mockResolvedValueOnce(
    createStatus({
      ...skill,
      eligible: false,
      missing: {
        bins: [],
        anyBins: ['claude', 'codex', 'opencode'],
        env: [],
        config: [],
        os: [],
      },
    }),
  );

  await expect(
    handlers.get('skills:setEnabled')?.(undefined, { id: 'coding-agent', enabled: true }),
  ).resolves.toMatchObject({
    skills: [
      {
        enabled: true,
        eligible: false,
        missing: { anyBins: ['claude', 'codex', 'opencode'] },
      },
    ],
  });
  expect(updateConfig).toHaveBeenCalledWith({ skillKey: 'coding-agent', enabled: true });
});

test('does not return the old switch state or admit a second mutation before native publication', async () => {
  let disabled = false;
  let publish!: () => void;
  const saved = new Promise<void>(resolve => {
    publish = resolve;
  });
  const skill = createSkill('openclaw-managed');
  const getStatus = vi.fn(async () => createStatus({ ...skill, disabled }));
  const updateConfig = vi.fn(async () => ({ ok: true }));
  const waitForEnabledStatus = vi.fn(async () => {
    await saved;
    return createStatus({ ...skill, disabled });
  });
  const deleteDirectory = vi.fn();
  registerSkillHandlers({
    skillService: {
      getStatus,
      updateConfig,
      waitForEnabledStatus,
    } as unknown as OpenClawSkillService,
    skillFileService: { deleteDirectory },
    installationService: new PluginInstallationService(),
  });
  const settled = vi.fn();
  const disabling = Promise.resolve(
    handlers.get('skills:setEnabled')?.(undefined, { id: skill.skillKey, enabled: false }),
  ).then(settled);
  const deletion = handlers.get('skills:delete')?.(undefined, {
    id: skill.skillKey,
    source: skill.source,
  });
  await vi.waitFor(() => expect(waitForEnabledStatus).toHaveBeenCalledOnce());

  expect(settled).not.toHaveBeenCalled();
  expect(deleteDirectory).not.toHaveBeenCalled();
  expect(waitForEnabledStatus).toHaveBeenCalledWith(skill.skillKey, false);
  disabled = true;
  publish();
  await disabling;
  await deletion;

  expect(settled).toHaveBeenCalledWith(
    expect.objectContaining({
      success: true,
      skills: [expect.objectContaining({ enabled: false })],
    }),
  );
  expect(updateConfig).toHaveBeenCalledOnce();
  expect(deleteDirectory).toHaveBeenCalledOnce();
});

test('reports a saved setting as unconfirmed instead of returning a stale successful inventory', async () => {
  const skill = createSkill('openclaw-managed');
  const updateConfig = vi.fn(async () => ({ ok: true }));
  registerSkillHandlers({
    skillService: {
      getStatus: vi.fn(async () => createStatus(skill)),
      updateConfig,
      waitForEnabledStatus: vi.fn().mockRejectedValue(new Error('Saved but not applied')),
    } as unknown as OpenClawSkillService,
    skillFileService: { deleteDirectory: vi.fn() },
    installationService: new PluginInstallationService(),
  });

  await expect(
    handlers.get('skills:setEnabled')?.(undefined, { id: skill.skillKey, enabled: false }),
  ).resolves.toMatchObject({ success: false, error: 'Saved but not applied' });
  expect(updateConfig).toHaveBeenCalledOnce();
});

test('preserves the saved-setting notice and offline state when confirmation disconnects', async () => {
  const skill = createSkill('openclaw-managed');
  const updateConfig = vi.fn(async () => ({ ok: true }));
  registerSkillHandlers({
    skillService: {
      getStatus: vi.fn(async () => createStatus(skill)),
      updateConfig,
      waitForEnabledStatus: vi
        .fn()
        .mockRejectedValue(new SkillStateConfirmationError(new Error('Gateway not connected'))),
    } as unknown as OpenClawSkillService,
    skillFileService: { deleteDirectory: vi.fn() },
    installationService: new PluginInstallationService(),
  });

  await expect(
    handlers.get('skills:setEnabled')?.(undefined, { id: skill.skillKey, enabled: false }),
  ).resolves.toMatchObject({
    success: false,
    error: expect.stringMatching(/已保存|was saved/),
    gatewayOffline: true,
  });
  expect(updateConfig).toHaveBeenCalledOnce();
});

test('serializes opposite toggles for the same skill until each native state is confirmed', async () => {
  let disabled = false;
  const publications: Array<() => void> = [];
  const skill = createSkill('openclaw-managed');
  const getStatus = vi.fn(async () => createStatus({ ...skill, disabled }));
  const updateConfig = vi.fn(async () => ({ ok: true }));
  const waitForEnabledStatus = vi.fn(
    async (_id: string, enabled: boolean): Promise<GatewaySkillStatus> => {
      await new Promise<void>(resolve => {
        publications.push(() => {
          disabled = !enabled;
          resolve();
        });
      });
      return createStatus({ ...skill, disabled });
    },
  );
  registerSkillHandlers({
    skillService: {
      getStatus,
      updateConfig,
      waitForEnabledStatus,
    } as unknown as OpenClawSkillService,
    skillFileService: { deleteDirectory: vi.fn() },
    installationService: new PluginInstallationService(),
  });

  const disabling = handlers.get('skills:setEnabled')!(undefined, {
    id: skill.skillKey,
    enabled: false,
  });
  const enabling = handlers.get('skills:setEnabled')!(undefined, {
    id: skill.skillKey,
    enabled: true,
  });
  await vi.waitFor(() => expect(publications).toHaveLength(1));
  expect(updateConfig).toHaveBeenCalledExactlyOnceWith({
    skillKey: skill.skillKey,
    enabled: false,
  });
  publications[0]();
  await expect(disabling).resolves.toMatchObject({
    success: true,
    skills: [{ enabled: false }],
  });
  await vi.waitFor(() => expect(publications).toHaveLength(2));
  expect(updateConfig).toHaveBeenNthCalledWith(2, { skillKey: skill.skillKey, enabled: true });
  publications[1]();
  await expect(enabling).resolves.toMatchObject({
    success: true,
    skills: [{ enabled: true }],
  });

  expect(updateConfig).toHaveBeenCalledTimes(2);
  expect(waitForEnabledStatus.mock.calls).toEqual([
    [skill.skillKey, false],
    [skill.skillKey, true],
  ]);
});

test('releases the mutation lane after failed confirmation without replaying the saved write', async () => {
  let finishFirst!: () => void;
  const skill = createSkill('openclaw-managed');
  const getStatus = vi.fn(async () => createStatus(skill));
  const updateConfig = vi.fn(async () => ({ ok: true }));
  const waitForEnabledStatus = vi
    .fn()
    .mockImplementationOnce(async () => {
      await new Promise<void>(resolve => {
        finishFirst = resolve;
      });
      throw new SkillStateConfirmationError(new Error('Gateway not connected'));
    })
    .mockResolvedValueOnce(createStatus(skill));
  registerSkillHandlers({
    skillService: {
      getStatus,
      updateConfig,
      waitForEnabledStatus,
    } as unknown as OpenClawSkillService,
    skillFileService: { deleteDirectory: vi.fn() },
    installationService: new PluginInstallationService(),
  });

  const disabling = handlers.get('skills:setEnabled')!(undefined, {
    id: skill.skillKey,
    enabled: false,
  });
  const enabling = handlers.get('skills:setEnabled')!(undefined, {
    id: skill.skillKey,
    enabled: true,
  });
  await vi.waitFor(() => expect(waitForEnabledStatus).toHaveBeenCalledOnce());
  expect(updateConfig).toHaveBeenCalledOnce();
  finishFirst();

  await expect(disabling).resolves.toMatchObject({
    success: false,
    gatewayOffline: true,
    error: expect.stringMatching(/已保存|was saved/),
  });
  await expect(enabling).resolves.toMatchObject({ success: true, skills: [{ enabled: true }] });
  expect(updateConfig.mock.calls).toEqual([
    [{ skillKey: skill.skillKey, enabled: false }],
    [{ skillKey: skill.skillKey, enabled: true }],
  ]);
  expect(waitForEnabledStatus).toHaveBeenCalledTimes(2);
});

test('recovers a transient confirmation read without asking for a refresh or repeating the native update', async () => {
  vi.useFakeTimers();
  const skill = createSkill('openclaw-managed');
  const requestGateway = vi.fn(async (method: string) =>
    method === 'skills.status' ? createStatus(skill) : { ok: true },
  );
  const request = vi
    .fn()
    .mockRejectedValueOnce(new Error('Gateway disconnected'))
    .mockResolvedValueOnce(createStatus({ ...skill, disabled: true }));
  registerSkillHandlers({
    skillService: new OpenClawSkillService(
      () => ({ requestGateway }),
      () => ({ request }),
    ),
    skillFileService: { deleteDirectory: vi.fn() },
    installationService: new PluginInstallationService(),
  });
  const switching = handlers.get('skills:setEnabled')!(undefined, {
    id: skill.skillKey,
    enabled: false,
  });

  await vi.advanceTimersByTimeAsync(1_000);

  await expect(switching).resolves.toMatchObject({ success: true, skills: [{ enabled: false }] });
  expect(requestGateway.mock.calls.map(call => call[0])).toEqual([
    'skills.status',
    'skills.update',
  ]);
  expect(request.mock.calls.map(call => call[0])).toEqual(['skills.status', 'skills.status']);
});

test('keeps an enabled skill enabled when unrelated requirements are missing', async () => {
  const skill = createSkill('openclaw-bundled', {
    eligible: false,
    missing: { bins: ['git'], env: [], config: ['tools.enabled'], os: [] },
  });
  registerSkillHandlers({
    skillService: {
      getStatus: vi.fn(async () => createStatus(skill)),
    } as unknown as OpenClawSkillService,
    skillFileService: { deleteDirectory: vi.fn() },
    installationService: new PluginInstallationService(),
  });

  await expect(handlers.get('skills:list')?.()).resolves.toMatchObject({
    skills: [{ enabled: true, eligible: false }],
  });
});

test.each([PluginInstallOrigin.CUSTOM, PluginInstallOrigin.MARKETPLACE])(
  'only relinquishes market ownership for a committed local skill replacement: %s',
  async origin => {
    const installationService = new PluginInstallationService();
    const forget = vi.fn();
    registerSkillHandlers({
      skillService: {
        getStatus: vi.fn(async () => createStatus(createSkill('openclaw-managed'))),
      } as unknown as OpenClawSkillService,
      skillFileService: {
        importPath: vi.fn(async () => ({ success: true, skillId: 'example' })),
        deleteDirectory: vi.fn(),
        getManagedSkillPath: () => 'C:/skills/example',
      },
      installationService,
      onMarketplacePluginDeleted: forget,
    });
    await installationService.install({
      operation: MarketplaceInstallOperation.INSTALL,
      origin,
      payload: { kind: PluginKind.SKILL, sourcePath: 'C:/source' },
    });
    if (origin === PluginInstallOrigin.CUSTOM)
      expect(forget).toHaveBeenCalledWith(PluginKind.SKILL, 'example', 'C:/skills/example');
    else expect(forget).not.toHaveBeenCalled();
  },
);
