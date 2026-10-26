import { expect, test, vi } from 'vitest';

vi.mock('electron', () => ({ nativeImage: {} }));

import { type RegisteredTab } from './browserAgentProtocol';
import { type BrowserAgentSnapshotsContext, captureScreenshot } from './browserAgentSnapshots';

const setup = () => {
  const data = Buffer.from('synthetic image').toString('base64');
  const sendCommand = vi.fn(async (method: string): Promise<unknown> =>
    method === 'Page.captureScreenshot' ? { data } : {},
  );
  const nativeCapture = vi.fn(async () => ({ toPNG: () => Buffer.from('foreground image') }));
  const guest = {
    capturePage: nativeCapture,
    getURL: () => 'https://site.example',
  } as unknown as Electron.WebContents;
  const context = {
    snapshots: new Map(),
    enableDebuggerDomains: vi.fn(async () => ({ sendCommand })),
    normalizeScreenshotData: (value: string) => ({ data: value, width: 1280, height: 800 }),
  };
  const tab: RegisteredTab = {
    sessionId: 'session',
    targetId: 'target',
    profile: 'embedded',
    webContentsId: 1,
    ownerId: -1,
    headless: true,
  };
  const capture = (headless = true) =>
    captureScreenshot.call(
      context as unknown as BrowserAgentSnapshotsContext,
      { action: 'screenshot', sessionKey: 'native-fixture' },
      { ...tab, headless },
      guest,
    );
  return { sendCommand, nativeCapture, context, capture, data };
};

test('captures a background viewport through CDP without native hidden-window capture', async () => {
  const f = setup();
  const result = await f.capture();
  expect(result.content).toContainEqual({ type: 'image', data: f.data, mimeType: 'image/png' });
  expect(f.sendCommand.mock.calls.map(([method]) => method)).toEqual([
    'Page.getLayoutMetrics',
    'Page.captureScreenshot',
  ]);
  expect(f.sendCommand).toHaveBeenCalledWith('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false,
    fromSurface: true,
  });
  expect(f.nativeCapture).not.toHaveBeenCalled();
});

test('waits for layout and propagates capture failure without retrying or using a second capture path', async () => {
  const f = setup();
  let ready!: (value: unknown) => void;
  f.sendCommand.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        ready = resolve;
      }),
  );
  f.sendCommand.mockRejectedValueOnce(new Error('capture unavailable'));
  const pending = f.capture();
  const rejected = expect(pending).rejects.toThrow('capture unavailable');
  await vi.waitFor(() => expect(f.sendCommand).toHaveBeenCalledOnce());
  ready({});
  await rejected;
  expect(f.sendCommand).toHaveBeenCalledTimes(2);
  expect(f.nativeCapture).not.toHaveBeenCalled();
});

test('retains the native capture behavior of the foreground sidebar', async () => {
  const f = setup();
  await f.capture(false);
  expect(f.nativeCapture).toHaveBeenCalledExactlyOnceWith();
  expect(f.context.enableDebuggerDomains).not.toHaveBeenCalled();
});
