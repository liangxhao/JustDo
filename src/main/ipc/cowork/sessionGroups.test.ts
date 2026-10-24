import { beforeEach, expect, test, vi } from 'vitest';

import type { CoworkStore } from '../../data/coworkStore';
import type { GroupStore } from '../../data/groupStore';

const mocks = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }));
import { registerSessionGroupHandlers } from './sessionGroups';

beforeEach(() => {
  mocks.handle.mockReset();
});

test.each([
  { source: 'browser-extension' },
  { external: { origin: 'cli' } },
  { external: { origin: 'multica' } },
])('rejects manual source group changes for $source $external', async metadata => {
  const moveSessionToGroup = vi.fn();
  registerSessionGroupHandlers(
    () => ({ moveSessionToGroup, getGroup: () => ({ id: 'group' }) }) as unknown as GroupStore,
    () => ({ getSession: () => ({ id: 'one', ...metadata }) }) as unknown as CoworkStore,
  );
  const handler = mocks.handle.mock.calls.find(([name]) => name === 'sessionGroup:moveSession')![1];
  await expect(handler(null, 'one', 'group')).resolves.toMatchObject({ success: false });
  await expect(handler(null, 'one', null)).resolves.toMatchObject({ success: false });
  expect(moveSessionToGroup).not.toHaveBeenCalled();
});

test.each(['Work', 'Chrome', 'CLI'])('allows an application conversation into a manual group named %s', async name => {
  const moveSessionToGroup = vi.fn(() => true);
  registerSessionGroupHandlers(
    () => ({ moveSessionToGroup, getGroup: () => ({ id: 'group', name }) }) as unknown as GroupStore,
    () => ({ getSession: () => ({ id: 'one' }) }) as unknown as CoworkStore,
  );
  const handler = mocks.handle.mock.calls.find(([name]) => name === 'sessionGroup:moveSession')![1];
  await expect(handler(null, 'one', 'group')).resolves.toEqual({ success: true });
  expect(moveSessionToGroup).toHaveBeenCalledExactlyOnceWith('one', 'group');
});

test('allows removing an application conversation from a manual group', async () => {
  const moveSessionToGroup = vi.fn(() => true);
  registerSessionGroupHandlers(
    () => ({ moveSessionToGroup }) as unknown as GroupStore,
    () => ({ getSession: () => ({ id: 'one', groupId: 'group' }) }) as unknown as CoworkStore,
  );
  const handler = mocks.handle.mock.calls.find(([name]) => name === 'sessionGroup:moveSession')![1];
  await expect(handler(null, 'one', null)).resolves.toEqual({ success: true });
  expect(moveSessionToGroup).toHaveBeenCalledExactlyOnceWith('one', null);
});

test.each(['cli', 'browserExtension', 'historicalAppServer', 'deleted-group'])(
  'rejects source or missing group target %s',
  async groupId => {
    const moveSessionToGroup = vi.fn();
    registerSessionGroupHandlers(
      () => ({ moveSessionToGroup, getGroup: () => null }) as unknown as GroupStore,
      () => ({ getSession: () => ({ id: 'one' }) }) as unknown as CoworkStore,
    );
    const handler = mocks.handle.mock.calls.find(([name]) => name === 'sessionGroup:moveSession')![1];
    await expect(handler(null, 'one', groupId)).resolves.toMatchObject({ success: false });
    expect(moveSessionToGroup).not.toHaveBeenCalled();
  },
);

test('rejects a move for a missing conversation', async () => {
  const moveSessionToGroup = vi.fn();
  registerSessionGroupHandlers(
    () => ({ moveSessionToGroup }) as unknown as GroupStore,
    () => ({ getSession: () => null }) as unknown as CoworkStore,
  );
  const handler = mocks.handle.mock.calls.find(([name]) => name === 'sessionGroup:moveSession')![1];
  await expect(handler(null, 'missing', null)).resolves.toMatchObject({ success: false });
  expect(moveSessionToGroup).not.toHaveBeenCalled();
});

test.each([undefined, '', 42, {}])('rejects malformed move targets: %j', async groupId => {
  const moveSessionToGroup = vi.fn();
  const getSession = vi.fn();
  registerSessionGroupHandlers(
    () => ({ moveSessionToGroup }) as unknown as GroupStore,
    () => ({ getSession }) as unknown as CoworkStore,
  );
  const handler = mocks.handle.mock.calls.find(([name]) => name === 'sessionGroup:moveSession')![1];
  await expect(handler(null, 'one', groupId)).resolves.toMatchObject({ success: false });
  expect(getSession).not.toHaveBeenCalled();
  expect(moveSessionToGroup).not.toHaveBeenCalled();
});
