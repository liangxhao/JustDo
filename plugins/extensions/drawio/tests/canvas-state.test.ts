import { afterEach, describe, expect, it, vi } from 'vitest';

import { DiagramCanvasState, type CanvasOwner } from '../canvas-state';
import type { DiagramSource } from '../contracts';

const identity = { sessionKey: 'agent:main:canvas', sessionId: 'physical', agentId: 'main' };
const owner = (viewId = 'mcp-app-canvas', connectionId = 'connection'): CanvasOwner => ({
  ...identity,
  viewId,
  connectionId,
  assertCurrent: vi.fn(),
});
const source = (diagramId = 'diagram-one'): DiagramSource => ({
  ...identity,
  diagramId,
  kind: 'desktop-native-admission',
  serverName: 'drawio',
  toolName: 'open_editor',
  uiResourceUri: 'ui://drawio/editor',
  originViewId: 'mcp-app-canvas',
});
const snapshot = (diagramId = 'diagram-one', contentStamp = 'base') => ({
  diagramId,
  contentStamp,
  xml: '<mxGraphModel/>',
  title: 'Same name',
});
const states: DiagramCanvasState[] = [];
const fixture = () => {
  const state = new DiagramCanvasState();
  states.push(state);
  const host = owner();
  const token = state.prepare(host, source(), snapshot());
  state.freeze(host, 'run', [{ token, viewId: host.viewId, selected: true }]);
  return { state, host, token };
};
const input = {
  diagramId: 'diagram-one',
  baseContentStamp: 'base',
  xml: '<mxGraphModel><root/></mxGraphModel>',
  title: 'Updated',
};
afterEach(() => {
  states.splice(0).forEach(state => state.close());
  vi.useRealTimers();
});

describe('current diagram routing', () => {
  it.each([false, true])(
    'retires pending/dispatched (%s) authority before preparing after navigation, even if detach was lost',
    async dispatched => {
      const { state, host, token } = fixture();
      const update = state.update('run', 'late', identity, input, () => {});
      const rejected = expect(update).rejects.toThrow('closed');
      if (dispatched) state.take(host, token);
      const next = state.prepare(host, source(), snapshot(), token, true);
      await rejected;
      expect(next).not.toBe(token);
      expect(() => state.take(host, token)).toThrow('unavailable');
      expect(state.take(host, next)).toBeNull();
      await expect(state.update('run', 'next', identity, input, () => {})).rejects.toThrow();
      state.detach(host, next);
      expect(state.prepare(host, source(), snapshot(), next, true)).not.toBe(next);
    },
  );

  it('returns success only after the exact editor acknowledges, and never dispatches twice', async () => {
    const { state, host, token } = fixture();
    const applied = state.update('run', 'call', identity, input, () => {});
    const candidate = state.take(host, token)!;
    expect(candidate.xml).toBe(input.xml);
    expect(state.take(host, token)).toBeNull();
    expect(() =>
      state.acknowledge(host, 'other', candidate.operationId, { status: 'failed' }),
    ).toThrow();
    const current = { ...snapshot(), contentStamp: 'applied', xml: input.xml };
    state.acknowledge(host, token, candidate.operationId, { status: 'applied', snapshot: current });
    expect(await applied).toMatchObject({
      status: 'applied',
      operationId: candidate.operationId,
      runId: 'run',
      toolCallId: 'call',
      source: source(),
      xml: input.xml,
      contentStamp: 'applied',
    });
    expect(() =>
      state.acknowledge(host, token, candidate.operationId, {
        status: 'applied',
        snapshot: current,
      }),
    ).not.toThrow();
    expect(state.read('run', identity).snapshot.contentStamp).toBe('applied');
    await expect(
      state.update('run', 'call', identity, { ...input, baseContentStamp: 'applied' }, () => {}),
    ).rejects.toThrow('already issued');
  });

  it('keeps preparation immutable across later sends and supports explicit references over selection', () => {
    const { state, host, token } = fixture();
    state.prepare(host, source(), snapshot('diagram-one', 'later'), token);
    expect(state.read('run', identity).snapshot.contentStamp).toBe('base');
    const otherHost = owner('mcp-app-other');
    const other = state.prepare(
      otherHost,
      { ...source('diagram-two'), originViewId: otherHost.viewId },
      snapshot('diagram-two'),
    );
    state.freeze(host, 'later-run', [
      { token, viewId: host.viewId, selected: false },
      { token: other, viewId: otherHost.viewId, selected: true },
    ]);
    expect(state.read('later-run', identity).snapshot.diagramId).toBe('diagram-two');
    expect(state.read('later-run', identity, 'diagram-one').snapshot.contentStamp).toBe('later');
    expect(() => state.read('run', { ...identity, sessionId: 'reset' })).toThrow();
  });

  it('refuses ambiguous same-title targets and another live editor for one identity', () => {
    const { state, host, token } = fixture();
    expect(() => state.prepare(owner('mcp-app-second'), source(), snapshot())).toThrow(
      'another editor',
    );
    const otherHost = owner('mcp-app-other');
    const other = state.prepare(otherHost, source('diagram-two'), snapshot('diagram-two'));
    state.freeze(host, 'ambiguous', [
      { token, viewId: host.viewId, selected: false },
      { token: other, viewId: otherHost.viewId, selected: false },
    ]);
    expect(() => state.read('ambiguous', identity)).toThrow('Choose a diagram');
  });

  it('preserves manual changes by rejecting a conflict and stale base stamp', async () => {
    const { state, host, token } = fixture();
    await expect(
      state.update('run', 'stale', identity, { ...input, baseContentStamp: 'stale' }, () => {}),
    ).rejects.toThrow('content changed');
    const update = state.update('run', 'conflict', identity, input, () => {});
    const rejected = expect(update).rejects.toThrow('manual edits were preserved');
    const operation = state.take(host, token)!;
    state.acknowledge(host, token, operation.operationId, { status: 'conflict' });
    await rejected;
    expect(state.read('run', identity).snapshot).toEqual(snapshot());
  });

  it('keeps a dispatched timeout unknown and rejects late acknowledgements or a new write in that run', async () => {
    vi.useFakeTimers();
    const { state, host, token } = fixture();
    const update = state.update('run', 'unknown', identity, input, () => {});
    const rejected = expect(update).rejects.toThrow('unknown');
    const operation = state.take(host, token)!;
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect(state.take(host, token)).toBeNull();
    expect(() =>
      state.acknowledge(host, token, operation.operationId, {
        status: 'applied',
        snapshot: snapshot(),
      }),
    ).toThrow('unknown');
    await expect(state.update('run', 'another', identity, input, () => {})).rejects.toThrow(
      'No prepared diagram',
    );
  });

  it('rechecks current invocation before dispatch and native connection before acknowledgement', async () => {
    const { state, host, token } = fixture();
    const guard = vi.fn();
    const update = state.update('run', 'stopped', identity, input, guard);
    const rejection = expect(update).rejects.toThrow();
    guard.mockImplementation(() => {
      throw new Error('stopped');
    });
    expect(() => state.take(host, token)).toThrow('stopped');
    state.detach(host, token);
    await rejection;
    expect(() => state.read('run', identity)).toThrow();
    // Even if a frozen read remains available, it cannot write a detached target.
    expect(() => state.take(host, token)).toThrow();
  });
});
