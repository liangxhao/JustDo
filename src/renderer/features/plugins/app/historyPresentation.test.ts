// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import type { AppBrowserModule } from '../../../../../plugins/sdk/app-plugin-sdk/browser';
import type {
  AppPluginBridge,
  AppPluginSnapshot,
} from '../../../../../plugins/sdk/app-plugin-sdk/contracts';
import type { AppHistoryPresentationModule } from '../../../../../plugins/sdk/app-plugin-sdk/history-presentation';
import { AppBrowserRegistry } from './browserRegistry';
import {
  pluginMessageDisplayText,
  pluginMessagePresentation,
  pluginMessageText,
  registerMessagePresentation,
  subscribeMessagePresentation,
} from './messagePresentation';

const prefix = 'Fixture instruction\n';
const appendFixtureInstruction = (text: string) => prefix + text;
const fixturePresentation: AppHistoryPresentationModule['presentation'] = {
  text: source => source.startsWith(prefix) ? source.slice(prefix.length) : source,
  nativeInput: value => (value as { role?: string })?.role === 'user'
    ? { senderLabelKey: 'fixtureDispatcher', senderId: 'fixture:dispatcher' } : undefined,
  translations: { en: { fixtureDispatcher: 'Dispatcher' }, zh: { fixtureDispatcher: '调度者' } },
};

