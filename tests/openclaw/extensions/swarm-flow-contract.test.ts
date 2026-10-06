import { describe, expect, it } from 'vitest';

import {
  type Flow,
  flowActions,
  type FlowNode,
  viewFlow,
} from '../../../openclaw-extensions/swarm-flow/contract';

const node: FlowNode = {
  id: 'work',
  title: 'Inspect',
  task: 'Inspect the project',
  deps: [],
  kind: 'work',
  access: 'read',
  status: 'failed',
  sessionKey: 'agent:main:subagent:work',
  agentId: 'main',
  agentName: 'Main',
  attempt: 1,
};
const flow: Flow = {
  id: 'flow',
  requestId: 'request',
  parentKey: 'agent:main:justdo:parent',
  parentId: 'parent',
  agentId: 'main',
  agents: [{ id: 'main', name: 'Main' }],
  cwd: '/project',
  permissionMode: 'workspace',
  mode: 'auto',
  goal: 'Inspect the project',
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  status: 'running',
  nodes: [node],
};

describe('Swarm flow action availability', () => {
  it('keeps internal planner feedback out of the flow view', () => {
    const projected = viewFlow({ ...flow, nodes: [{ ...node, planningRepair: { passes: 1, error: 'Invalid plan detail' } }] });
    expect(projected.nodes[0]).not.toHaveProperty('planningRepair');
  });
  it('blocks controls while final delivery is in flight and projects the same actions to the Tab', () => {
    const delivering = {
      ...flow,
      deliveryIntent: true,
      nodes: [{ ...node, status: 'done' as const }],
    };
    expect(flowActions(delivering)).toEqual({
      pause: false,
      resume: false,
      stop: false,
      retry: false,
    });
    expect(viewFlow(delivering).actions).toEqual(flowActions(delivering));
  });

  it('allows stopping an uncertain final delivery without allowing its replay', () => {
    const uncertain = { ...flow, status: 'blocked' as const, deliveryIntent: true };
    expect(flowActions(uncertain)).toEqual({
      pause: false,
      resume: false,
      stop: true,
      retry: false,
    });
    expect(viewFlow(uncertain).canRetry).toBe(false);
  });

  it.each(['failed', 'uncertain'] as const)(
    'does not resume paused flows with %s nodes',
    status => {
      const paused = { ...flow, status: 'paused' as const, nodes: [{ ...node, status }] };
      expect(flowActions(paused).resume).toBe(false);
      expect(flowActions(paused).stop).toBe(true);
    },
  );

  it.each(['completed', 'cancelled', 'stopping'] as const)(
    'disables controls when the flow is %s',
    status => {
      expect(flowActions({ ...flow, status })).toEqual({
        pause: false,
        resume: false,
        stop: false,
        retry: false,
      });
    },
  );

  it('preserves retry budget and native-run convergence checks', () => {
    const blocked = { ...flow, status: 'blocked' as const };
    expect(flowActions(blocked).retry).toBe(true);
    expect(viewFlow(blocked).canRetry).toBe(true);
    expect(flowActions({ ...blocked, nodes: [{ ...node, attempt: 3 }] }).retry).toBe(false);
    expect(
      flowActions({ ...blocked, nodes: [node, { ...node, id: 'active', status: 'running' }] })
        .retry,
    ).toBe(false);
    expect(flowActions({ ...blocked, error: 'Parent authority changed' }).retry).toBe(false);
    expect(flowActions({ ...blocked, nodes: [{ ...node, status: 'done' }] }).retry).toBe(false);
  });
});
