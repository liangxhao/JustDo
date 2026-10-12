import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { Skill } from './skill';

const skill = {
  id: 'example',
  name: 'example',
  source: 'openclaw-managed',
  skillPath: 'C:/skills/example/SKILL.md',
} as Skill;
const api = { list: vi.fn(), importPath: vi.fn(), delete: vi.fn(), setEnabled: vi.fn() };

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubGlobal('window', { electron: { skills: api } });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>(finish => {
    resolve = finish;
  });
  return { promise, resolve };
}

test('reports inventory failure independently of Gateway connectivity and clears it after recovery', async () => {
  api.list
    .mockResolvedValueOnce({ success: false, gatewayOffline: false, error: 'RPC timeout' })
    .mockResolvedValueOnce({ success: true, skills: [skill] });
  const { skillService } = await import('./skillService');

  await skillService.loadSkills();
  expect(skillService.isGatewayOffline()).toBe(false);
  expect(skillService.hasInventoryReadFailed()).toBe(true);

  await skillService.loadSkills();
  expect(skillService.hasInventoryReadFailed()).toBe(false);
  expect(skillService.getSkills()).toEqual([skill]);
});

test('automatically rereads native inventory after import within a five-second window', async () => {
  vi.useFakeTimers();
  api.list.mockResolvedValue({ success: true, skills: [] });
  api.importPath.mockResolvedValue({ success: true, skillId: skill.id });
  const { skillService } = await import('./skillService');
  const changed = vi.fn();
  const stop = skillService.subscribeInventory(changed);
  await skillService.importSkill('C:/imports/example.zip');
  await vi.advanceTimersByTimeAsync(1_400);
  expect(api.list).toHaveBeenCalledTimes(3);
  api.list.mockResolvedValue({ success: true, skills: [skill] });
  await vi.advanceTimersByTimeAsync(3_600);
  expect(changed).toHaveBeenLastCalledWith([skill]);
  expect(api.list).toHaveBeenCalledTimes(5);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(api.list).toHaveBeenCalledTimes(5);
  expect(api.importPath).toHaveBeenCalledOnce();
  stop();
});

test('a newer list during deletion cannot restore its cached row before the watcher catches up', async () => {
  vi.useFakeTimers();
  api.list.mockResolvedValue({ success: true, skills: [skill] });
  const reply = deferred<{ success: boolean; skills: Skill[] }>();
  api.delete.mockReturnValue(reply.promise);
  const { skillService } = await import('./skillService');
  await skillService.loadSkills();
  const changed = vi.fn();
  const stop = skillService.subscribeInventory(changed);
  const deletion = skillService.deleteSkill(skill.id, skill.source);
  await skillService.loadSkills({ force: true });
  reply.resolve({ success: true, skills: [] });
  await expect(deletion).resolves.toEqual({ success: true, skills: [] });
  await vi.advanceTimersByTimeAsync(200);
  expect(skillService.getSkills()).toEqual([]);
  const fallback = {
    ...skill,
    source: 'openclaw-bundled',
    skillPath: 'C:/runtime/skills/example/SKILL.md',
  } as Skill;
  api.list.mockResolvedValue({ success: true, skills: [fallback] });
  await vi.advanceTimersByTimeAsync(400);
  expect(changed).toHaveBeenLastCalledWith([fallback]);
  expect(api.delete).toHaveBeenCalledOnce();
  stop();
});

test('a switch inventory keeps the confirmed deletion projection and same-path reimports are visible after its bounded lifetime', async () => {
  vi.useFakeTimers();
  const other = { ...skill, id: 'other', skillPath: 'C:/skills/other/SKILL.md' };
  api.list.mockResolvedValue({ success: true, skills: [skill, other] });
  api.delete.mockResolvedValue({ success: true, skills: [other] });
  api.setEnabled.mockResolvedValue({
    success: true,
    skills: [skill, { ...other, enabled: false }],
  });
  const { skillService } = await import('./skillService');
  await skillService.loadSkills();
  const stop = skillService.subscribeInventory(vi.fn());
  await skillService.deleteSkill(skill.id, skill.source);
  await expect(skillService.setSkillEnabled(other.id, false)).resolves.toEqual([
    { ...other, enabled: false },
  ]);
  const reimported = { ...skill, description: 'External reimport' };
  api.list.mockResolvedValue({ success: true, skills: [reimported, other] });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(skillService.getSkills()).toEqual([reimported, other]);
  expect(api.delete).toHaveBeenCalledOnce();
  stop();
});

