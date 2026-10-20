// @vitest-environment jsdom
import type { SwarmWorkflowView } from '../contracts/index';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

vi.mock('./SwarmWorkflowDetailPanel', () => ({
  default: ({
    node,
    source,
    onBack,
  }: {
    node: { id: string; agentName?: string };
    source?: { id: string };
    onBack: () => void;
  }) => (
    <div>
      <span>{'Assigned agent: ' + node.agentName}</span>
      <span>Running</span>
      <span>{source ? source.id + ' → ' + node.id : 'history:' + node.id}</span>
      <button onClick={onBack}>Back</button>
    </div>
  ),
}));

import SwarmWorkflowPanel, { layoutFlow, routeFlowEdge } from './SwarmWorkflowPanel';
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const flow: SwarmWorkflowView = {
  id: 'flow',
  revision: 8,
  goal: 'Inspect application',
  createdAt: 1,
  status: 'running',
  nodes: [
    { id: 'plan', title: 'Plan', kind: 'plan', status: 'done', deps: [], sessionKey: 'plan' },
    {
      id: 'a',
      title: 'Security review',
      kind: 'work',
      status: 'running',
      deps: ['plan'],
      sessionKey: 'a',
    },
    {
      id: 'verify',
      title: 'Verify',
      kind: 'verify',
      status: 'queued',
      deps: ['a'],
      sessionKey: 'verify',
    },
  ],
};
function fixture() {
  i18nService.setLanguage('en', { persist: false });
  const read = vi.fn().mockResolvedValue({ success: true, flows: [flow] });
  const control = vi.fn().mockResolvedValue({ success: true });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      cowork: {
        getSwarmWorkflows: read,
        controlSwarmWorkflow: control,
        onSwarmWorkflowsChanged: vi.fn(() => () => {}),
      },
    },
  });
  return { read, control };
}
test('lays out actual dependencies before downstream tasks', () => {
  const { points } = layoutFlow(flow.nodes);
  expect(points.get('plan')!.y).toBeLessThan(points.get('a')!.y);
  expect(points.get('a')!.y).toBeLessThan(points.get('verify')!.y);
});

test('loads full workflows only while the graph panel is active', async () => {
  const { read } = fixture();
  const view = render(<SwarmWorkflowPanel sessionId="product" active={false} />);
  await act(async () => {});
  expect(read).not.toHaveBeenCalled();
  view.rerender(<SwarmWorkflowPanel sessionId="product" active />);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  view.rerender(<SwarmWorkflowPanel sessionId="product" active={false} />);
  view.rerender(<SwarmWorkflowPanel sessionId="product" active />);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
});

