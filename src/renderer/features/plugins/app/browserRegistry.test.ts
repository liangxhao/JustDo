// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type {
  AppBrowserHost,
  AppViewContext,
} from '../../../../../plugins/sdk/app-plugin-sdk/browser';
import type {
  AppPluginBridge,
  AppPluginEvent,
  AppPluginSnapshot,
} from '../../../../../plugins/sdk/app-plugin-sdk/contracts';
import { AppBrowserRegistry } from './browserRegistry';
import { pluginReplyMirror } from './messagePresentation';

const snapshot = (id = 'fixture', epoch = 'first'): AppPluginSnapshot => ({
  id,
  version: '1.0.0',
  hash: 'a'.repeat(64),
  epoch,
  state: 'active',
  browserEntry: `/assets/app-plugins/${'a'.repeat(64)}/${epoch}/browser.mjs`,
  slots: ['plugin.settings'],
  commands: ['settings.read'],
});
const bridge = (): AppPluginBridge => ({
  snapshot: async () => [],
  invoke: vi.fn(async () => ({ success: true })),
  onChanged: () => () => undefined,
});
const services = {
  t: (key: string) => key,
  translations: () => () => undefined,
  components: {},
  renderHistory: () => null,
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('app browser contribution lifetime', () => {
  it('rejects non-finite declared positions before they can enter view or mode ordering', async () => {
    const registry = new AppBrowserRegistry(bridge(), services, async () => ({
      register: host => {
        expect(() =>
          host.registerView({
            id: 'invalid-view',
            slot: 'plugin.settings',
            labelKey: 'Settings',
            order: Number.NaN,
            component: () => null,
          }),
        ).toThrow('appPluginInvalidRequest');
        expect(() =>
          host.registerMode({
            id: 'invalid-mode',
            labelKey: 'Mode',
            order: Number.POSITIVE_INFINITY,
            prepare: async input => ({ prompt: input.prompt }),
          }),
        ).toThrow('appPluginInvalidRequest');
        expect(() =>
          host.registerMode({
            id: 'invalid-group',
            labelKey: 'Mode',
            group: { id: 'group', labelKey: 'Group', order: Number.NaN },
            prepare: async input => ({ prompt: input.prompt }),
          }),
        ).toThrow('appPluginInvalidRequest');
        host.registerView({
          id: 'valid',
          slot: 'plugin.settings',
          labelKey: 'Settings',
          order: -0.5,
          component: () => null,
        });
      },
    }));
    await registry.update([{ ...snapshot(), slots: ['plugin.settings', 'composer.mode'] }]);
    expect(registry.getViews().map(view => view.id)).toEqual(['valid']);
    expect(registry.getModes()).toHaveLength(0);
    registry.dispose();
  });
  it('scopes view roots, contribution icons and composer options to their owning plugin', async () => {
    const registry = new AppBrowserRegistry(bridge(), services, async () => ({
      register: host => {
        host.registerView({
          id: 'settings',
          slot: 'plugin.settings',
          labelKey: 'Settings',
          icon: createElement('svg', { 'data-probe': 'view-icon' }),
          component: () => createElement('button', { 'data-probe': 'view' }, 'Settings'),
        });
        host.registerView({
          id: 'empty-icon',
          slot: 'plugin.settings',
          labelKey: 'Empty',
          icon: false,
          component: () => null,
        });
        host.registerMode({
          id: 'mode',
          labelKey: 'Mode',
          icon: createElement('svg', { 'data-probe': 'mode-icon' }),
          group: {
            id: 'group',
            labelKey: 'Group',
            icon: createElement('svg', { 'data-probe': 'group-icon' }),
          },
          component: () => createElement('input', { 'data-probe': 'mode-options' }),
          prepare: async input => ({ prompt: input.prompt }),
        });
        host.registerMode({
          id: 'default-icon',
          labelKey: 'Default',
          prepare: async input => ({ prompt: input.prompt }),
        });
      },
    }));
    await registry.update([{ ...snapshot(), slots: ['plugin.settings', 'composer.mode'] }]);
    const view = registry.getViews()[0];
    const mode = registry.getModes()[0];
    expect(registry.getViews()[1].icon).toBe(false);
    expect(registry.getModes()[1].icon).toBeUndefined();
    const mounted = render(
      createElement(
        'main',
        null,
        createElement(view.component, {}),
        view.icon,
        mode.icon,
        mode.group!.icon,
        createElement(mode.component!, { value: undefined, onChange() {} }),
      ),
    );
    for (const probe of ['view', 'view-icon', 'mode-icon', 'group-icon', 'mode-options']) {
      expect(
        mounted.container
          .querySelector(`[data-probe="${probe}"]`)
          ?.closest<HTMLElement>('[data-ui-style-scope]')?.dataset.uiStyleScope,
      ).toBe('fixture');
    }
    mounted.unmount();
    registry.dispose();
  });
  it('guards details replacement and a retained inspect callback with the contributing epoch', async () => {
    let presentation: 'replace' | 'append' | 'hidden' = 'replace';
    let received!: AppViewContext;
    const registry = new AppBrowserRegistry(bridge(), services, async () => ({
      register: host => {
        host.registerView({
          id: 'details',
          slot: 'session.details',
          labelKey: 'Details',
          detailsPresentation: () => presentation,
          component: context => {
            received = context;
            return null;
          },
        });
      },
    }));
    await registry.update([{ ...snapshot(), slots: ['session.details'] }]);
    const view = registry.getViews()[0];
    expect(view.detailsPresentation?.('session')).toBe('replace');
    presentation = 'invalid' as 'replace';
    expect(() => view.detailsPresentation?.('session')).toThrow('appPluginInvalidRequest');
    const inspect = vi.fn();
    const mounted = render(createElement(view.component, { onInspectSession: inspect }));
    const summary: NonNullable<AppViewContext['sessionSummary']> = {
      id: 'session',
      title: 'Session',
      status: 'idle',
      pinned: false,
      createdAt: 1,
      updatedAt: 1,
    };
    received.onInspectSession?.(summary);
    expect(inspect).toHaveBeenCalledExactlyOnceWith(summary);
    await registry.update([]);
    expect(() => view.detailsPresentation?.('session')).toThrow('appPluginRetired');
    expect(() => received.onInspectSession?.(summary)).toThrow('appPluginRetired');
    expect(inspect).toHaveBeenCalledOnce();
    mounted.unmount();
    registry.dispose();
  });
  it('binds standalone page visibility to the mounted plugin epoch', async () => {
    let context!: AppViewContext;
    const registry = new AppBrowserRegistry(bridge(), services, async () => ({
      register: host => {
        host.registerView({
          id: 'page',
          slot: 'application.page',
          labelKey: 'page',
          component: value => {
            context = value;
            return null;
          },
        });
      },
    }));
    const setVisible = vi.fn();
    await registry.update([{ ...snapshot(), slots: ['application.page'] }]);
    const mounted = render(
      createElement(registry.getViews()[0].component, { page: { setVisible } }),
    );
    const retired = context.page!.setVisible;
    retired(true);
    expect(setVisible).toHaveBeenCalledExactlyOnceWith(true);
    await registry.update([]);
    await registry.update([{ ...snapshot('fixture', 'second'), slots: ['application.page'] }]);
    expect(() => retired(true)).toThrow('appPluginRetired');
    expect(() => retired(false)).toThrow('appPluginRetired');
    expect(setVisible).toHaveBeenCalledOnce();
    mounted.unmount();
    registry.dispose();
  });
  it('withdraws exact reply-mirror presentation on disable and binds re-enable to the new owner', async () => {
    const registry = new AppBrowserRegistry(bridge(), services, async () => ({
      register: host => {
        const epoch = host.plugin.epoch;
        host.registerMessagePresentation({
          replyMirror: message => {
            if (message === 'broken') throw new Error('failed projection');
            return message === epoch;
          },
        });
      },
    }));
    try {
      await registry.update([{ ...snapshot(), slots: ['messages.presentation'] }]);
      expect(pluginReplyMirror('first')).toBe(true);
      expect(pluginReplyMirror('ordinary')).toBe(false);
      expect(pluginReplyMirror('broken')).toBe(false);
      await registry.update([]);
      expect(pluginReplyMirror('first')).toBe(false);
      await registry.update([
        { ...snapshot('fixture', 'second'), slots: ['messages.presentation'] },
      ]);
      expect(pluginReplyMirror('first')).toBe(false);
      expect(pluginReplyMirror('second')).toBe(true);
    } finally {
      registry.dispose();
    }
    expect(pluginReplyMirror('second')).toBe(false);
  });
  it('retains only confirmed activity on retirement until the new epoch publishes a complete snapshot', async () => {
    let host!: AppBrowserHost;
    const registry = new AppBrowserRegistry(bridge(), services, async () => ({
      register: value => {
        host = value;
        host.registerSessionPresentation(() => ({
          summaryAvailable: true,
          workspace: { contributionId: 'history' },
        }));
      },
    }));
    const admitted = { ...snapshot(), slots: ['session.presentation'] };
    await registry.update([admitted]);
    host.publishSessionActivity(['running-chat']);
    const retired = host;
    await registry.update([]);
    expect(registry.sessionPresentation('running-chat')).toEqual({ status: 'running' });
    expect(registry.sessionPresentation('idle-chat')).toEqual({});
    expect(registry.getViews()).toEqual([]);
    expect(registry.getWorkspaceRequests()).toEqual([]);
    expect(() => retired.publishSessionActivity([])).toThrow('appPluginRetired');
    await registry.update([{ ...snapshot('fixture', 'second'), slots: admitted.slots }]);
    expect(registry.sessionPresentation('running-chat').status).toBe('running');
    expect(() => retired.publishSessionActivity([])).toThrow('appPluginRetired');
    host.publishSessionActivity([]);
    expect(registry.sessionPresentation('running-chat').status).toBeUndefined();
    registry.dispose();
  });
  it('keeps activity owners independent and rejects malformed snapshots before clearing evidence', async () => {
    const hosts = new Map<string, AppBrowserHost>();
    const registry = new AppBrowserRegistry(bridge(), services, async () => ({
      register: host => {
        hosts.set(host.plugin.id, host);
      },
    }));
    await registry.update(
      ['one', 'two'].map(id => ({ ...snapshot(id), slots: ['session.presentation'] })),
    );
    hosts.get('one')!.publishSessionActivity(['shared']);
    hosts.get('two')!.publishSessionActivity(['shared']);
    expect(() => hosts.get('one')!.publishSessionActivity([''])).toThrow('appPluginInvalidRequest');
    hosts.get('one')!.publishSessionActivity([]);
    expect(registry.sessionPresentation('shared')).toEqual({ status: 'running' });
    hosts.get('two')!.publishSessionActivity([]);
    expect(registry.sessionPresentation('shared')).toEqual({});
    registry.dispose();
  });
  it('binds mounted native history effects to the host epoch and rejects a retained guard after re-enable', async () => {
    let host!: AppBrowserHost;
    let guard!: () => void;
    const renderHistory = vi.fn((input: Record<string, unknown>) => {
      guard = input.assertCurrent as () => void;
      return null;
    });
    const registry = new AppBrowserRegistry(bridge(), { ...services, renderHistory }, async () => ({
      register: value => {
        host = value;
      },
    }));
    await registry.update([snapshot()]);
    const oldHost = host;
    oldHost.renderHistory({ sessionKey: 'native-session', assertCurrent: () => undefined });
    expect(() => guard()).not.toThrow();
    const retired = guard;
    await registry.update([]);
    expect(() => retired()).toThrow('appPluginRetired');
    expect(() => oldHost.renderHistory({})).toThrow('appPluginRetired');
    await registry.update([snapshot('fixture', 'second')]);
    expect(() => retired()).toThrow('appPluginRetired');
    host.renderHistory({ sessionKey: 'native-session' });
    expect(() => guard()).not.toThrow();
    expect(renderHistory).toHaveBeenCalledTimes(2);
    registry.dispose();
  });
  it('filters events by artifact, owner, epoch and name and retires subscriptions', async () => {
    let host!: AppBrowserHost;
    let dispatch!: (event: AppPluginEvent) => void;
    const receive = vi.fn();
    const release = vi.fn();
    const api = bridge();
    api.onEvent = callback => {
      dispatch = callback;
      return release;
    };
    const registry = new AppBrowserRegistry(api, services, async () => ({
      register: value => {
        host = value;
        host.onEvent('changed', receive);
      },
    }));
    await registry.update([snapshot()]);
    const event = {
      id: 'fixture',
      hash: snapshot().hash,
      epoch: 'first',
      name: 'changed',
      payload: { revision: 1 },
    };
    for (const update of [
      { id: 'other' },
      { hash: 'b'.repeat(64) },
      { epoch: 'other' },
      { name: 'other' },
      { payload: new Date() },
    ])
      dispatch({ ...event, ...update });
    expect(receive).not.toHaveBeenCalled();
    dispatch(event);
    expect(receive).toHaveBeenCalledExactlyOnceWith({ revision: 1 });
    const old = dispatch;
    const oldHost = host;
    await registry.update([]);
    expect(release).toHaveBeenCalledOnce();
    old(event);
    expect(receive).toHaveBeenCalledTimes(1);
    expect(() => oldHost.onEvent('changed', receive)).toThrow('appPluginRetired');
    await registry.update([snapshot('fixture', 'second')]);
    old(event);
    dispatch({ ...event, epoch: 'second' });
    expect(receive).toHaveBeenCalledTimes(2);
  });
  it('removes settings and aborts an old UI immediately after disable', async () => {
    let host!: AppBrowserHost;
    const registry = new AppBrowserRegistry(bridge(), services, async () => ({
      register: value => {
        host = value;
        value.registerView({
          id: 'settings',
          slot: 'plugin.settings',
          labelKey: 'settings',
          component: () => null,
        });
      },
    }));
    await registry.update([snapshot()]);
    expect(registry.getViews()).toHaveLength(1);
    await registry.update([{ ...snapshot(), state: 'cleanup' }]);
    expect(registry.getViews()).toHaveLength(0);
    expect(host.signal.aborted).toBe(true);
    await expect(host.invoke('settings.read')).rejects.toThrow('appPluginRetired');
  });
  it('rejects an old UI response after disable and reenable', async () => {
    const reply = deferred<unknown>();
    const api = bridge();
    api.invoke = () => reply.promise;
    let host!: AppBrowserHost;
    const registry = new AppBrowserRegistry(api, services, async () => ({
      register: value => {
        host = value;
      },
    }));
    await registry.update([snapshot()]);
    const oldHost = host;
    const result = oldHost.invoke('settings.read');
    await registry.update([{ ...snapshot(), state: 'cleanup' }]);
    await registry.update([snapshot('fixture', 'second')]);
    reply.resolve({ success: true });
    await expect(result).rejects.toThrow('appPluginRetired');
    expect(host).not.toBe(oldHost);
  });
  it('does not publish late modules or subsequent plugins from an obsolete update', async () => {
    const loading = deferred<{ register(host: AppBrowserHost): void }>();
    const register = vi.fn();
    const load = vi.fn(() => loading.promise);
    const registry = new AppBrowserRegistry(bridge(), services, load);
    const old = registry.update([snapshot('first'), snapshot('second')]);
    await registry.update([]);
    loading.resolve({ register });
    await old;
    expect(register).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledOnce();
    expect(registry.getViews()).toEqual([]);
  });
  it('rejects undeclared slots and rolls back partial registration', async () => {
    const registry = new AppBrowserRegistry(bridge(), services, async () => ({
      register: host => {
        host.registerView({
          id: 'valid',
          slot: 'plugin.settings',
          labelKey: 'valid',
          component: () => null,
        });
        host.registerView({
          id: 'invalid',
          slot: 'other.surface',
          labelKey: 'invalid',
          component: () => null,
        });
      },
    }));
    await registry.update([snapshot()]);
    expect(registry.getViews()).toEqual([]);
  });
});
