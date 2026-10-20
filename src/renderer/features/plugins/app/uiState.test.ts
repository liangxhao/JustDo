import { expect, test } from 'vitest';

import type { AppBrowserHost } from '../../../../../packages/app-plugin-sdk/browser';
import type {
  AppPluginBridge,
  AppPluginSnapshot,
} from '../../../../../packages/app-plugin-sdk/contracts';
import { AppBrowserRegistry } from './browserRegistry';
import { AppUiStateStore } from './uiState';

test('stores detached local plain data beyond IPC limits and rejects executable or unbounded values', () => {
  const state = new AppUiStateStore();
  const input = {
    text: 'x'.repeat(2 * 1024 * 1024),
    attachments: ['C:/user/image.png'],
    pending: { requestId: 'unknown' },
  };
  state.set('draft', input);
  input.attachments.push('changed');
  const read = state.get('draft') as typeof input;
  expect(read.attachments).toEqual(['C:/user/image.png']);
  read.pending.requestId = 'mutated';
  expect((state.get('draft') as typeof input).pending.requestId).toBe('unknown');
  expect(() => state.set('callback', { onSend: () => {} })).toThrow('appPluginInvalidRequest');
  expect(() => state.set('live', new AbortController())).toThrow('appPluginInvalidRequest');
  expect(() => state.set('huge', 'x'.repeat(17 * 1024 * 1024))).toThrow('appPluginInvalidRequest');
});

test('draft data survives disable/reconnect only for the installed hash; old ports and modes retire', async () => {
  const bridge: AppPluginBridge = {
    snapshot: async () => [],
    invoke: async () => ({}),
    onChanged: () => () => {},
  };
  const hosts: AppBrowserHost[] = [];
  const registry = new AppBrowserRegistry(
    bridge,
    {
      t: key => key,
      translations: () => () => {},
      components: {},
      renderHistory: () => null,
    },
    async () => ({
      register: host => {
        hosts.push(host);
        host.registerMode({
          id: 'mode',
          labelKey: 'Mode',
          prepare: async input => ({ prompt: input.prompt }),
        });
      },
    }),
  );
  const row = (epoch: string, hash = 'a'.repeat(64)): AppPluginSnapshot => ({
    id: 'fixture',
    version: '1.0.0',
    hash,
    epoch,
    installed: true,
    state: 'active',
    browserEntry: `/assets/app-plugins/${hash}/${epoch}/browser.mjs`,
    slots: ['composer.mode'],
  });
  try {
    await registry.update([row('first')]);
    hosts[0].uiState.set('draft', {
      text: 'body',
      attachments: ['image.png'],
      pending: { requestId: 'same-unknown' },
    });
    await registry.update([{ ...row('first'), state: 'cleanup', browserEntry: undefined }]);
    expect(registry.getModes()).toEqual([]);
    expect(() => hosts[0].uiState.set('draft', {})).toThrow('appPluginRetired');
    await registry.update([row('second')]);
    expect(hosts[1].uiState.get('draft')).toEqual({
      text: 'body',
      attachments: ['image.png'],
      pending: { requestId: 'same-unknown' },
    });
    await registry.update([row('third', 'b'.repeat(64))]);
    expect(hosts[2].uiState.get('draft')).toBeUndefined();
    hosts[2].uiState.set('draft', 'new hash');
    await registry.update([]);
    await registry.update([row('fourth', 'b'.repeat(64))]);
    expect(hosts[3].uiState.get('draft')).toBeUndefined();
  } finally {
    registry.dispose();
  }
});
