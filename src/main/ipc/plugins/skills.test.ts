import { beforeEach, expect, test, vi } from 'vitest';

import type { GatewaySkillEntry, GatewaySkillStatus } from '../../engine/types';
import { PluginInstallationService } from '../../plugins/installation';
import type { OpenClawSkillService } from '../../plugins/skills';

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
  const updateConfig = vi.fn(async () => ({ ok: true }));
  registerSkillHandlers({
    skillService: {
      getStatus: vi.fn(async () => createStatus(skill)),
      updateConfig,
    } as unknown as OpenClawSkillService,
    skillFileService: { deleteDirectory: vi.fn() },
    installationService: new PluginInstallationService(),
  });

  await expect(
    handlers.get('skills:setEnabled')?.(undefined, { id: skill.skillKey, enabled: true }),
  ).resolves.toMatchObject({ success: true });
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
    skillService: { getStatus, updateConfig } as unknown as OpenClawSkillService,
    skillFileService: { deleteDirectory: vi.fn() },
    installationService: new PluginInstallationService(),
  });

  await expect(handlers.get('skills:list')?.()).resolves.toMatchObject({
    skills: [{ enabled: false, management: { enable: { allowed: true } } }],
  });
  getStatus
    .mockResolvedValueOnce(createStatus(skill))
    .mockResolvedValueOnce(
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
    skills: [{
      enabled: true,
      eligible: false,
      missing: { anyBins: ['claude', 'codex', 'opencode'] },
    }],
  });
  expect(updateConfig).toHaveBeenCalledWith({ skillKey: 'coding-agent', enabled: true });
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
