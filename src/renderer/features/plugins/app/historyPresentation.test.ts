// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';

import type {
  AppPluginBridge,
  AppPluginSnapshot,
} from '../../../../../plugins/sdk/app-plugin-sdk/contracts';
import type { AppHistoryPresentationModule } from '../../../../../plugins/sdk/app-plugin-sdk/history-presentation';
import { AppBrowserRegistry } from './browserRegistry';
import {
  pluginMessagePresentation,
  pluginMessageText,
  subscribeMessagePresentation,
} from './messagePresentation';

const prefix = 'Fixture instruction\n';
const appendAgentTeamInstruction = (text: string, _mode: string) => prefix + text;
const team: AppHistoryPresentationModule['presentation'] = {
  text: source => source.startsWith(prefix) ? source.slice(prefix.length) : source,
  nativeInput: value => (value as { role?: string })?.role === 'user'
    ? { senderLabelKey: 'fixtureDispatcher', senderId: 'fixture:dispatcher' } : undefined,
  translations: { en: { fixtureDispatcher: 'Dispatcher' }, zh: { fixtureDispatcher: '调度者' } },
};

const disposers: (() => void)[] = [];
afterEach(() =>
  disposers
    .splice(0)
    .reverse()
    .forEach(dispose => dispose()),
);
const row = (hash = 'a'.repeat(64)): AppPluginSnapshot => ({
  id: 'agent-team',
  version: '1.0.0',
  hash,
  epoch: 'first',
  state: 'prepared',
  installed: true,
  presentationEntry: `/assets/app-plugins/${hash}/presentation/presentation.mjs`,
});
const bridge: AppPluginBridge = {
  snapshot: async () => [],
  invoke: vi.fn(),
  onChanged: () => () => {},
};
function fixture(
  load: (url: string) => Promise<AppHistoryPresentationModule> = async () => ({
    presentation: team,
  }),
) {
  const dictionary = new Map<
    string,
    { en: Readonly<Record<string, string>>; zh: Readonly<Record<string, string>> }
  >();
  const loadBusiness = vi.fn(async () => ({ register: () => {} }));
  const registry = new AppBrowserRegistry(
    bridge,
    {
      t: key => [...dictionary.values()].map(value => value.en[key]).find(Boolean) ?? key,
      translations: (id, value) => {
        dictionary.set(id, value);
        return () => {
          if (dictionary.get(id) === value) dictionary.delete(id);
        };
      },
      components: {},
      renderHistory: () => null,
    },
    loadBusiness,
    load,
  );
  disposers.push(() => registry.dispose());
  return { registry, loadBusiness, dictionary };
}

test('keeps legacy pure history display and dictionaries while disabled, with no business ports or entries', async () => {
  const f = fixture();
  const revision = vi.fn();
  disposers.push(subscribeMessagePresentation(revision));
  const legacy = appendAgentTeamInstruction('Visible user question', 'task');
  expect(pluginMessageText(legacy)).toBe(legacy);
  await f.registry.update([row()]);
  expect(pluginMessageText(legacy)).toBe('Visible user question');
  expect(f.loadBusiness).not.toHaveBeenCalled();
  expect(f.registry.getViews()).toEqual([]);
  expect(f.registry.getModes()).toEqual([]);
  expect(
    pluginMessagePresentation({
      role: 'user',
      __openclaw: { transport: { channel: 'agent-team' } },
    }),
  ).toEqual({
    senderLabel: team.translations!.en.fixtureDispatcher,
    senderId: 'fixture:dispatcher',
  });
  await f.registry.update([{ ...row(), epoch: 'second', state: 'cleanup' }]);
  expect(pluginMessageText(legacy)).toBe('Visible user question');
  expect(revision).toHaveBeenCalledTimes(1);
  await f.registry.update([{ ...row(), presentationEntry: undefined }]);
  expect(pluginMessageText(legacy)).toBe(legacy);
  expect(f.dictionary.size).toBe(0);
  expect(revision).toHaveBeenCalledTimes(2);
});

test('late old presentation load cannot restore an uninstalled or replaced hash', async () => {
  let resolve!: (value: AppHistoryPresentationModule) => void;
  const old = new Promise<AppHistoryPresentationModule>(done => {
    resolve = done;
  });
  const f = fixture(async url =>
    url.includes('a'.repeat(64)) ? old : { presentation: { text: () => 'new owner' } },
  );
  const pending = f.registry.update([row()]);
  await f.registry.update([row('b'.repeat(64))]);
  resolve({ presentation: team });
  await pending;
  expect(pluginMessageText('raw')).toBe('new owner');
  await f.registry.update([]);
  expect(pluginMessageText('raw')).toBe('raw');
});

test('unknown inventory withdraws a late display load until repair confirms the same hash', async () => {
  let resolve!: (value: AppHistoryPresentationModule) => void;
  const old = new Promise<AppHistoryPresentationModule>(done => { resolve = done; });
  let loads = 0;
  const f = fixture(async () => ++loads === 1 ? old : ({ presentation: team }));
  const pending = f.registry.update([row()]);
  await f.registry.update([{ ...row(), presentationEntry: undefined }]);
  resolve({ presentation: team });
  await pending;
  const source = appendAgentTeamInstruction('question', 'task');
  expect(pluginMessageText(source)).toBe(source);
  await f.registry.update([row()]);
  expect(pluginMessageText(source)).toBe('question');
});