test('pauses graph reads while its owning window is hidden and revalidates on return', async () => {
  const { read } = fixture();
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  render(<SwarmWorkflowPanel sessionId="product" active />);
  await act(async () => {});
  expect(read).not.toHaveBeenCalled();
  act(() => {
    visibility.mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  act(() => {
    visibility.mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await act(async () => {});
  expect(read).toHaveBeenCalledTimes(1);
});

test('keeps controls disabled while a reopened graph revalidates its retained snapshot', async () => {
  const { read } = fixture();
  const view = render(<SwarmWorkflowPanel sessionId="product" active />);
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  view.rerender(<SwarmWorkflowPanel sessionId="product" active={false} />);
  let finish!: (result: unknown) => void;
  read.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  view.rerender(<SwarmWorkflowPanel sessionId="product" active />);
  expect(
    (screen.getByLabelText(i18nService.t('swarmWorkflowPause')) as HTMLButtonElement).disabled,
  ).toBe(true);
  await act(async () => finish({ success: true, flows: [{ ...flow, revision: 9 }] }));
  expect(
    (screen.getByLabelText(i18nService.t('swarmWorkflowPause')) as HTMLButtonElement).disabled,
  ).toBe(false);
});

test('fits on entry and workflow switches while preserving navigation through updates and details', () => {
  fixture();
  const observers = new Map<Element, ResizeObserverCallback>();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private target?: Element;
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        this.target = target;
        observers.set(target, this.callback);
      }
      disconnect() {
        if (this.target) observers.delete(this.target);
      }
    },
  );
  let width = 0;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(400);
  const other = { ...flow, id: 'other', goal: 'Another workflow' };
  const snapshot = { success: true as const, flows: [flow, other] };
  const view = render(
    <SwarmWorkflowPanel sessionId="product" active={false} snapshot={snapshot} />,
  );
  const graph = () => screen.getByRole('group', { name: 'Task dependency graph' });
  const transform = () => graph().style.transform;
  expect(transform()).toBe('translate(0px, 0px) scale(1)');

  width = 400;
  view.rerender(<SwarmWorkflowPanel sessionId="product" snapshot={snapshot} />);
  const fitted = transform();
  expect(fitted).not.toBe('translate(0px, 0px) scale(1)');
  fireEvent.click(screen.getByRole('button', { name: 'Fit to canvas' }));
  expect(transform()).toBe(fitted);

  const canvas = graph().parentElement!;
  width = 320;
  act(() => observers.get(canvas)!([], {} as ResizeObserver));
  expect(transform()).not.toBe(fitted);
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
  const zoomed = transform();
  expect(observers.has(canvas)).toBe(false);
  width = 400;
  view.rerender(
    <SwarmWorkflowPanel
      sessionId="product"
      snapshot={{ success: true, flows: [{ ...flow, revision: 9 }, other] }}
    />,
  );
  expect(transform()).toBe(zoomed);
  fireEvent.click(screen.getByRole('button', { name: 'Security review: Running' }));
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect(transform()).toBe(zoomed);

  fireEvent.click(screen.getByRole('button', { name: other.goal }));
  expect(transform()).toBe(fitted);
  fireEvent.click(screen.getByRole('button', { name: flow.goal }));
  expect(transform()).toBe(fitted);
});

test('centers parallel stages and uses direct connections without boxed elbows', () => {
  const nodes = [
    flow.nodes[0],
    ...['a', 'b'].map(id => ({ ...flow.nodes[1], id, deps: ['plan'] })),
    ...['c', 'd'].map(id => ({ ...flow.nodes[1], id, deps: ['a', 'b'] })),
    { ...flow.nodes[2], deps: ['c', 'd'] },
  ];
  for (const columns of [2, 3]) {
    const layout = layoutFlow(nodes, columns);
    const center = (id: string) => layout.points.get(id)!.x + 80;
    expect(center('plan')).toBe(layout.width / 2);
    expect(center('verify')).toBe(layout.width / 2);
    expect((center('a') + center('b')) / 2).toBe(layout.width / 2);
    const ac = routeFlowEdge(layout, 'a', 'c');
    const ad = routeFlowEdge(layout, 'a', 'd');
    const bc = routeFlowEdge(layout, 'b', 'c');
    expect(ac).toHaveLength(2);
    expect(ad).toHaveLength(2);
    expect(bc).toHaveLength(2);
    expect(ac[0].x).toBe(center('a'));
    expect(ad[1].x).toBe(center('d'));
    expect(bc[1].x).toBe(center('c'));
  }
});

test('animates the active flow and running or preparing node icons', async () => {
  fixture();
  const props = { sessionId: 'product', tasks: [], onOpenTask: () => {} };
  const snapshot = {
    success: true,
    flows: [
      {
        ...flow,
        nodes: [
          ...flow.nodes,
          {
            ...flow.nodes[1],
            id: 'preparing',
            title: 'Preparing task',
            status: 'preparing' as const,
          },
        ],
      },
    ],
  };
  const view = render(<SwarmWorkflowPanel {...props} snapshot={snapshot} />);
  await screen.findByRole('button', { name: 'Security review: Running' });
  expect(view.container.querySelectorAll('.swarm-spinner')).toHaveLength(3);
  view.rerender(<SwarmWorkflowPanel {...props} active={false} snapshot={snapshot} />);
  expect(view.container.querySelectorAll('.swarm-spinner')).toHaveLength(0);
});

test('routes skipped dependency levels and wrapped parallel rows outside every card', () => {
  const work = Array.from({ length: 8 }, (_, index) => ({
    ...flow.nodes[1],
    id: `work-${index}`,
    deps: ['plan'],
  }));
  const nodes = [
    flow.nodes[0],
    ...work,
    { ...flow.nodes[2], deps: work.map(node => node.id) },
    { ...flow.nodes[2], id: 'deliver', deps: ['verify', ...work.map(node => node.id)] },
  ];
  for (const columns of [2, 3]) {
    const layout = layoutFlow(nodes, columns);
    for (const target of nodes)
      for (const source of target.deps) {
        const route = routeFlowEdge(layout, source, target.id);
        expect(route.length).toBeGreaterThanOrEqual(2);
        for (let index = 1; index < route.length; index++) {
          const a = route[index - 1],
            b = route[index];
          if (route.length > 2) expect(a.x === b.x || a.y === b.y).toBe(true);
          for (const [id, card] of layout.points) {
            if (id === source || id === target.id) continue;
            let low = 0,
              high = 1;
            for (const axis of ['x', 'y'] as const) {
              const min = card[axis] + 0.01;
              const max = card[axis] + (axis === 'x' ? 160 : 72) - 0.01;
              const delta = b[axis] - a[axis];
              if (delta === 0) {
                if (a[axis] < min || a[axis] > max) high = -1;
              } else {
                const first = (min - a[axis]) / delta;
                const last = (max - a[axis]) / delta;
                low = Math.max(low, Math.min(first, last));
                high = Math.min(high, Math.max(first, last));
              }
            }
            const crosses = low <= high;
            expect(crosses, `${source} -> ${target.id} crosses ${id}`).toBe(false);
          }
        }
      }
  }
});

test('switches workflow subtabs and preserves manual selection until a new workflow is discovered', async () => {
  fixture();
  const old = { ...flow, id: 'old', goal: 'Older flow', status: 'completed' as const };
  const props = { sessionId: 'product', tasks: [], onOpenTask: () => {} };
  const view = render(
    <SwarmWorkflowPanel {...props} snapshot={{ success: true, flows: [flow, old] }} />,
  );
  await screen.findByRole('navigation', { name: 'Task flows' });
  expect(screen.queryByRole('combobox')).toBeNull();
  const olderTab = screen.getByRole('button', { name: 'Older flow' });
  expect(screen.getByRole('button', { name: flow.goal }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(olderTab);
  view.rerender(
    <SwarmWorkflowPanel
      {...props}
      active={false}
      snapshot={{ success: true, flows: [{ ...flow, revision: 9 }, old] }}
    />,
  );
  expect(olderTab.getAttribute('aria-pressed')).toBe('true');
  const latest = { ...flow, id: 'new', goal: 'New task' };
  view.rerender(
    <SwarmWorkflowPanel {...props} snapshot={{ success: true, flows: [latest, flow, old] }} />,
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'New task' }).getAttribute('aria-pressed')).toBe(
      'true',
    ),
  );
  expect(olderTab.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(olderTab);
  view.rerender(
    <SwarmWorkflowPanel
      {...props}
      snapshot={{ success: true, flows: [{ ...latest, revision: 10 }, flow, old] }}
    />,
  );
  expect(olderTab.getAttribute('aria-pressed')).toBe('true');
});

test('reveals the selected workflow subtab when the panel becomes narrower', async () => {
  fixture();
  const observers = new Map<Element, ResizeObserverCallback>();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element) {
        observers.set(target, this.callback);
      }
      disconnect() {}
    },
  );
  const old = { ...flow, id: 'old', goal: 'Older flow' };
  render(
    <SwarmWorkflowPanel sessionId="product" snapshot={{ success: true, flows: [flow, old] }} />,
  );
  const tabs = await screen.findByRole('navigation', { name: 'Task flows' });
  const olderTab = screen.getByRole('button', { name: old.goal });
  let width = 600;
  vi.spyOn(tabs, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, width, 40));
  vi.spyOn(olderTab, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(250 - tabs.scrollLeft, 0, 200, 28),
  );
  fireEvent.click(olderTab);
  expect(tabs.scrollLeft).toBe(0);
  width = 300;
  act(() => observers.get(tabs)!([], {} as ResizeObserver));
  expect(olderTab.getBoundingClientRect().right).toBeLessThanOrEqual(width - 12);
  expect(olderTab.getAttribute('aria-pressed')).toBe('true');
});