test('unmounting the last consumer cancels scheduled inventory retries', async () => {
  vi.useFakeTimers();
  api.importPath.mockResolvedValue({ success: true, skillId: skill.id });
  api.list.mockResolvedValue({ success: true, skills: [skill] });
  const { skillService } = await import('./skillService');
  const stop = skillService.subscribeInventory(vi.fn());
  await skillService.importSkill('C:/imports/example.zip');
  stop();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(api.list).not.toHaveBeenCalled();
  expect(api.importPath).toHaveBeenCalledOnce();
});

test('does not reuse a list read started before an archive import', async () => {
  let finishOld!: (result: { success: boolean; skills: Skill[] }) => void;
  api.list
    .mockReturnValueOnce(
      new Promise(resolve => {
        finishOld = resolve;
      }),
    )
    .mockResolvedValueOnce({ success: true, skills: [skill] });
  api.importPath.mockResolvedValue({ success: true, skillId: skill.id });
  const { skillService } = await import('./skillService');
  const oldLoad = skillService.loadSkills();

  await skillService.importSkill('C:/imports/example.zip');
  await expect(skillService.loadSkills({ force: true })).resolves.toEqual([skill]);
  finishOld({ success: true, skills: [] });

  await expect(oldLoad).resolves.toEqual([skill]);
  expect(skillService.getSkills()).toEqual([skill]);
  expect(api.list).toHaveBeenCalledTimes(2);
});

test('a delayed list response cannot restore a skill after confirmed deletion', async () => {
  api.list.mockResolvedValueOnce({ success: true, skills: [skill] });
  const { skillService } = await import('./skillService');
  await skillService.loadSkills();
  let finishOld!: (result: { success: boolean; skills: Skill[] }) => void;
  api.list.mockReturnValueOnce(
    new Promise(resolve => {
      finishOld = resolve;
    }),
  );
  api.delete.mockResolvedValue({ success: true, skills: [] });
  const oldLoad = skillService.loadSkills();

  await skillService.deleteSkill(skill.id, skill.source);
  finishOld({ success: true, skills: [skill] });

  await expect(oldLoad).resolves.toEqual([]);
  expect(skillService.getSkills()).toEqual([]);
});

test('a superseded failed list read cannot mark a fresh inventory offline', async () => {
  let rejectOld!: (error: Error) => void;
  api.list
    .mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectOld = reject;
      }),
    )
    .mockResolvedValueOnce({ success: true, skills: [skill] });
  const { skillService } = await import('./skillService');
  const oldLoad = skillService.loadSkills();

  await skillService.loadSkills({ force: true });
  rejectOld(new Error('Gateway disconnected'));

  await expect(oldLoad).resolves.toEqual([skill]);
  expect(skillService.isGatewayOffline()).toBe(false);
});

test('coalesces concurrent ordinary list reads', async () => {
  api.list.mockResolvedValue({ success: true, skills: [skill] });
  const { skillService } = await import('./skillService');

  await expect(
    Promise.all([skillService.loadSkills(), skillService.loadSkills()]),
  ).resolves.toEqual([[skill], [skill]]);
  expect(api.list).toHaveBeenCalledOnce();
});

test('a delayed deletion inventory cannot overwrite a newer confirmed import', async () => {
  let finishDelete!: (result: { success: boolean; skills: Skill[] }) => void;
  const newer = { ...skill, description: 'Reimported version' };
  api.list.mockResolvedValue({ success: true, skills: [newer] });
  api.delete.mockReturnValue(
    new Promise(resolve => {
      finishDelete = resolve;
    }),
  );
  api.importPath.mockResolvedValue({ success: true, skillId: skill.id });
  const { skillService } = await import('./skillService');
  const deletion = skillService.deleteSkill(skill.id, skill.source);

  await skillService.importSkill('C:/imports/example.zip');
  await skillService.loadSkills({ force: true });
  finishDelete({ success: true, skills: [] });

  await expect(deletion).resolves.toEqual({ success: true, skills: [newer] });
  expect(skillService.getSkills()).toEqual([newer]);
});

