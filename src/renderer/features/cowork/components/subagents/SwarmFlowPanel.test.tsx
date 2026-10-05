// @vitest-environment jsdom
import type { SwarmFlowView } from '@shared/cowork/swarmFlow';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

vi.mock('./SwarmFlowDetailPanel', () => ({
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

import SwarmFlowPanel, { layoutFlow, routeFlowEdge } from './SwarmFlowPanel';
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const flow: SwarmFlowView = {
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
    value: { cowork: { getSwarmFlows: read, controlSwarmFlow: control } },
  });
  return { read, control };
}
test('lays out actual dependencies before downstream tasks', () => {
  const { points } = layoutFlow(flow.nodes);
  expect(points.get('plan')!.y).toBeLessThan(points.get('a')!.y);
  expect(points.get('a')!.y).toBeLessThan(points.get('verify')!.y);
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
  const view = render(<SwarmFlowPanel {...props} snapshot={snapshot} />);
  await screen.findByRole('button', { name: 'Security review: Running' });
  expect(view.container.querySelectorAll('.swarm-spinner')).toHaveLength(3);
  view.rerender(<SwarmFlowPanel {...props} active={false} snapshot={snapshot} />);
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

test('selects newly discovered workflow while preserving history selection on ordinary refresh', async () => {
  fixture();
  const old = { ...flow, id: 'old', goal: 'Older flow', status: 'completed' as const };
  const props = { sessionId: 'product', tasks: [], onOpenTask: () => {} };
  const view = render(
    <SwarmFlowPanel {...props} snapshot={{ success: true, flows: [flow, old] }} />,
  );
  const history = await screen.findByRole('combobox', { name: 'Task flows' });
  fireEvent.change(history, { target: { value: 'old' } });
  view.rerender(
    <SwarmFlowPanel
      {...props}
      active={false}
      snapshot={{ success: true, flows: [{ ...flow, revision: 9 }, old] }}
    />,
  );
  expect((history as HTMLSelectElement).value).toBe('old');
  const latest = { ...flow, id: 'new', goal: 'New task' };
  view.rerender(
    <SwarmFlowPanel {...props} snapshot={{ success: true, flows: [latest, flow, old] }} />,
  );
  await waitFor(() => expect((history as HTMLSelectElement).value).toBe('new'));
  fireEvent.change(history, { target: { value: 'old' } });
  view.rerender(
    <SwarmFlowPanel
      {...props}
      snapshot={{ success: true, flows: [{ ...latest, revision: 10 }, flow, old] }}
    />,
  );
  expect((history as HTMLSelectElement).value).toBe('old');
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
    <SwarmFlowPanel
      sessionId="product"
      tasks={[]}
      onOpenTask={() => {}}
      snapshot={{ success: true, flows: [assigned] }}
    />,
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
  render(<SwarmFlowPanel sessionId="product" tasks={[]} onOpenTask={() => {}} />);
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
  render(<SwarmFlowPanel sessionId="product" tasks={[]} onOpenTask={() => {}} />);
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
  render(<SwarmFlowPanel sessionId="product" active={false} tasks={[]} onOpenTask={() => {}} />);
  await act(async () => {});
  expect(f.read).not.toHaveBeenCalled();
});

test('uses the workspace snapshot without duplicate polling and refreshes it after a control', async () => {
  const f = fixture();
  const refresh = vi.fn();
  render(
    <SwarmFlowPanel
      sessionId="product"
      tasks={[]}
      onOpenTask={() => {}}
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
  render(<SwarmFlowPanel sessionId="product" tasks={[]} onOpenTask={() => {}} />);
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
  const view = render(<SwarmFlowPanel {...props} snapshot={{ success: true, flows: [blocked] }} />);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Retry failed nodes (keep completed stages)' }),
  );
  await waitFor(() => expect(f.control).toHaveBeenCalledWith('product', 'flow', 8, 'retry'));
  view.rerender(
    <SwarmFlowPanel
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
