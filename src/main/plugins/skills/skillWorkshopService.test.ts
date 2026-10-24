import { describe, expect, test, vi } from 'vitest';

import { SkillWorkshopService } from './skillWorkshopService';

export const inventory = {
  agentId: 'main',
  mode: 'off',
  root: '/native/workshop',
  skills: [
    {
      name: 'release',
      description: 'Release checklist',
      updatedAtMs: 10,
      sizeBytes: 40,
      files: ['SKILL.md', 'references/check.md'],
      useCount: 0,
    },
  ],
  archived: [
    {
      name: 'release',
      live: true,
      versions: [{ id: 'before-patch', action: 'patch', createdAtMs: 9 }],
    },
    {
      name: 'retired',
      live: false,
      versions: [{ id: 'before-archive', action: 'archive', createdAtMs: 8 }],
    },
  ],
};
const change = {
  id: 'change-1',
  agentId: 'main',
  skillName: 'release',
  action: 'archive',
  actor: 'user',
  summary: 'Archived',
  createdAtMs: 11,
  versionId: 'backup-current',
};
function setup() {
  const request = vi.fn(async (method: string, params?: unknown): Promise<unknown> => {
    if (method === 'skills.workshop.list') return structuredClone(inventory);
    if (method === 'skills.workshop.changes') return { changes: [change] };
    if (method === 'skills.workshop.read') {
      const input = params as { name: string; filePath: string };
      return {
        name: input.name,
        filePath: input.filePath,
        content: 'Full instructions\nLast line',
        files: ['SKILL.md', 'references/check.md'],
      };
    }
    return { change: { ...change, action: method.endsWith('restore') ? 'restore' : 'archive' } };
  });
  return { request, service: new SkillWorkshopService(request as never) };
}
describe('native Workshop inventory, versions and single mutations', () => {
  test('reads native inventory and keeps live saved versions distinct from archived skills', async () => {
    const { service, request } = setup();
    expect(await service.list('main')).toEqual(inventory);
    expect(request).toHaveBeenCalledExactlyOnceWith('skills.workshop.list', { agentId: 'main' });
  });
  test('reads the selected version and support file without proposal/CAS fields', async () => {
    const { service, request } = setup();
    expect(
      await service.read({
        agentId: 'main',
        name: 'release',
        versionId: 'before-patch',
        filePath: 'references/check.md',
      }),
    ).toMatchObject({ content: expect.stringContaining('Last line') });
    expect(request).toHaveBeenCalledExactlyOnceWith('skills.workshop.read', {
      agentId: 'main',
      name: 'release',
      versionId: 'before-patch',
      filePath: 'references/check.md',
    });
  });
  test('forwards bounded/exclusive feed parameters without inventing a cursor or total', async () => {
    const { service, request } = setup();
    expect(await service.changes({ agentId: 'main', limit: 200, beforeMs: 9 })).toEqual([change]);
    expect(request).toHaveBeenCalledWith('skills.workshop.changes', {
      agentId: 'main',
      limit: 200,
      beforeMs: 9,
    });
  });
  test('archive returns the native receipt; restore target differs from pre-change backup', async () => {
    const { service, request } = setup();
    expect(
      await service.archive({ agentId: 'main', name: 'release', reason: 'No longer useful' }),
    ).toEqual(change);
    expect(
      await service.restore({ agentId: 'main', name: 'release', versionId: 'before-patch' }),
    ).toEqual({ ...change, action: 'restore' });
    expect(request.mock.calls).toEqual([
      ['skills.workshop.archive', { agentId: 'main', name: 'release', reason: 'No longer useful' }],
      ['skills.workshop.restore', { agentId: 'main', name: 'release', versionId: 'before-patch' }],
    ]);
  });
  test('requires main before any operation', async () => {
    const { service, request } = setup();
    await expect(service.list('other')).rejects.toThrow('skillWorkshopMainOnly');
    await expect(service.changes({ agentId: 'other' })).rejects.toThrow('skillWorkshopMainOnly');
    await expect(service.read({ agentId: 'other', name: 'release' })).rejects.toThrow(
      'skillWorkshopMainOnly',
    );
    await expect(service.archive({ agentId: 'other', name: 'release' })).rejects.toThrow(
      'skillWorkshopMainOnly',
    );
    await expect(
      service.restore({ agentId: 'other', name: 'release', versionId: 'x' }),
    ).rejects.toThrow('skillWorkshopMainOnly');
    expect(request).not.toHaveBeenCalled();
  });
  test.each(['../escape', '/absolute', 'bad/name', '', 'UPPER'])(
    'rejects unsafe name %s before native access',
    async name => {
      const { service, request } = setup();
      await expect(service.read({ agentId: 'main', name })).rejects.toThrow(
        'skillWorkshopInvalidInput',
      );
      expect(request).not.toHaveBeenCalled();
    },
  );
  test.each(['../secret', '/secret', 'references/../secret', 'C:/secret', 'references\\secret'])(
    'rejects unsafe file %s',
    async filePath => {
      const { service, request } = setup();
      await expect(service.read({ agentId: 'main', name: 'release', filePath })).rejects.toThrow(
        'skillWorkshopInvalidInput',
      );
      expect(request).not.toHaveBeenCalled();
    },
  );
  test('requires explicit restore version and valid feed range', async () => {
    const { service, request } = setup();
    await expect(service.restore({ agentId: 'main', name: 'release' } as never)).rejects.toThrow(
      'skillWorkshopInvalidInput',
    );
    for (const limit of [0, 501, NaN, 1.5])
      await expect(service.changes({ agentId: 'main', limit })).rejects.toThrow(
        'skillWorkshopInvalidInput',
      );
    expect(request).not.toHaveBeenCalled();
  });
  test.each([
    { ...inventory, agentId: 'other' },
    { proposals: [] },
    { ...inventory, mode: 'pending' },
    { ...inventory, skills: [{ ...inventory.skills[0], useCount: -1 }] },
    { ...inventory, archived: [{ ...inventory.archived[0], live: undefined }] },
  ])('rejects incompatible or foreign inventory', async invalid => {
    const { service, request } = setup();
    request.mockResolvedValueOnce(invalid);
    await expect(service.list('main')).rejects.toThrow('skillWorkshopInvalidResponse');
  });
  test.each([
    { ...change, agentId: 'other' },
    { ...change, skillName: 'other' },
    { ...change, action: 'restore' },
    { ...change, actor: 'agent' },
    { ...change, createdAtMs: NaN },
    {},
  ])('never accepts a mismatched mutation receipt as success', async invalid => {
    const { service, request } = setup();
    request.mockResolvedValueOnce({ change: invalid });
    await expect(service.archive({ agentId: 'main', name: 'release' })).rejects.toThrow(
      'skillWorkshopMutationUnconfirmed',
    );
    expect(request).toHaveBeenCalledOnce();
  });
  test.each(['timeout', 'disconnected'])('does not replay an uncertain %s write', async message => {
    const { service, request } = setup();
    request.mockRejectedValueOnce(new Error(message));
    await expect(service.archive({ agentId: 'main', name: 'release' })).rejects.toThrow(
      'skillWorkshopMutationUnconfirmed',
    );
    await service.list('main');
    await service.changes({ agentId: 'main' });
    expect(
      request.mock.calls.filter(([method]) => method === 'skills.workshop.archive'),
    ).toHaveLength(1);
    expect(request.mock.calls.some(([method]) => method.startsWith('skills.proposals.'))).toBe(
      false,
    );
  });
  test('keeps native explicit rejections separate from unknown outcomes', async () => {
    const { service, request } = setup();
    request.mockRejectedValueOnce(
      Object.assign(new Error('not allowed'), { gatewayCode: 'FORBIDDEN' }),
    );
    await expect(service.archive({ agentId: 'main', name: 'release' })).rejects.toThrow(
      'skillWorkshopChangeRejected',
    );
  });
  test('serializes archive and restore for the same skill without duplicate submission', async () => {
    const { service, request } = setup();
    let finish!: (value: unknown) => void;
    request.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const pending = service.archive({ agentId: 'main', name: 'release' });
    await expect(
      service.restore({ agentId: 'main', name: 'release', versionId: 'x' }),
    ).rejects.toThrow('skillWorkshopBusy');
    finish({ change });
    await pending;
    expect(request).toHaveBeenCalledOnce();
  });
});
