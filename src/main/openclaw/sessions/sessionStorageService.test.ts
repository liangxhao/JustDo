import { describe, expect, it, vi } from 'vitest';

import { SessionStorageService } from './sessionStorageService';

const status = {
  agents: [
    {
      agentId: 'main',
      storePath: 'private-path',
      databaseBytes: 10,
      walBytes: 2,
      archiveBytes: 3,
      embeddedArchiveBytes: 4,
      hotTranscripts: 1,
      coldTranscripts: 1,
    },
  ],
  maintenance: {
    running: false,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastError: null,
    archivedTranscripts: 0,
    externalizedTranscripts: 0,
  },
};
function fixture(coldStorage?: unknown) {
  const request = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
    if (method === 'config.get')
      return {
        valid: true,
        hash: 'viewed-revision',
        configRevisionHash: 'resolved-revision',
        appliedConfigHash: 'resolved-revision',
        config: { session: { maintenance: { coldStorage } } },
      };
    return status;
  });
  return { request, service: new SessionStorageService(request as never) };
}

describe('session storage service', () => {
  it('reads native defaults without writing config', async () => {
    const { service, request } = fixture();
    expect(await service.getPolicy()).toEqual({
      success: true,
      value: { enabled: false, afterDays: 30, revision: 'viewed-revision', applied: true },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('preserves custom ages and strips filesystem paths', async () => {
    const { service, request } = fixture({ enabled: true, afterDays: 47 });
    expect(await service.getPolicy()).toMatchObject({ value: { afterDays: 47 } });
    expect(JSON.stringify(await service.getStatus())).not.toContain('private-path');
    expect(request).toHaveBeenCalledWith('sessions.storage.status', {});
  });
  it('projects maintenance fields and never forwards raw worker errors', async () => {
    const { service, request } = fixture();
    request.mockResolvedValueOnce({
      ...status,
      maintenance: {
        ...status.maintenance,
        lastError: 'EACCES private-path/session.jsonl.zst',
        internalWorker: { privatePath: 'private-path' },
      },
    });
    const result = await service.getStatus();
    expect(result).toMatchObject({
      success: true,
      value: { maintenance: { lastError: 'unknown' } },
    });
    expect(JSON.stringify(result)).not.toContain('private-path');
    expect(JSON.stringify(result)).not.toContain('internalWorker');
  });
  it.each([{ enabled: 'true' }, { afterDays: null }, { afterDays: 0 }, { afterDays: 1.5 }])(
    'rejects invalid native policy instead of presenting defaults: %j',
    async policy => {
      const { service, request } = fixture(policy);
      expect(await service.getPolicy()).toEqual({ success: false, code: 'configuration' });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it.each([null, 'invalid', [], false])('rejects malformed coldStorage %j', async policy => {
    const { service } = fixture(policy);
    expect(await service.getPolicy()).toEqual({ success: false, code: 'configuration' });
  });
  it.each([
    { valid: false, config: {} },
    { config: { session: null } },
    { config: { session: { maintenance: [] } } },
  ])('rejects diagnostic or malformed snapshots: %j', async override => {
    const { service, request } = fixture();
    request.mockResolvedValueOnce({
      valid: true,
      hash: 'diagnostic-revision',
      configRevisionHash: 'resolved',
      appliedConfigHash: 'resolved',
      ...override,
    });
    expect(await service.getPolicy()).toEqual({ success: false, code: 'configuration' });
  });
  it.each([null, undefined, 'previous-revision'])(
    'does not allow execution before the native configuration is applied: %s',
    async appliedConfigHash => {
      const { service, request } = fixture({ enabled: true });
      request.mockResolvedValueOnce({
        valid: true,
        hash: 'viewed',
        configRevisionHash: 'current-revision',
        appliedConfigHash,
        config: {},
      });
      expect(await service.run()).toEqual({ success: false, code: 'pending' });
      expect(request).not.toHaveBeenCalledWith('sessions.storage.run', {});
    },
  );
  it('writes only coldStorage with the viewed revision, then reads back', async () => {
    const { service, request } = fixture({ enabled: true, afterDays: 90 });
    expect(
      await service.savePolicy({ enabled: true, afterDays: 90, revision: 'old' }),
    ).toMatchObject({ success: true });
    expect(request).toHaveBeenCalledWith('config.patch', {
      baseHash: 'old',
      raw: JSON.stringify({
        session: { maintenance: { coldStorage: { enabled: true, afterDays: 90 } } },
      }),
    });
    expect(request.mock.calls.at(-1)?.[0]).toBe('config.get');
  });
  it.each([0, -1, 1.2, '30', NaN, Infinity])(
    'rejects invalid age %s before RPC',
    async afterDays => {
      const { service, request } = fixture();
      expect(await service.savePolicy({ enabled: true, afterDays, revision: 'a' })).toEqual({
        success: false,
        code: 'invalid',
      });
      expect(request).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['unknown method', 'unsupported'],
    ['missing scope operator.admin', 'forbidden'],
    ['Transcript maintenance requester is no longer authorized', 'forbidden'],
    ['Gateway disconnected', 'unavailable'],
    ['config changed; baseHash mismatch', 'conflict'],
  ])('classifies %s without exposing arbitrary errors', async (message, code) => {
    const { service, request } = fixture();
    request.mockRejectedValueOnce(new Error(message));
    expect(await service.getStatus()).toEqual({ success: false, code });
  });
  it('never retries uncertain writes', async () => {
    const { service, request } = fixture();
    request.mockImplementation(async method => {
      if (method === 'config.patch') throw new Error('timeout');
      return status;
    });
    expect(await service.savePolicy({ enabled: true, afterDays: 30, revision: 'a' })).toEqual({
      success: false,
      code: 'unavailable',
    });
    expect(request.mock.calls.filter(([method]) => method === 'config.patch')).toHaveLength(1);
  });
  it('rejects simultaneous mutations instead of queuing duplicate writes', async () => {
    const { service, request } = fixture();
    let release!: (value: unknown) => void;
    request.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve;
        }),
    );
    const saving = service.savePolicy({ enabled: true, afterDays: 30, revision: 'a' });
    expect(await service.run()).toEqual({ success: false, code: 'busy' });
    release(status);
    await saving;
  });
  it('does not run with disabled policy; enabled runs use empty params and keep native running state', async () => {
    const disabled = fixture();
    expect(await disabled.service.run()).toEqual({ success: false, code: 'disabled' });
    expect(disabled.request).not.toHaveBeenCalledWith('sessions.storage.run', {});
    const enabled = fixture({ enabled: true });
    expect(await enabled.service.run()).toMatchObject({
      success: true,
      value: { maintenance: { running: false } },
    });
    expect(enabled.request).toHaveBeenCalledWith('sessions.storage.run', {});
  });
});

it('returns editable policy when the whole native config is not yet applied', async () => {
  const { service, request } = fixture();
  const snapshot = {
    valid: true,
    hash: 'candidate',
    configRevisionHash: 'new',
    appliedConfigHash: 'old',
    config: { session: { maintenance: { coldStorage: { enabled: false, afterDays: 47 } } } },
  };
  request.mockImplementation(async method => (method === 'config.get' ? snapshot : status));
  expect(await service.getPolicy()).toEqual({
    success: true,
    value: { enabled: false, afterDays: 47, revision: 'candidate', applied: false },
  });
  expect(
    await service.savePolicy({ enabled: false, afterDays: 47, revision: 'candidate' }),
  ).toMatchObject({ success: true, value: { applied: false } });
  expect(request).toHaveBeenCalledWith(
    'config.patch',
    expect.objectContaining({ baseHash: 'candidate' }),
  );
});