test('reveals a workflow discovered while hidden when the panel becomes active', async () => {
  fixture();
  const old = { ...flow, id: 'old', goal: 'Older flow' };
  const latest = { ...flow, id: 'latest', goal: 'New task' };
  const props = { sessionId: 'product', tasks: [], onOpenTask: () => {} };
  const view = render(
    <SwarmWorkflowPanel {...props} snapshot={{ success: true, flows: [flow, old] }} />,
  );
  const tabs = await screen.findByRole('navigation', { name: 'Task flows' });
  fireEvent.click(screen.getByRole('button', { name: old.goal }));
  let width = 0;
  vi.spyOn(tabs, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, width, 40));
  tabs.scrollLeft = 260;
  const snapshot = { success: true as const, flows: [latest, flow, old] };
  view.rerender(<SwarmWorkflowPanel {...props} active={false} snapshot={snapshot} />);
  const latestTab = screen.getByRole('button', { name: latest.goal });
  expect(latestTab.getAttribute('aria-pressed')).toBe('true');
  expect(tabs.scrollLeft).toBe(260);
  vi.spyOn(latestTab, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(12 - tabs.scrollLeft, 0, 200, 28),
  );
  width = 320;
  view.rerender(<SwarmWorkflowPanel {...props} snapshot={snapshot} />);
  expect(tabs.scrollLeft).toBe(0);
  expect(latestTab.getBoundingClientRect().left).toBe(12);
  expect(latestTab.getAttribute('aria-pressed')).toBe('true');
});

