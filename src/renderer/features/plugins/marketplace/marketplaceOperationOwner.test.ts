import { PluginKind } from '@shared/plugins/marketplace';
import { expect, test, vi } from 'vitest';

import { getMarketplaceOperationOwner } from './marketplaceOperationOwner';

vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));

test('isolates operation locks by bridge and plugin kind', () => {
  const bridge = {};
  const skill = getMarketplaceOperationOwner(bridge, PluginKind.SKILL);
  skill.locks.add('writer');
  expect(getMarketplaceOperationOwner(bridge, PluginKind.SKILL).locks.has('writer')).toBe(true);
  expect(getMarketplaceOperationOwner(bridge, PluginKind.MCP).locks.size).toBe(0);
  expect(getMarketplaceOperationOwner({}, PluginKind.SKILL).locks.size).toBe(0);
});

test('permits reinstall only after a committed installation was observed then removed', () => {
  const owner = getMarketplaceOperationOwner({}, PluginKind.SKILL);
  owner.update(() => ({ writer: { committed: true, version: '2' } }));
  owner.reconcile(new Set());
  expect(owner.snapshot().writer.committed).toBe(true);
  owner.reconcile(new Set(['writer']));
  owner.reconcile(new Set());
  expect(owner.snapshot().writer).toBeUndefined();
});

test('bounds settled feedback without evicting an active mutation', () => {
  const owner = getMarketplaceOperationOwner({}, PluginKind.SKILL);
  owner.update(() => ({ active: { busy: true } }));
  for (let index = 0; index < 110; index++)
    owner.update(current => ({ ...current, [index]: { error: 'failed' } }));
  expect(Object.keys(owner.snapshot())).toHaveLength(101);
  expect(owner.snapshot().active.busy).toBe(true);
});

test('defers refresh until a current view can reconcile a completed mutation', async () => {
  const owner = getMarketplaceOperationOwner({}, PluginKind.SKILL);
  await owner.refresh('writer');
  const refresh = vi.fn(async () => undefined);
  const detach = owner.attachRefresh(refresh);
  await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  detach();
  const next = vi.fn(async () => undefined);
  owner.attachRefresh(next);
  expect(next).not.toHaveBeenCalled();
});

test('keeps refresh failures actionable when completion happened while no view was mounted', async () => {
  const owner = getMarketplaceOperationOwner({}, PluginKind.SKILL);
  owner.update(() => ({ writer: { committed: true } }));
  await owner.refresh('writer');
  owner.attachRefresh(async () => {
    throw new Error('offline');
  });
  await vi.waitFor(() =>
    expect(owner.snapshot().writer.warning).toBe('marketplaceRefreshAfterInstallFailed'),
  );
});
