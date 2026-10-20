// @vitest-environment jsdom
import type {
  AppBrowserContribution,
  AppBrowserHost,
  AppComposerMode,
  AppSessionPresentation,
} from '@app-plugin/sdk/browser';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import manifest from '../../app.plugin.json';

const fixture = vi.hoisted(() => ({
  metadata: { cowork: { currentSession: { id: 'source' } } },
  count: 0,
  activity: {} as Record<string, boolean>,
  confirmed: false,
}));
vi.mock('./SwarmWorkflowPanel', () => ({ default: () => null }));
vi.mock('./workflowBrowserPorts', () => ({ bindBrowserHost: () => () => undefined }));
vi.mock('./useSwarmWorkflowDiscovery', () => ({
  useSwarmWorkflowDiscovery: () => ({ count: fixture.count }),
}));
vi.mock('./useSwarmWorkflowActivity', async () => {
  const { useEffect } = await import('react');
  return {
    useSwarmWorkflowActivity: (
      _ids: string[],
      _availability: unknown,
      publish: (ids: string[]) => void,
    ) => {
      useEffect(() => {
        if (fixture.confirmed)
          publish(Object.keys(fixture.activity).filter(id => fixture.activity[id]));
      }, [publish, fixture.activity, fixture.confirmed]);
      return fixture.activity;
    },
  };
});
import { register } from './index';

afterEach(() => {
  cleanup();
  fixture.metadata = { cowork: { currentSession: { id: 'source' } } };
  fixture.count = 0;
  fixture.activity = {};
  fixture.confirmed = false;
});

test.each([
  ['disabled', 'swarmWorkflowDisabled'],
  ['plan', 'swarmWorkflowPlan'],
  ['invalid', 'swarmWorkflowInvalid'],
  ['unavailable', 'swarmWorkflowPrepareUnavailable'],
])('preserves the %s preparation rejection from the owning workflow service', async (reason, messageKey) => {
  let mode!: AppComposerMode;
  const invoke = vi.fn().mockResolvedValue({ success: false, reason });
  register({
    signal: new AbortController().signal,
    registerView: vi.fn(), registerSessionPresentation: vi.fn(), registerMessagePresentation: vi.fn(),
    registerTranslations: vi.fn(), registerMode: (value: AppComposerMode) => { mode = value; }, invoke,
  } as unknown as AppBrowserHost);
  await expect(mode.prepare({ prompt: 'Review the project', sessionId: 'source' })).rejects.toThrow(messageKey);
  expect(invoke).toHaveBeenCalledExactlyOnceWith('workflow.prepare', { mode: 'auto', verify: true }, 'source');
});

test('presents preparation transport failures as unavailable without accepting the draft', async () => {
  let mode!: AppComposerMode;
  const invoke = vi.fn().mockRejectedValue(new Error('Native connection unavailable'));
  register({
    signal: new AbortController().signal,
    registerView: vi.fn(), registerSessionPresentation: vi.fn(), registerMessagePresentation: vi.fn(),
    registerTranslations: vi.fn(), registerMode: (value: AppComposerMode) => { mode = value; }, invoke,
  } as unknown as AppBrowserHost);
  await expect(mode.prepare({ prompt: 'Review the project', sessionId: 'source' }))
    .rejects.toThrow('swarmWorkflowPrepareUnavailable');
  expect(invoke).toHaveBeenCalledOnce();
});

test('discovers workflow summary content while summary and graph remain closed and retires the projection', () => {
  const controller = new AbortController();
  const views: AppBrowserContribution[] = [];
  let presentation!: (id: string) => AppSessionPresentation | undefined;
  const changed = vi.fn();
  const publish = vi.fn();
  const openWorkspace = vi.fn();
  const host = {
    signal: controller.signal,
    application: {
      metadata: { getSnapshot: () => fixture.metadata, subscribe: () => () => undefined },
    },
    registerView: (view: AppBrowserContribution) => {
      expect(manifest.slots).toContain(view.slot);
      views.push(view);
    },
    registerSessionPresentation: (resolve: typeof presentation) => {
      expect(manifest.slots).toContain('session.presentation');
      presentation = resolve;
      return () => undefined;
    },
    registerMode: vi.fn(),
    registerMessagePresentation: vi.fn(),
    registerTranslations: vi.fn(),
    t: (key: string) => key,
    openWorkspace,
    interactionContextChanged: changed,
    publishSessionActivity: publish,
  } as unknown as AppBrowserHost;
  register(host);
  const Observer = views.find(view => view.id === 'workflow-observer')!.component;
  const view = render(<Observer />);
  expect(presentation('source')).toBeUndefined();
  expect(publish).not.toHaveBeenCalled();
  fixture.count = 1;
  view.rerender(<Observer />);
  expect(presentation('source')).toEqual({ summaryAvailable: true });
  expect(presentation('other')).toBeUndefined();
  fixture.activity = { background: true };
  fixture.confirmed = true;
  view.rerender(<Observer />);
  expect(publish).toHaveBeenLastCalledWith(['background']);
  expect(presentation('source')).toEqual({ summaryAvailable: true });
  fixture.activity = {};
  view.rerender(<Observer />);
  expect(publish).toHaveBeenLastCalledWith([]);
  fixture.metadata = { cowork: { currentSession: { id: 'other' } } };
  fixture.count = 0;
  view.rerender(<Observer />);
  expect(presentation('source')).toBeUndefined();
  expect(presentation('other')).toBeUndefined();
  fixture.count = 2;
  view.rerender(<Observer />);
  expect(presentation('other')).toEqual({ summaryAvailable: true });
  const summary = views.find(entry => entry.id === 'workflow-summary')!;
  expect(summary.order).toBe(10);
  const Summary = summary.component;
  const close = vi.fn();
  render(
    <Summary
      session={{
        id: 'other',
        title: 'Other',
        cwd: '',
        agentId: 'main',
        status: 'idle',
      }}
      onClose={close}
    />,
  );
  const row = screen.getByRole('button', { name: 'swarmWorkflowTitle 2' });
  expect(row.className).toContain('session-summary-panel__action');
  expect(row.className).toContain('focus-visible:ring-2');
  expect(screen.getByText('swarmWorkflowTitle').className).toContain('flex-1');
  expect(screen.getByText('2').className).toContain('text-secondary');
  fireEvent.click(row);
  expect(close).toHaveBeenCalledOnce();
  expect(openWorkspace).toHaveBeenCalledExactlyOnceWith('workflow', 'other');
  controller.abort();
  const beforeUnmount = changed.mock.calls.length;
  view.unmount();
  expect(presentation('other')).toBeUndefined();
  expect(changed).toHaveBeenCalledTimes(beforeUnmount);
});