test.each([
  { entry: 'Security review: Running', detail: 'history:a' },
  { entry: 'Task message sent downstream: Plan → Security review', detail: 'plan → a' },
])(
  'switches workflows directly from $detail and clears the previous detail selection',
  async ({ entry, detail }) => {
    const f = fixture();
    const other = {
      ...flow,
      id: 'other',
      revision: 12,
      goal: 'Another workflow',
      nodes: flow.nodes.map(node =>
        node.id === 'a' ? { ...node, title: 'Another review' } : node,
      ),
    };
    render(
      <SwarmWorkflowPanel sessionId="product" snapshot={{ success: true, flows: [flow, other] }} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: entry }));
    expect(screen.getByText(detail)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: other.goal }));
    expect(screen.queryByText(detail)).toBeNull();
    expect(screen.getByRole('button', { name: 'Another review: Running' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pause new task dispatch' }));
    await waitFor(() => expect(f.control).toHaveBeenCalledWith('product', 'other', 12, 'pause'));
  },
);

test('keeps workflow subtabs available in batch item details and returns to the other graph', async () => {
  fixture();
  const counts = {
    total: 1,
    done: 0,
    failed: 1,
    running: 0,
    preparing: 0,
    uncertain: 0,
    cancelled: 0,
    queued: 0,
  };
  const batch = {
    ...flow.nodes[1],
    kind: 'batch' as const,
    title: 'Batch review',
    batchCounts: counts,
  };
  const batchFlow = { ...flow, nodes: [batch] };
  Object.defineProperty(window.electron.cowork, 'getSwarmWorkflowBatch', {
    value: vi.fn().mockResolvedValue({
      success: true,
      page: {
        flowId: flow.id,
        stageId: batch.id,
        revision: flow.revision,
        manifestVersion: 'v1',
        counts,
        matched: 1,
        retryable: 1,
        items: [
          { id: 'a', title: 'Batch item', status: 'failed', agentName: 'ReviewBot', attempt: 1 },
        ],
      },
    }),
  });
  const other = { ...flow, id: 'other', goal: 'Another workflow' };
  render(
    <SwarmWorkflowPanel
      sessionId="product"
      snapshot={{ success: true, flows: [batchFlow, other] }}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Batch review: Running' }));
  fireEvent.click(await screen.findByText('Batch item'));
  expect(screen.getByText('history:a')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: other.goal }));
  expect(screen.queryByText('history:a')).toBeNull();
  expect(screen.getByRole('button', { name: 'Security review: Running' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: flow.goal }));
  expect(screen.getByRole('button', { name: 'Batch review: Running' })).toBeTruthy();
  expect(screen.queryByText('Batch item')).toBeNull();
});

