// @vitest-environment jsdom
import type {
  AppBrowserContribution,
  AppBrowserHost,
  AppSessionPresentation,
} from '@app-plugin/sdk/browser';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import type { SwarmWorkflowChangedEvent } from '../../contracts/events';
import type { SwarmWorkflowView } from '../../contracts/workflow';
import { i18nService } from '../../tests/browserRuntime';
import { register } from './index';

const releases: (() => void)[] = [];
afterEach(() => {
  cleanup();
  releases.splice(0).forEach(release => release());
});

function fixture() {
  i18nService.setLanguage('en', { persist: false });
  const controller = new AbortController();
  const views: AppBrowserContribution[] = [];
  const events = new Set<(event: SwarmWorkflowChangedEvent) => void>();
  const metadataListeners = new Set<() => void>();
  let metadata = { cowork: { currentSession: { id: 'source' }, sessions: [] } };
  let presentation!: (id: string) => AppSessionPresentation | undefined;
  let flows: SwarmWorkflowView[] = [];
  let running = false;
  const invoke = vi.fn<(command: string, ...args: unknown[]) => Promise<unknown>>(async command => {
    if (command === 'workflow.activity')
      return { success: true, sessionIds: running ? ['source'] : [] };
    if (command === 'workflow.summary') return { success: true, count: flows.length, running };
    if (command === 'workflow.list') return { success: true, flows, running };
    throw new Error('Unexpected workflow command');
  });
  const publish = vi.fn();
  const openWorkspace = vi.fn();
  const host = {
    signal: controller.signal,
    invoke,
    onEvent: (_name: string, listener: (event: SwarmWorkflowChangedEvent) => void) => {
      events.add(listener);
      return () => events.delete(listener);
    },
    application: {
      metadata: {
        getSnapshot: () => metadata,
        subscribe: (listener: () => void) => {
          metadataListeners.add(listener);
          return () => metadataListeners.delete(listener);
        },
      },
    },
    registerView: (view: AppBrowserContribution) => views.push(view),
    registerSessionPresentation: (resolve: typeof presentation) => {
      presentation = resolve;
    },
    registerMode: vi.fn(),
    t: i18nService.t,
    openWorkspace,
    interactionContextChanged: vi.fn(),
    publishSessionActivity: publish,
  } as unknown as AppBrowserHost;
  const release = register(host);
  releases.push(() => {
    controller.abort();
    release();
  });
  const Observer = views.find(view => view.id === 'workflow-observer')!.component;
  const Graph = views.find(view => view.id === 'workflow')!.component;
  return {
    Observer,
    Graph,
    invoke,
    publish,
    openWorkspace,
    presentation: (id: string) => presentation(id),
    update(next: SwarmWorkflowView[], active: boolean) {
      flows = next;
      running = active;
      const latest = next[0];
      events.forEach(listener =>
        listener({ sessionId: 'source', flowId: latest.id, revision: latest.revision }),
      );
    },
    select(sessionId: string) {
      metadata = { cowork: { currentSession: { id: sessionId }, sessions: [] } };
      metadataListeners.forEach(listener => listener());
    },
  };
}

const flow: SwarmWorkflowView = {
  id: 'flow', revision: 1, goal: 'Inspect application', createdAt: 1, status: 'running',
  nodes: [{ id: 'work', title: 'Review changes', kind: 'work', status: 'running', deps: [] }],
};

test('native change notices refresh activity, closed summary discovery and an open graph', async () => {
  const fixturePorts = fixture();
  const { Observer, Graph, publish, openWorkspace, presentation, update } = fixturePorts;
  render(<Observer />);
  await waitFor(() => expect(publish).toHaveBeenCalledWith([]));
  expect(presentation('source')).toBeUndefined();
  act(() => update([flow], true));
  await waitFor(() => expect(publish).toHaveBeenLastCalledWith(['source']));
  await waitFor(() => expect(presentation('source')).toEqual({ summaryAvailable: true }));
  expect(openWorkspace).toHaveBeenCalledExactlyOnceWith('workflow', 'source');

  const graph = render(
    <Graph session={{ id: 'source', title: 'Source', cwd: '', agentId: 'main', status: 'idle' }} active />,
  );
  await screen.findByRole('button', { name: 'Review changes: Running' });
  act(() => update([
    { ...flow, revision: 2, status: 'completed', nodes: [{ ...flow.nodes[0], status: 'done' }] },
  ], false));
  await screen.findByRole('button', { name: 'Review changes: Complete' });
  await waitFor(() => expect(publish).toHaveBeenLastCalledWith([]));
  expect(openWorkspace).toHaveBeenCalledOnce();

  graph.unmount();
  act(() => update([{ ...flow, revision: 3 }], true));
  await waitFor(() => expect(publish).toHaveBeenLastCalledWith(['source']));
  expect(openWorkspace).toHaveBeenCalledOnce();
  act(() => update([{ ...flow, id: 'new-flow', revision: 1 }, flow], true));
  await waitFor(() => expect(openWorkspace).toHaveBeenCalledTimes(2));
});

test('a late discovery cannot navigate back to a conversation selected earlier', async () => {
  const { Observer, invoke, openWorkspace, select } = fixture();
  let finish!: (value: unknown) => void;
  invoke.mockImplementation(async (command: string) => {
    if (command === 'workflow.summary') return new Promise(resolve => { finish = resolve; });
    return { success: true, sessionIds: [] };
  });
  render(<Observer />);
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  const finishSource = finish;
  act(() => select('other'));
  await act(async () => finishSource({ success: true, count: 1, running: true }));
  expect(openWorkspace).not.toHaveBeenCalled();
});

test('retains completed history in the summary without automatically opening its graph', async () => {
  const { Observer, update, presentation, openWorkspace } = fixture();
  update([{ ...flow, status: 'completed' }], false);
  render(<Observer />);
  await waitFor(() => expect(presentation('source')).toEqual({ summaryAvailable: true }));
  expect(openWorkspace).not.toHaveBeenCalled();
});