test('a delayed list cannot restore the prior switch state after a confirmed change', async () => {
  const disabled = { ...skill, enabled: false };
  let finishOld!: (result: { success: boolean; skills: Skill[] }) => void;
  api.list.mockReturnValueOnce(
    new Promise(resolve => {
      finishOld = resolve;
    }),
  );
  api.setEnabled.mockResolvedValue({ success: true, skills: [disabled] });
  const { skillService } = await import('./skillService');
  const oldRead = skillService.loadSkills();

  await expect(skillService.setSkillEnabled(skill.id, false)).resolves.toEqual([disabled]);
  finishOld({ success: true, skills: [{ ...skill, enabled: true }] });

  await expect(oldRead).resolves.toEqual([disabled]);
  expect(skillService.getSkills()).toEqual([disabled]);
  expect(api.setEnabled).toHaveBeenCalledExactlyOnceWith({ id: skill.id, enabled: false });
});

test('the final list consumer cannot receive the old state after a switch confirms in the same turn', async () => {
  const oldRead = deferred<{ success: boolean; skills: Skill[] }>();
  const switchReply = deferred<{ success: boolean; skills: Skill[] }>();
  const disabled = { ...skill, enabled: false };
  api.list.mockReturnValueOnce(oldRead.promise);
  api.setEnabled.mockReturnValue(switchReply.promise);
  const { skillService } = await import('./skillService');
  const consumed: Skill[][] = [];
  const reading = skillService.loadSkills().then(skills => consumed.push(skills));
  const switching = skillService
    .setSkillEnabled(skill.id, false)
    .then(skills => consumed.push(skills));
  await Promise.resolve();

  oldRead.resolve({ success: true, skills: [{ ...skill, enabled: true }] });
  switchReply.resolve({ success: true, skills: [disabled] });
  await Promise.all([reading, switching]);

  expect(consumed[consumed.length - 1]).toEqual([disabled]);
  expect(skillService.getSkills()).toEqual([disabled]);
  expect(skillService.isGatewayOffline()).toBe(false);
  expect(api.list).toHaveBeenCalledOnce();
});

test('coalesces repeated switch requests with the same skill and intended state', async () => {
  const reply = deferred<{ success: boolean; skills: Skill[] }>();
  const disabled = { ...skill, enabled: false };
  api.setEnabled.mockReturnValue(reply.promise);
  const { skillService } = await import('./skillService');

  const first = skillService.setSkillEnabled(skill.id, false);
  const repeated = skillService.setSkillEnabled(skill.id, false);
  await Promise.resolve();
  expect(api.setEnabled).toHaveBeenCalledOnce();
  expect(first).toBe(repeated);
  reply.resolve({ success: true, skills: [disabled] });

  await expect(Promise.all([first, repeated])).resolves.toEqual([[disabled], [disabled]]);
});

test('queues the opposite switch intent instead of treating it as the in-flight result', async () => {
  const reply = deferred<{ success: boolean; skills: Skill[] }>();
  const disabled = { ...skill, enabled: false };
  const enabled = { ...skill, enabled: true };
  api.setEnabled
    .mockReturnValueOnce(reply.promise)
    .mockResolvedValueOnce({ success: true, skills: [enabled] });
  const { skillService } = await import('./skillService');

  const disabling = skillService.setSkillEnabled(skill.id, false);
  const enabling = skillService.setSkillEnabled(skill.id, true);
  await Promise.resolve();
  expect(api.setEnabled).toHaveBeenCalledOnce();
  reply.resolve({ success: true, skills: [disabled] });

  await expect(disabling).resolves.toEqual([disabled]);
  await expect(enabling).resolves.toEqual([enabled]);
  expect(api.setEnabled.mock.calls).toEqual([
    [{ id: skill.id, enabled: false }],
    [{ id: skill.id, enabled: true }],
  ]);
});

