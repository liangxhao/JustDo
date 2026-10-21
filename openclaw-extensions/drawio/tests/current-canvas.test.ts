import { afterEach, describe, expect, it, vi } from 'vitest';

import { connectCurrentDiagram } from '../browser/current-canvas';
import { DRAWIO_APPLY_TOOL, DRAWIO_CANVAS_EVENT, DRAWIO_SNAPSHOT_TOOL } from '../contracts';

const snapshot = {
  diagramId: 'diagram-one',
  xml: '<mxGraphModel/>',
  title: 'Canvas',
  contentStamp: 'base',
};
const operation = {
  operationId: 'old-operation',
  diagramId: snapshot.diagramId,
  baseContentStamp: 'base',
  xml: '<mxGraphModel/>',
  title: 'Updated',
};
const cleanups: Array<() => void> = [];
function fixture() {
  vi.useFakeTimers();
  let prepare!: () => Promise<unknown>;
  let suspend!: () => void;
  let notify!: (event: { event: string }) => void;
  const request = vi.fn(async (input: Record<string, unknown>): Promise<unknown> =>
    input.action === 'prepare' ? { token: 'first' } : { operation: null },
  );
  const release = vi.fn(async () => {
    throw new Error('lost detach');
  });
  const callTool = vi.fn(async () => ({ structuredContent: snapshot }));
  const host = {
    source: {
      serverName: 'drawio',
      toolName: 'open_editor',
      uiResourceUri: 'ui://drawio/editor',
      originSessionKey: 'agent:main:one',
    },
    viewId: () => 'mcp-app-original',
    diagramId: snapshot.diagramId,
    bridge: { callTool } as never,
    current: () => true,
    priority: () => 2,
    request: request as never,
    release,
    register: (callback: typeof prepare) => {
      prepare = callback;
      return () => {};
    },
    onSuspend: (callback: () => void) => {
      suspend = callback;
      return () => {};
    },
    subscribe: (callback: typeof notify) => {
      notify = callback;
      return () => {};
    },
  };
  cleanups.push(connectCurrentDiagram(host));
  return {
    prepare: () => prepare(),
    suspend: () => suspend(),
    notify: () => notify({ event: DRAWIO_CANVAS_EVENT }),
    request,
    release,
    callTool,
  };
}
afterEach(() => {
  cleanups.splice(0).forEach(dispose => dispose());
  vi.useRealTimers();
});

describe('diagram navigation lifecycle', () => {
  it('drops a late take across A→B→A, stops old polling, and retires the token on the next explicit send', async () => {
    const { prepare, suspend, notify, request, release, callTool } = fixture();
    await prepare();
    let finish!: (value: unknown) => void;
    request.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    notify();
    suspend();
    expect(release).toHaveBeenCalledWith('');
    finish({ operation });
    await vi.advanceTimersByTimeAsync(3000);
    expect(callTool).toHaveBeenCalledExactlyOnceWith({ name: DRAWIO_SNAPSHOT_TOOL, arguments: {} });
    expect(request).toHaveBeenCalledTimes(2);
    request.mockResolvedValueOnce({ token: 'second' });
    await prepare();
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'prepare', token: 'first', retire: true }),
    );
    request.mockResolvedValueOnce({ operation: { ...operation, operationId: 'new-operation' } });
    callTool.mockResolvedValueOnce({
      structuredContent: { operationId: 'new-operation', status: 'applied', snapshot },
    } as never);
    notify();
    await vi.advanceTimersByTimeAsync(0);
    expect(callTool).toHaveBeenLastCalledWith({
      name: DRAWIO_APPLY_TOOL,
      arguments: expect.objectContaining({ operationId: 'new-operation' }),
    });
    expect(request).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'ack', token: 'second' }),
    );
  });

  it('rejects delayed snapshot or prepare responses across a suspension even after the view is current again', async () => {
    const { prepare, suspend, request, release, callTool } = fixture();
    let finish!: (value: unknown) => void;
    callTool.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }) as never,
    );
    const snapshotPending = prepare();
    const snapshotRejected = expect(snapshotPending).rejects.toThrow('prepare');
    suspend();
    finish({ structuredContent: snapshot });
    await snapshotRejected;
    expect(request).not.toHaveBeenCalled();
    request.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        }),
    );
    const preparePending = prepare();
    const prepareRejected = expect(preparePending).rejects.toThrow('changed');
    await vi.advanceTimersByTimeAsync(0);
    suspend();
    finish({ token: 'late' });
    await prepareRejected;
    expect(release).toHaveBeenCalledWith('late');
  });
});
