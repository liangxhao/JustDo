import { beforeEach, expect, test, vi } from 'vitest';

import { SkillWorkshopIpc } from '../../../shared/plugins/skillWorkshop';
import { SkillWorkshopService } from '../../plugins/skills/skillWorkshopService';
import { registerSkillWorkshopHandlers } from './skillWorkshop';

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => Promise<unknown>>());
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => handlers.set(name, handler) },
}));
beforeEach(() => handlers.clear());

test('all five typed Workshop IPC operations reach only their supported native method', async () => {
  const change = { id: 'c1', agentId: 'main', skillName: 'release', action: 'archive',
    actor: 'user', summary: '', createdAtMs: 1 };
  const request = vi.fn(async (method: string) => {
    if (method.endsWith('.list')) return { agentId: 'main', root: '/native', mode: 'off', skills: [], archived: [] };
    if (method.endsWith('.changes')) return { changes: [] };
    if (method.endsWith('.read')) return { name: 'release', filePath: 'SKILL.md', content: 'Full content', files: ['SKILL.md'] };
    return { change: { ...change, action: method.endsWith('.restore') ? 'restore' : 'archive' } };
  });
  registerSkillWorkshopHandlers(new SkillWorkshopService(request as never));
  const inputs = [
    [SkillWorkshopIpc.List, 'main'],
    [SkillWorkshopIpc.Changes, { agentId: 'main' }],
    [SkillWorkshopIpc.Read, { agentId: 'main', name: 'release' }],
    [SkillWorkshopIpc.Archive, { agentId: 'main', name: 'release' }],
    [SkillWorkshopIpc.Restore, { agentId: 'main', name: 'release', versionId: 'saved' }],
  ] as const;
  for (const [channel, input] of inputs)
    await expect(handlers.get(channel)!({}, input)).resolves.toMatchObject({ success: true });
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    'skills.workshop.list', 'skills.workshop.changes', 'skills.workshop.read',
    'skills.workshop.archive', 'skills.workshop.restore',
  ]);
  expect(handlers.size).toBe(5);
});

test.each([SkillWorkshopIpc.Read, SkillWorkshopIpc.Archive, SkillWorkshopIpc.Restore])(
  '%s validates untrusted IPC payloads before any native access', async channel => {
    const request = vi.fn();
    registerSkillWorkshopHandlers(new SkillWorkshopService(request));
    await expect(handlers.get(channel)!({}, null)).resolves.toEqual({ success: false, error: 'skillWorkshopMainOnly' });
    await expect(handlers.get(channel)!({}, { agentId: 'other', name: 'release', versionId: 'saved' }))
      .resolves.toEqual({ success: false, error: 'skillWorkshopMainOnly' });
    await expect(handlers.get(channel)!({}, { agentId: 'main', name: '../escape', versionId: 'saved' }))
      .resolves.toEqual({ success: false, error: 'skillWorkshopInvalidInput' });
    expect(request).not.toHaveBeenCalled();
  },
);

test('an IPC mutation with a lost reply reports uncertainty once, including post-file INVALID_REQUEST', async () => {
  const request = vi.fn().mockRejectedValue(Object.assign(new Error('record failed'), { gatewayCode: 'INVALID_REQUEST' }));
  registerSkillWorkshopHandlers(new SkillWorkshopService(request));
  await expect(handlers.get(SkillWorkshopIpc.Archive)!({}, { agentId: 'main', name: 'release' }))
    .resolves.toEqual({ success: false, error: 'skillWorkshopMutationUnconfirmed' });
  expect(request).toHaveBeenCalledOnce();
});