test('a remounted page waits for the pending switch before reading the native inventory', async () => {
  const reply = deferred<{ success: boolean; skills: Skill[] }>();
  const disabled = { ...skill, enabled: false };
  api.setEnabled.mockReturnValue(reply.promise);
  api.list.mockResolvedValue({ success: true, skills: [disabled] });
  const { skillService } = await import('./skillService');
  const switching = skillService.setSkillEnabled(skill.id, false);
  const remountRead = skillService.loadSkills({ force: true });
  await Promise.resolve();
  expect(api.list).not.toHaveBeenCalled();

  reply.resolve({ success: true, skills: [disabled] });

  await expect(switching).resolves.toEqual([disabled]);
  await expect(remountRead).resolves.toEqual([disabled]);
  expect(api.list).toHaveBeenCalledOnce();
});

test('retains the confirmed inventory when a supplementary switch read fails', async () => {
  const reply = deferred<{ success: boolean; skills: Skill[] }>();
  const original = { ...skill, enabled: true };
  api.list
    .mockResolvedValueOnce({ success: true, skills: [original] })
    .mockResolvedValueOnce({ success: false, error: 'Temporary inventory read failure' });
  api.importPath.mockResolvedValue({ success: true, skillId: 'another-skill' });
  api.setEnabled.mockReturnValue(reply.promise);
  const { skillService } = await import('./skillService');
  await skillService.loadSkills();
  const switching = skillService.setSkillEnabled(skill.id, false);
  await Promise.resolve();
  await skillService.importSkill('C:/imports/another-skill.zip');
  reply.resolve({ success: true, skills: [{ ...original, enabled: false }] });

  await expect(switching).resolves.toEqual([original]);
  expect(skillService.getSkills()).toEqual([original]);
  expect(skillService.isGatewayOffline()).toBe(false);
});

test('a delayed failed switch cannot mark a newer confirmed inventory offline', async () => {
  const reply = deferred<{ success: boolean; error: string; gatewayOffline: boolean }>();
  const newer = { ...skill, enabled: true, description: 'New native inventory' };
  api.setEnabled.mockReturnValue(reply.promise);
  api.delete.mockResolvedValue({ success: true, skills: [newer] });
  const { skillService } = await import('./skillService');
  const failedSwitch = expect(skillService.setSkillEnabled(skill.id, false)).rejects.toThrow(
    'Older disconnected operation',
  );
  await Promise.resolve();
  await skillService.deleteSkill('deleted-other-skill', skill.source);
  reply.resolve({
    success: false,
    error: 'Older disconnected operation',
    gatewayOffline: true,
  });
  await failedSwitch;

  expect(skillService.isGatewayOffline()).toBe(false);
  expect(skillService.getSkills()).toEqual([newer]);
});

test('supplementary reads do not wait for the current switch or later queued switches', async () => {
  const firstReply = deferred<{ success: boolean; skills: Skill[] }>();
  const disabled = { ...skill, enabled: false };
  const enabled = { ...skill, enabled: true };
  api.setEnabled
    .mockReturnValueOnce(firstReply.promise)
    .mockResolvedValueOnce({ success: true, skills: [enabled] });
  api.importPath.mockResolvedValue({ success: true, skillId: 'another-skill' });
  api.list.mockResolvedValue({ success: true, skills: [disabled] });
  const { skillService } = await import('./skillService');
  const first = skillService.setSkillEnabled(skill.id, false);
  const second = skillService.setSkillEnabled(skill.id, true);
  await Promise.resolve();
  await skillService.importSkill('C:/imports/another-skill.zip');
  firstReply.resolve({ success: true, skills: [disabled] });

  await expect(first).resolves.toEqual([disabled]);
  await expect(second).resolves.toEqual([enabled]);
  expect(api.list).toHaveBeenCalledOnce();
  expect(api.setEnabled).toHaveBeenCalledTimes(2);
});

test('marketplace reconciliation rereads a stale native inventory after its watcher settles', async () => {
  vi.useFakeTimers();
  api.list.mockResolvedValue({ success: true, skills: [] });
  const { skillService } = await import('./skillService');
  const changed = vi.fn();
  const stop = skillService.subscribeInventory(changed);
  await skillService.refreshInventoryAfterMutation();
  expect(api.list).toHaveBeenCalledOnce();
  api.list.mockResolvedValue({ success: true, skills: [skill] });
  await vi.advanceTimersByTimeAsync(200);
  expect(changed).toHaveBeenLastCalledWith([skill]);
  stop();
});

