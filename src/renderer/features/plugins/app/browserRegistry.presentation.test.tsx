// @vitest-environment jsdom
import type { AppBrowserHost, AppBrowserModule } from '@app-plugin/sdk/browser';
import type { AppPluginSnapshot } from '@app-plugin/sdk/contracts';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import { AppBrowserRegistry } from './browserRegistry';

const instances: AppBrowserRegistry[] = [];
afterEach(() => {
  cleanup();
  instances.splice(0).forEach(registry => registry.dispose());
  vi.restoreAllMocks();
});

const snapshot = (epoch = 'first'): AppPluginSnapshot => ({
  id: 'presentation-owner',
  hash: 'c'.repeat(64),
  version: '1.0.0',
  epoch,
  state: 'active',
  browserEntry: `/assets/app-plugins/${'c'.repeat(64)}/${epoch}/browser.mjs`,
  slots: ['interactions.presentation', 'session.presentation', 'workspace.tab'],
});

function registry(load: (url: string) => Promise<AppBrowserModule>) {
  const instance = new AppBrowserRegistry(
    {
      snapshot: async () => [],
      invoke: async () => undefined,
      onChanged: () => () => undefined,
    },
    {
      t: key => key,
      translations: () => () => undefined,
      components: {},
      renderHistory: () => null,
    },
    load,
  );
  instances.push(instance);
  return instance;
}

function Projection({ value }: { value: AppBrowserRegistry }) {
  useSyncExternalStore(value.subscribe, value.getContextRevision);
  return (
    <>
      <output aria-label="Question projection">
        {value.interactionPresentation('child')?.label ?? 'none'}
      </output>
      <output aria-label="Session projection">
        {value.sessionPresentation('source').titleSuffix ?? 'none'}
      </output>
    </>
  );
}

test('loading and partial synchronous registration cannot publish business provenance; completion updates existing projections', async () => {
  let complete!: (module: AppBrowserModule) => void;
  const loading = new Promise<AppBrowserModule>(resolve => {
    complete = resolve;
  });
  const value = registry(() => loading);
  render(<Projection value={value} />);
  const update = value.update([snapshot()]);
  expect(value.isBusinessCurrent('presentation-owner', 'first')).toBe(false);
  const observed: boolean[] = [];
  const release = value.subscribe(() => {
    observed.push(value.isBusinessCurrent('presentation-owner'));
  });
  await act(async () => {
    complete({
      register(host) {
        host.registerInteractionPresentation(() => ({ visible: true, label: 'Exact child' }));
        host.registerSessionPresentation(() => ({ titleSuffix: 'Exact source' }));
        host.interactionContextChanged();
        // Another contribution can notify subscribers while register is still running.
        host.registerView({
          id: 'workspace',
          slot: 'workspace.tab',
          labelKey: 'Workspace',
          component: () => null,
        });
        expect(value.isBusinessCurrent('presentation-owner')).toBe(false);
        expect(value.interactionPresentation('child')).toBeUndefined();
        expect(value.sessionPresentation('source')).toEqual({});
      },
    });
    await update;
  });
  expect(value.isBusinessCurrent('presentation-owner', 'first')).toBe(true);
  expect(observed).toContain(false);
  expect(observed.at(-1)).toBe(true);
  expect(screen.getByLabelText('Question projection').textContent).toBe('Exact child');
  expect(screen.getByLabelText('Session projection').textContent).toBe('Exact source');
  release();
});

test('adding and releasing presentation contributions after registration updates mounted consumers without manual context notifications', async () => {
  let host!: AppBrowserHost;
  const value = registry(async () => ({
    register(current) {
      host = current;
    },
  }));
  await value.update([snapshot()]);
  render(<Projection value={value} />);
  let releaseQuestion!: () => void;
  let releaseSession!: () => void;
  act(() => {
    releaseQuestion = host.registerInteractionPresentation(() => ({
      visible: true,
      label: 'New child',
    }));
    releaseSession = host.registerSessionPresentation(() => ({ titleSuffix: 'New source' }));
  });
  expect(screen.getByLabelText('Question projection').textContent).toBe('New child');
  expect(screen.getByLabelText('Session projection').textContent).toBe('New source');
  act(releaseQuestion);
  expect(screen.getByLabelText('Question projection').textContent).toBe('none');
  expect(screen.getByLabelText('Session projection').textContent).toBe('New source');
  act(releaseSession);
  expect(screen.getByLabelText('Session projection').textContent).toBe('none');
});

test('a registration failure withdraws partial projections and never announces that the owner is ready', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let leakedHost!: AppBrowserHost;
  const value = registry(async () => ({
    register(host) {
      leakedHost = host;
      host.registerInteractionPresentation(() => ({ visible: true, label: 'Partial child' }));
      host.registerSessionPresentation(() => ({ titleSuffix: 'Partial source' }));
      host.registerView({
        id: 'workspace',
        slot: 'workspace.tab',
        labelKey: 'Workspace',
        component: () => null,
      });
      throw new Error('Deliberate invalid Browser registration');
    },
  }));
  const ready = vi.fn(() => value.isBusinessCurrent('presentation-owner'));
  value.subscribe(ready);
  render(<Projection value={value} />);
  await act(async () => {
    await value.update([snapshot()]);
  });
  expect(ready.mock.results.every(result => result.value === false)).toBe(true);
  expect(value.getViews()).toHaveLength(0);
  expect(value.interactionPresentation('child')).toBeUndefined();
  expect(value.sessionPresentation('source')).toEqual({});
  expect(screen.getByLabelText('Question projection').textContent).toBe('none');
  expect(() => leakedHost.registerInteractionPresentation(() => ({ visible: true }))).toThrow(
    'appPluginRetired',
  );
  expect(error).toHaveBeenCalledOnce();
});

test('a retired Browser host cannot add projections after a new epoch has registered', async () => {
  const hosts: AppBrowserHost[] = [];
  const value = registry(async () => ({
    register(host) {
      hosts.push(host);
    },
  }));
  await value.update([snapshot()]);
  render(<Projection value={value} />);
  await act(async () => {
    await value.update([snapshot('second')]);
  });
  expect(value.isBusinessCurrent('presentation-owner', 'first')).toBe(false);
  expect(value.isBusinessCurrent('presentation-owner', 'second')).toBe(true);
  expect(() =>
    hosts[0].registerSessionPresentation(() => ({ titleSuffix: 'Retired source' })),
  ).toThrow('appPluginRetired');
  act(() => {
    hosts[1].registerSessionPresentation(() => ({ titleSuffix: 'Current source' }));
  });
  expect(screen.getByLabelText('Session projection').textContent).toBe('Current source');
});
