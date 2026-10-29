import { afterEach, expect, test, vi } from 'vitest';

import { ARMED_INTERACTION_TIMEOUT_MS, type RegisteredTab } from './browserAgentProtocol';
import { BrowserFileChooser, type BrowserFileChooserOwner } from './browserFileChooser';

const fixtures: BrowserFileChooser[] = [];
afterEach(() => {
  fixtures.splice(0).forEach(value => value.clearAll());
  vi.useRealTimers();
});

const setup = () => {
  const sendCommand = vi.fn(async (_method: string, _params?: unknown) => undefined);
  const guest = {
    id: 7,
    isDestroyed: () => false,
    debugger: { isAttached: () => true, sendCommand },
  } as unknown as Electron.WebContents;
  const tab = {
    webContentsId: 7,
    targetId: 'target',
    sessionId: 'session',
    profile: 'embedded',
    ownerId: 10,
  } as RegisteredTab;
  const source = new AbortController();
  let runId = 'run-one';
  const owner: BrowserFileChooserOwner = {
    tab,
    guest,
    runId,
    signal: source.signal,
    assertCurrent() {
      source.signal.throwIfAborted();
      if (runId !== 'run-one') throw new Error('Changed native run.');
    },
  };
  const releaseLease = vi.fn();
  const chooser = new BrowserFileChooser(
    () => false,
    releaseLease,
    vi.fn(),
    () => true,
  );
  fixtures.push(chooser);
  const capture = (mode = 'selectSingle') =>
    chooser.capture(tab, guest, { backendNodeId: 42, frameId: 'frame', mode });
  return {
    chooser,
    guest,
    tab,
    owner,
    source,
    sendCommand,
    capture,
    releaseLease,
    changeRun() {
      runId = 'run-two';
    },
  };
};

test('keeps the original chooser across observation and consumes it exactly once on a later call', async () => {
  const f = setup();
  const finishClick = await f.chooser.begin(f.owner);
  expect(f.capture()).toBe(true);
  expect(f.chooser.retainLease(7)).toBe(true);
  await finishClick();
  expect(f.chooser.read(7)).toMatchObject({ pending: true, mode: 'selectSingle' });
  expect(f.sendCommand).not.toHaveBeenCalledWith('DOM.setFileInputFiles', expect.anything());
  const finishUpload = await f.chooser.begin({ ...f.owner, tab: { ...f.tab } });
  await expect(
    f.chooser.consume({ ...f.tab }, f.guest, ['file.txt'], () => undefined),
  ).resolves.toBe(true);
  await expect(f.chooser.consume(f.tab, f.guest, ['file.txt'], () => undefined)).resolves.toBe(
    false,
  );
  await finishUpload();
  expect(f.sendCommand.mock.calls.filter(([method]) => method === 'DOM.setFileInputFiles')).toEqual(
    [['DOM.setFileInputFiles', { files: ['file.txt'], backendNodeId: 42 }]],
  );
  expect(f.releaseLease).toHaveBeenCalledExactlyOnceWith(7);
  expect(f.sendCommand).toHaveBeenLastCalledWith('Page.setInterceptFileChooserDialog', {
    enabled: false,
  });
});

test('leaves manual chooser events alone and rejects missing or foreign native input identity', async () => {
  const f = setup();
  expect(f.capture()).toBe(false);
  const finish = await f.chooser.begin(f.owner);
  expect(f.chooser.capture(f.tab, f.guest, { mode: 'selectSingle' })).toBe(false);
  expect(
    f.chooser.capture({ ...f.tab, sessionId: 'other' }, f.guest, {
      mode: 'selectSingle',
      backendNodeId: 42,
    }),
  ).toBe(false);
  expect(f.chooser.read(7)).toBeNull();
  await finish();
  expect(f.sendCommand).toHaveBeenLastCalledWith('Page.setInterceptFileChooserDialog', {
    enabled: false,
  });
});

test('source cancellation releases the retained lease without clearing an input selection', async () => {
  const f = setup();
  const finish = await f.chooser.begin(f.owner);
  f.capture();
  f.chooser.retainLease(7);
  await finish();
  f.source.abort();
  expect(f.chooser.read(7)).toBeNull();
  await vi.waitFor(() => expect(f.releaseLease).toHaveBeenCalledTimes(1));
  expect(f.sendCommand).not.toHaveBeenCalledWith('DOM.setFileInputFiles', expect.anything());
});

test('expires an unanswered chooser and restores manual browsing', async () => {
  vi.useFakeTimers();
  const f = setup();
  const finish = await f.chooser.begin(f.owner);
  f.capture();
  f.chooser.retainLease(7);
  await finish();
  await vi.advanceTimersByTimeAsync(ARMED_INTERACTION_TIMEOUT_MS);
  expect(f.chooser.read(7)).toBeNull();
  expect(f.releaseLease).toHaveBeenCalledTimes(1);
  expect(f.sendCommand).toHaveBeenLastCalledWith('Page.setInterceptFileChooserDialog', {
    enabled: false,
  });
});

