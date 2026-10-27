import type { IpcMainInvokeEvent } from 'electron';
import { expect, test, vi } from 'vitest';

import { WebpageEmbedSettingsIpc } from '../../../shared/browser/webpageEmbedSettings';
import { registerWebpageEmbedSettingsHandlers } from './webpageEmbedSettingsIpc';

test('accepts settings operations only after owner authorization and removes both handlers', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
  const owner = { sender: 'main', senderFrame: 'main-frame' } as unknown as IpcMainInvokeEvent;
  const getSettings = vi.fn(async () => ({ success: false, code: 'unavailable' } as const));
  const saveSettings = vi.fn(async (_input: unknown) => ({ success: false, code: 'invalid' } as const));
  const cleanup = registerWebpageEmbedSettingsHandlers({
    ipc: ipc as never,
    requireOwner: event => { if (event !== owner) throw new Error('Untrusted webpage owner'); },
    settings: { getSettings, saveSettings },
  });
  for (const channel of Object.values(WebpageEmbedSettingsIpc)) {
    expect(() => handlers.get(channel)!({ sender: 'guest' }, {})).toThrow('Untrusted webpage owner');
    expect(() => handlers.get(channel)!({ ...owner, senderFrame: 'subframe' }, {})).toThrow('Untrusted webpage owner');
  }
  expect(getSettings).not.toHaveBeenCalled();
  expect(saveSettings).not.toHaveBeenCalled();
  await expect(handlers.get(WebpageEmbedSettingsIpc.Get)!(owner)).resolves.toEqual({ success: false, code: 'unavailable' });
  const input = { allowExternalEmbedUrls: true, revision: 'viewed' };
  await handlers.get(WebpageEmbedSettingsIpc.Save)!(owner, input);
  expect(saveSettings).toHaveBeenCalledExactlyOnceWith(input);
  cleanup();
  expect(handlers.size).toBe(0);
});
