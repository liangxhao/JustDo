import { expect, test, vi } from 'vitest';

import { AutomaticErrorRetryIpc, type AutomaticErrorRetryPresentation } from '../../shared/cowork/automaticErrorRetry';

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }));
vi.mock('electron', () => ({ ipcRenderer: ipc }));

import { createAutomaticErrorRetryApi } from './automaticErrorRetry';

test('reads only retry metadata and retires its event listener', async () => {
  const api = createAutomaticErrorRetryApi();
  await api.getAutomaticErrorRetry('session');
  expect(ipc.invoke).toHaveBeenCalledWith(AutomaticErrorRetryIpc.Get, 'session');
  const callback = vi.fn();
  const remove = api.onAutomaticErrorRetryChanged(callback);
  const listener = ipc.on.mock.calls[0][1];
  const value = { sessionId: 'session' } as AutomaticErrorRetryPresentation;
  listener({}, value);
  expect(callback).toHaveBeenCalledExactlyOnceWith(value);
  remove();
  remove();
  listener({}, value);
  expect(callback).toHaveBeenCalledOnce();
  expect(ipc.removeListener).toHaveBeenCalledExactlyOnceWith(AutomaticErrorRetryIpc.Changed, listener);
});