test('shows assigned agents and uses Team-style line weights while keeping straight dependency paths', async () => {
  fixture();
  const assigned = {
    ...flow,
    nodes: flow.nodes.map(node =>
      node.id === 'a' ? { ...node, agentId: 'reviewer', agentName: 'ReviewBot' } : node,
    ),
  };
  const { container } = render(
    <SwarmWorkflowPanel sessionId="product" snapshot={{ success: true, flows: [assigned] }} />,
  );
  await screen.findByText('@ReviewBot');
  const edges = container.querySelectorAll('path[marker-end]');
  expect(edges).toHaveLength(2);
  expect(edges[0].getAttribute('stroke-width')).toBe('1.5');
  expect(edges[0].getAttribute('d')).toMatch(/^M [\d. ]+(?:L [\d. ]+)+$/);
  expect(edges[1].getAttribute('stroke-dasharray')).toBe('5 4');
  fireEvent.click(screen.getByRole('button', { name: 'Security review: Running' }));
  expect(screen.getByText('history:a')).toBeTruthy();
  expect(screen.getByText('Assigned agent: ReviewBot')).toBeTruthy();
});
test('shows stages and sends revision-bound controls without rewriting native state', async () => {
  const f = fixture();
  render(<SwarmWorkflowPanel sessionId="product" />);
  await screen.findByRole('button', { name: 'Security review: Running' });
  fireEvent.click(screen.getByRole('button', { name: 'Pause new task dispatch' }));
  await waitFor(() => expect(f.control).toHaveBeenCalledWith('product', 'flow', 8, 'pause'));
  expect(screen.getByRole('img', { name: 'In progress' })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole('button', { name: 'Security review: Running' }), {
    key: 'Enter',
  });
  expect(screen.getByText('Running')).toBeTruthy();
});
test('keeps prior graph on disconnect and prevents controls on a stale snapshot', async () => {
  const f = fixture();
  render(<SwarmWorkflowPanel sessionId="product" />);
  await screen.findByRole('button', { name: 'Security review: Running' });
  f.read.mockResolvedValue({ success: false });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  await screen.findByText('Latest status unavailable. Showing the previous snapshot.');
  expect(screen.getByRole('button', { name: 'Security review: Running' })).toBeTruthy();
  expect(
    (screen.getByRole('button', { name: 'Pause new task dispatch' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
test('does not poll while the tab is hidden', async () => {
  const f = fixture();
  render(<SwarmWorkflowPanel sessionId="product" active={false} />);
  await act(async () => {});
  expect(f.read).not.toHaveBeenCalled();
});

test('uses the workspace snapshot without duplicate polling and refreshes it after a control', async () => {
  const f = fixture();
  const refresh = vi.fn();
  render(
    <SwarmWorkflowPanel
      sessionId="product"
      snapshot={{ success: true, flows: [flow] }}
      onRefresh={refresh}
    />,
  );
  await screen.findByRole('button', { name: 'Security review: Running' });
  expect(f.read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Pause new task dispatch' }));
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  expect(f.control).toHaveBeenCalledWith('product', 'flow', 8, 'pause');
});

test('opens the selected edge and returns to graph for node history', async () => {
  fixture();
  render(<SwarmWorkflowPanel sessionId="product" />);
  const edge = await screen.findByRole('button', {
    name: 'Task message sent downstream: Plan → Security review',
  });
  fireEvent.keyDown(edge, { key: 'Enter' });
  expect(screen.getByText('plan → a')).toBeTruthy();
  fireEvent.click(screen.getByText('Back'));
  fireEvent.click(screen.getByRole('button', { name: 'Security review: Running' }));
  expect(screen.getByText('history:a')).toBeTruthy();
});

test('shows the retry entry only when the engine confirms conclusive failed nodes are retryable', async () => {
  const f = fixture();
  const blocked = {
    ...flow,
    canRetry: true,
    status: 'blocked' as const,
    nodes: flow.nodes.map(node =>
      node.id === 'a' ? { ...node, status: 'failed' as const } : node,
    ),
  };
  const props = { sessionId: 'product', tasks: [], onOpenTask: () => {} };
  const view = render(
    <SwarmWorkflowPanel {...props} snapshot={{ success: true, flows: [blocked] }} />,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: 'Retry failed nodes (keep completed stages)' }),
  );
  await waitFor(() => expect(f.control).toHaveBeenCalledWith('product', 'flow', 8, 'retry'));
  view.rerender(
    <SwarmWorkflowPanel
      {...props}
      snapshot={{ success: true, flows: [{ ...blocked, canRetry: false }] }}
    />,
  );
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: 'Retry failed nodes (keep completed stages)' }),
    ).toBeNull(),
  );
});

test('disables pause and stop during confirmed final delivery according to the service actions', async () => {
  const f = fixture();
  render(
    <SwarmWorkflowPanel
      sessionId="product"
      snapshot={{
        success: true,
        flows: [{ ...flow, actions: { pause: false, resume: false, stop: false, retry: false } }],
      }}
    />,
  );
  const pause = await screen.findByRole('button', { name: 'Pause new task dispatch' });
  const stop = screen.getByRole('button', { name: 'Stop this flow' });
  expect((pause as HTMLButtonElement).disabled).toBe(true);
  expect((stop as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(pause);
  fireEvent.click(stop);
  expect(f.control).not.toHaveBeenCalled();
});

test('allows stopping an unknown final delivery once the service marks it blocked', async () => {
  const f = fixture();
  render(
    <SwarmWorkflowPanel
      sessionId="product"
      snapshot={{
        success: true,
        flows: [
          {
            ...flow,
            status: 'blocked',
            actions: { pause: false, resume: false, stop: true, retry: false },
          },
        ],
      }}
    />,
  );
  const stop = await screen.findByRole('button', { name: 'Stop this flow' });
  expect((stop as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(stop);
  await waitFor(() => expect(f.control).toHaveBeenCalledWith('product', 'flow', 8, 'stop'));
});

test.each(['failed', 'uncertain'] as const)(
  'keeps resume disabled for paused flows with %s nodes',
  async status => {
    const f = fixture();
    const props = { sessionId: 'product', tasks: [], onOpenTask: () => {} };
    const paused: SwarmWorkflowView = {
      ...flow,
      status: 'paused',
      nodes: flow.nodes.map(node => (node.id === 'a' ? { ...node, status } : node)),
    };
    const view = render(
      <SwarmWorkflowPanel {...props} snapshot={{ success: true, flows: [paused] }} />,
    );
    const resume = await screen.findByRole('button', { name: 'Resume flow' });
    expect((resume as HTMLButtonElement).disabled).toBe(true);
    view.rerender(
      <SwarmWorkflowPanel
        {...props}
        snapshot={{
          success: true,
          flows: [
            { ...paused, actions: { pause: false, resume: false, stop: true, retry: false } },
          ],
        }}
      />,
    );
    expect((resume as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(resume);
    expect(f.control).not.toHaveBeenCalled();
  },
);