test.each([
  { success: false, gatewayOffline: true, error: 'Gateway not connected' },
  { success: false, gatewayOffline: false, error: 'WebSocket closed' },
])('recovers an initially unavailable RPC while the page stays mounted: $error', async failure => {
  vi.useFakeTimers();
  api.list.mockResolvedValue(failure);
  const { skillService } = await import('./skillService');
  const changed = vi.fn();
  const stop = skillService.subscribeInventory(changed);
  await skillService.loadSkills();
  await vi.advanceTimersByTimeAsync(3_000);
  expect(api.list).toHaveBeenCalledTimes(2);
  api.list.mockResolvedValue({ success: true, skills: [skill] });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(changed).toHaveBeenLastCalledWith([skill]);
  expect(skillService.isGatewayOffline()).toBe(false);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(api.list).toHaveBeenCalledTimes(3);
  stop();
});

test('recovers an RPC disconnect during import even after the five-second mutation window', async () => {
  vi.useFakeTimers();
  api.list.mockResolvedValue({ success: true, skills: [] });
  api.importPath.mockResolvedValue({ success: true, skillId: skill.id });
  const { skillService } = await import('./skillService');
  const changed = vi.fn();
  const stop = skillService.subscribeInventory(changed);
  await skillService.loadSkills();
  await skillService.importSkill('C:/imports/example.zip');
  api.list.mockRejectedValue(new Error('WebSocket closed'));
  await vi.advanceTimersByTimeAsync(6_200);
  expect(skillService.isGatewayOffline()).toBe(true);
  api.list.mockResolvedValue({ success: true, skills: [skill] });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(changed).toHaveBeenLastCalledWith([skill]);
  const count = api.list.mock.calls.length;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(api.list).toHaveBeenCalledTimes(count);
  stop();
});

test('cancels offline recovery when the last page unmounts and resumes on remount', async () => {
  vi.useFakeTimers();
  api.list.mockResolvedValue({ success: false, gatewayOffline: true });
  const { skillService } = await import('./skillService');
  const stop = skillService.subscribeInventory(vi.fn());
  await skillService.loadSkills();
  stop();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(api.list).toHaveBeenCalledOnce();
  api.list.mockResolvedValue({ success: true, skills: [skill] });
  const changed = vi.fn();
  const stopAgain = skillService.subscribeInventory(changed);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(changed).toHaveBeenLastCalledWith([skill]);
  stopAgain();
});

test('mutation retries share pending reads with offline recovery and stop recovery after success', async () => {
  vi.useFakeTimers();
  api.list.mockResolvedValue({ success: false, gatewayOffline: true });
  const { skillService } = await import('./skillService');
  const stop = skillService.subscribeInventory(vi.fn());
  await skillService.loadSkills();
  const reply = deferred<{ success: boolean; skills: Skill[] }>();
  api.list.mockReturnValue(reply.promise);
  const refresh = skillService.refreshInventoryAfterMutation();
  await Promise.resolve();
  await Promise.resolve();
  vi.advanceTimersByTime(3_000);
  await Promise.resolve();
  await Promise.resolve();
  // Both timers join the current request instead of making concurrent reads.
  expect(api.list).toHaveBeenCalledTimes(2);
  reply.resolve({ success: true, skills: [skill] });
  await refresh;
  await vi.advanceTimersByTimeAsync(10_000);
  stop();
});

test('reconciles a switch interrupted by RPC disconnect without resending the mutation', async () => {
  vi.useFakeTimers();
  api.list.mockResolvedValue({ success: true, skills: [skill] });
  api.setEnabled.mockResolvedValue({
    success: false,
    gatewayOffline: true,
    error: 'Gateway disconnected',
  });
  const { skillService } = await import('./skillService');
  const changed = vi.fn();
  const stop = skillService.subscribeInventory(changed);
  await skillService.loadSkills();
  await expect(skillService.setSkillEnabled(skill.id, true)).rejects.toThrow(
    'Gateway disconnected',
  );
  expect(skillService.isGatewayOffline()).toBe(true);
  const confirmed = { ...skill, enabled: true };
  api.list.mockResolvedValue({ success: true, skills: [confirmed] });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(changed).toHaveBeenLastCalledWith([confirmed]);
  expect(skillService.isGatewayOffline()).toBe(false);
  expect(api.setEnabled).toHaveBeenCalledOnce();
  stop();
});
