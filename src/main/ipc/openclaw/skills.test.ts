import { beforeEach, expect, test, vi } from 'vitest';

import type { GatewaySkillEntry, GatewaySkillStatus } from '../../engine/types';
import { PluginInstallationService } from '../../plugins/installation';
import type { OpenClawSkillFiles, OpenClawSkillService } from '../../plugins/skills';

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
    getSkillFiles: () => ({ deleteDirectory }) as unknown as OpenClawSkillFiles,
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
    getSkillFiles: () => ({ deleteDirectory: vi.fn() }) as unknown as OpenClawSkillFiles,
    installationService: new PluginInstallationService(),
  });

  await expect(
    handlers.get('skills:delete')?.(undefined, { id: 'example', source: 'managed' }),
  ).resolves.toEqual({ success: false, error: 'Skill id and source are required' });
  expect(getStatus).not.toHaveBeenCalled();
});

test('does not delete a same-key skill from a different source', async () => {
  const skill = createSkill('openclaw-workspace');
  const deleteDirectory = vi.fn();

  registerSkillHandlers({
    skillService: {
      getStatus: vi.fn(async () => createStatus(skill)),
    } as unknown as OpenClawSkillService,
    getSkillFiles: () => ({ deleteDirectory }) as unknown as OpenClawSkillFiles,
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
    getSkillFiles: () => ({ deleteDirectory }) as unknown as OpenClawSkillFiles,
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