test('rejects a replacement native run before assigning files', async () => {
  const f = setup();
  const finish = await f.chooser.begin(f.owner);
  f.capture();
  await finish();
  f.changeRun();
  const finishReplacement = await f.chooser.begin({
    ...f.owner,
    runId: 'run-two',
    assertCurrent() {},
  });
  await expect(f.chooser.consume(f.tab, f.guest, ['file.txt'], () => undefined)).rejects.toThrow(
    'Changed native run',
  );
  expect(f.sendCommand).not.toHaveBeenCalledWith('DOM.setFileInputFiles', expect.anything());
  await finishReplacement();
});

test('supports a multiple-file chooser and refuses multiple files for a single-file chooser', async () => {
  const f = setup();
  const finish = await f.chooser.begin(f.owner);
  f.capture();
  await expect(
    f.chooser.consume(f.tab, f.guest, ['one.txt', 'two.txt'], () => undefined),
  ).rejects.toThrow('accepts one file');
  expect(f.sendCommand).not.toHaveBeenCalledWith('DOM.setFileInputFiles', expect.anything());
  f.capture('selectMultiple');
  await expect(
    f.chooser.consume(f.tab, f.guest, ['one.txt', 'two.txt'], () => undefined),
  ).resolves.toBe(true);
  await finish();
});

test('does not report success after cancellation during native file assignment', async () => {
  const f = setup();
  const finish = await f.chooser.begin(f.owner);
  f.capture();
  let resolve!: () => void;
  f.sendCommand.mockImplementation(async method => {
    if (method === 'DOM.setFileInputFiles')
      await new Promise<void>(done => {
        resolve = done;
      });
  });
  const assigning = f.chooser.consume(f.tab, f.guest, ['file.txt'], () => undefined);
  f.source.abort();
  resolve();
  await expect(assigning).rejects.toThrow();
  expect(f.chooser.read(7)).toBeNull();
  await finish();
});

test('a late restore failure cannot retire a replacement chooser on the same guest', async () => {
  const f = setup();
  const firstFinish = await f.chooser.begin(f.owner);
  f.capture();
  await firstFinish();
  let rejectOld!: (error: Error) => void;
  let delayed = false;
  f.sendCommand.mockImplementation(async (method, parameters) => {
    if (
      method === 'Page.setInterceptFileChooserDialog' &&
      (parameters as { enabled: boolean }).enabled === false &&
      !delayed
    ) {
      delayed = true;
      await new Promise<void>((_resolve, reject) => {
        rejectOld = reject;
      });
    }
  });
  f.chooser.clear(7);
  const replacementFinish = await f.chooser.begin(f.owner);
  f.capture();
  rejectOld(new Error('Old restore failed.'));
  await new Promise(resolve => setImmediate(resolve));
  expect(f.chooser.read(7)).toMatchObject({ pending: true });
  await expect(f.chooser.consume(f.tab, f.guest, ['file.txt'], () => undefined)).resolves.toBe(
    true,
  );
  await replacementFinish();
});

test('a late restore failure does not detach a debugger whose ownership changed', async () => {
  const f = setup();
  let owned = true;
  const detach = vi.fn();
  Object.assign(f.guest.debugger, { detach });
  const chooser = new BrowserFileChooser(
    () => false,
    vi.fn(),
    vi.fn(),
    () => owned,
  );
  fixtures.push(chooser);
  const finish = await chooser.begin(f.owner);
  let rejectRestore!: (error: Error) => void;
  f.sendCommand.mockImplementation(
    async () =>
      new Promise<void>((_resolve, reject) => {
        rejectRestore = reject;
      }),
  );
  const restoring = finish();
  owned = false;
  rejectRestore(new Error('Previous debugger disconnected.'));
  await restoring;
  expect(detach).not.toHaveBeenCalled();
});

test('retiring an active guard restores interception without waiting for the old action', async () => {
  const f = setup();
  const finish = await f.chooser.begin(f.owner);
  f.chooser.retire(7);
  expect(f.capture()).toBe(false);
  expect(f.sendCommand).toHaveBeenLastCalledWith('Page.setInterceptFileChooserDialog', {
    enabled: false,
  });
  await finish();
});

test('the renderer observation barrier returns within its local timeout even without a protocol response', async () => {
  vi.useFakeTimers();
  const f = setup();
  f.sendCommand.mockImplementation(async () => new Promise<void>(() => undefined));
  const settled = f.chooser.settle(f.guest);
  await vi.advanceTimersByTimeAsync(550);
  await expect(settled).resolves.toBeUndefined();
});

test('a stalled interception restore retires the owned debugger before releasing the retained lease', async () => {
  vi.useFakeTimers();
  const f = setup();
  let attached = true;
  const detach = vi.fn(() => {
    attached = false;
  });
  Object.assign(f.guest.debugger, { isAttached: () => attached, detach });
  const finish = await f.chooser.begin(f.owner);
  f.capture();
  f.chooser.retainLease(7);
  await finish();
  f.sendCommand.mockImplementation(async () => new Promise<void>(() => undefined));
  f.source.abort();
  expect(f.releaseLease).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(detach).toHaveBeenCalledTimes(1);
  expect(f.releaseLease).toHaveBeenCalledExactlyOnceWith(7);
  expect(f.chooser.read(7)).toBeNull();
});
