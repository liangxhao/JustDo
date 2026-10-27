import { expect, test, vi } from 'vitest';

import { OpenClawAssistantMediaIpc } from '../shared/openclaw/assistantMedia';

const mocks = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn() }));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: { invoke: mocks.invoke },
}));

test('exposes only two playback operations to the fixed workspace document', async () => {
  await import('./mediaPlaybackPreload');
  expect(mocks.expose).toHaveBeenCalledOnce();
  const [name, bridge] = mocks.expose.mock.calls[0];
  expect(name).toBe('mediaPlayback');
  expect(Object.keys(bridge)).toEqual([
    'prepareAssistantMediaPlayback',
    'releaseAssistantMediaPlayback',
  ]);
  const request = { source: '/native/source', sessionKey: 'session', kind: 'video' };
  await bridge.prepareAssistantMediaPlayback(request);
  await bridge.releaseAssistantMediaPlayback({ url: 'opaque-url' });
  expect(mocks.invoke.mock.calls).toEqual([
    [OpenClawAssistantMediaIpc.PreparePlayback, request],
    [OpenClawAssistantMediaIpc.ReleasePlayback, { url: 'opaque-url' }],
  ]);
});