const disposers: (() => void)[] = [];
afterEach(() => {
  disposers
    .splice(0)
    .reverse()
    .forEach(dispose => dispose());
  vi.restoreAllMocks();
});
const row = (hash = 'a'.repeat(64)): AppPluginSnapshot => ({
  id: 'history-owner',
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
    presentation: fixturePresentation,
  }),
) {
  const dictionary = new Map<
    string,
    { en: Readonly<Record<string, string>>; zh: Readonly<Record<string, string>> }
  >();
  const loadBusiness = vi.fn(async (_url: string): Promise<AppBrowserModule> => ({ register: () => {} }));
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
  const legacy = appendFixtureInstruction('Visible user question');
  expect(pluginMessageText(legacy)).toBe(legacy);
  await f.registry.update([row()]);
  expect(pluginMessageText(legacy)).toBe('Visible user question');
  expect(f.loadBusiness).not.toHaveBeenCalled();
  expect(f.registry.getViews()).toEqual([]);
  expect(f.registry.getModes()).toEqual([]);
  expect(
    pluginMessagePresentation({
      role: 'user',
      __openclaw: { transport: { channel: 'fixture-channel' } },
    }),
  ).toEqual({
    senderLabel: fixturePresentation.translations!.en.fixtureDispatcher,
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
  resolve({ presentation: fixturePresentation });
  await pending;
  expect(pluginMessageText('raw')).toBe('new owner');
  await f.registry.update([]);
  expect(pluginMessageText('raw')).toBe('raw');
});

test('unknown inventory withdraws a late display load until repair confirms the same hash', async () => {
  let resolve!: (value: AppHistoryPresentationModule) => void;
  const old = new Promise<AppHistoryPresentationModule>(done => { resolve = done; });
  let loads = 0;
  const f = fixture(async () => ++loads === 1 ? old : ({ presentation: fixturePresentation }));
  const pending = f.registry.update([row()]);
  await f.registry.update([{ ...row(), presentationEntry: undefined }]);
  resolve({ presentation: fixturePresentation });
  await pending;
  const source = appendFixtureInstruction('question');
  expect(pluginMessageText(source)).toBe(source);
  await f.registry.update([row()]);
  expect(pluginMessageText(source)).toBe('question');
});

test('installed display-only rules use the current product locale without touching transport text', async () => {
  const previousLanguage = i18nService.getLanguage();
  disposers.push(() => i18nService.setLanguage(previousLanguage, { persist: false }));
  i18nService.setLanguage('en', { persist: false });
  const display = vi.fn((source: string, context?: { readonly language: 'zh' | 'en' }) =>
    source.replace('[reference]', context?.language === 'zh' ? '引用' : 'Reference'));
  const f = fixture(async () => ({ presentation: { displayText: display } }));
  const source = 'Visible [reference]';
  await f.registry.update([row()]);

  expect(f.loadBusiness).not.toHaveBeenCalled();
  expect(pluginMessageText(source)).toBe(source);
  expect(display).not.toHaveBeenCalled();
  expect(pluginMessageDisplayText(source)).toBe('Visible Reference');
  expect(display.mock.calls[0][1]).toEqual({ language: 'en' });
  expect(Object.isFrozen(display.mock.calls[0][1])).toBe(true);

  const revision = vi.fn();
  disposers.push(subscribeMessagePresentation(revision));
  i18nService.setLanguage('zh', { persist: false });
  expect(revision).toHaveBeenCalledOnce();
  expect(pluginMessageDisplayText(source)).toBe('Visible 引用');
  expect(display.mock.calls.at(-1)?.[1]).toEqual({ language: 'zh' });

  await f.registry.update([{ ...row(), state: 'cleanup', epoch: 'disabled' }]);
  expect(pluginMessageDisplayText(source)).toBe('Visible 引用');
  await f.registry.update([]);
  expect(pluginMessageDisplayText(source)).toBe(source);
});

test('active display rules receive the same plain locale context and retire with their business epoch', async () => {
  const previousLanguage = i18nService.getLanguage();
  disposers.push(() => i18nService.setLanguage(previousLanguage, { persist: false }));
  i18nService.setLanguage('en', { persist: false });
  const f = fixture();
  f.loadBusiness.mockImplementation(async () => ({
    register(host) {
      host.registerMessagePresentation({ displayText: (source, context) => `${context?.language}:${source}` });
    },
  }));
  const snapshot: AppPluginSnapshot = {
    ...row(),
    state: 'active',
    presentationEntry: undefined,
    browserEntry: `/assets/app-plugins/${'a'.repeat(64)}/first/browser.mjs`,
    slots: ['messages.presentation'],
  };
  await f.registry.update([snapshot]);
  expect(pluginMessageDisplayText('visible')).toBe('en:visible');
  i18nService.setLanguage('zh', { persist: false });
  expect(pluginMessageDisplayText('visible')).toBe('zh:visible');
  await f.registry.update([]);
  expect(pluginMessageDisplayText('visible')).toBe('visible');
});

test('display-only preferences subscribe once and release when the final owner withdraws', () => {
  const unsubscribe = vi.fn();
  const subscribe = vi.spyOn(i18nService, 'subscribe').mockReturnValue(unsubscribe);
  const language = vi.spyOn(i18nService, 'getLanguage');
  const releaseText = registerMessagePresentation('transport-fixture', { text: source => source });
  disposers.push(releaseText);
  expect(pluginMessageDisplayText('raw')).toBe('raw');
  expect(subscribe).not.toHaveBeenCalled();
  expect(language).not.toHaveBeenCalled();

  const releaseFirst = registerMessagePresentation('display-first', { displayText: source => source });
  const releaseSecond = registerMessagePresentation('display-second', { displayText: source => source });
  disposers.push(releaseFirst, releaseSecond);
  expect(subscribe).toHaveBeenCalledOnce();
  releaseFirst();
  expect(unsubscribe).not.toHaveBeenCalled();
  releaseSecond();
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(pluginMessageDisplayText('raw')).toBe('raw');
  expect(language).not.toHaveBeenCalled();
});

test('failed display rules preserve source and do not change single-argument transport contributors', () => {
  disposers.push(registerMessagePresentation('transport-owner', {
    text: source => source.startsWith(prefix) ? source.slice(prefix.length) : source,
    displayText: () => { throw new Error('Retired fixture'); },
  }));
  expect(pluginMessageText(appendFixtureInstruction('Visible input'))).toBe('Visible input');
  expect(pluginMessageDisplayText('Visible input')).toBe('Visible input');
});
