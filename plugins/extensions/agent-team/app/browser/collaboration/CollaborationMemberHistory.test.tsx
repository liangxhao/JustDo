// @vitest-environment jsdom
import type { AppNativeHistoryState } from '@app-plugin/sdk/browser';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setHistoryRenderer } from '../../../tests/browserRuntime';
import CollaborationMemberHistory from './CollaborationMemberHistory';

const member = { agentId: 'review', sessionId: 'peer', sessionKey: 'agent:review:justdo:peer' };
let history: Record<string, unknown>;
const readMessages = vi.fn();
const stopMember = vi.fn();
beforeEach(() => {
  readMessages.mockReset().mockResolvedValue({ success: true, value: [] });
  stopMember.mockReset().mockResolvedValue({ success: true, value: undefined });
  Object.defineProperty(window, 'electron', { configurable: true, value: { collaboration: { readMessages, stopMember } } });
  setHistoryRenderer(input => {
    history = input;
    return <div data-testid="native-history">{input.receiptError ? <span role="alert">Unavailable</span> : null}{input.onRetry ? <button onClick={input.onRetry as () => void}>Retry receipt</button> : null}</div>;
  });
});
afterEach(cleanup);
const mount = (extra: Record<string, unknown> = {}) => render(<CollaborationMemberHistory member={member} name="Reviewer" anchorSessionId="source" workingDirectory="/project" {...extra} />);
const state = (overrides: Partial<AppNativeHistoryState> = {}): AppNativeHistoryState => ({ connected: true, ready: true, sessionKey: member.sessionKey, nativeSessionId: 'native-peer', running: false, ...overrides });
const notify = (value: AppNativeHistoryState) => act(() => (history.onState as (value: AppNativeHistoryState) => void)(value));

describe('Team native history public port', () => {
  it('passes exact native identity, presentation and subtask ownership to the host', () => {
    const open = vi.fn();
    mount({ onOpenSubtask: open, peerNames: { peer: 'Reviewer' } });
    expect(history).toEqual(expect.objectContaining({ sessionKey: member.sessionKey, productSessionId: 'peer', agentId: 'review', workingDirectory: '/project', showSubtaskAction: false, peerNames: { peer: 'Reviewer' } }));
    const task = { id: 'task' };
    (history.onOpenSubtask as (task: unknown) => void)(task);
    expect(open).toHaveBeenCalledWith(task, 'peer');
  });

  it('exposes a current ready connection and revokes it on disconnect and unmount', () => {
    const changed = vi.fn();
    const view = mount({ onSessionChange: changed });
    expect(changed).toHaveBeenLastCalledWith(null);
    notify(state({ ready: false }));
    expect(changed).toHaveBeenLastCalledWith(null);
    const ready = state();
    notify(ready);
    expect(changed).toHaveBeenLastCalledWith(ready);
    notify(state({ connected: false }));
    expect(changed).toHaveBeenLastCalledWith(null);
    view.unmount();
    expect(changed).toHaveBeenLastCalledWith(null);
  });

  it('reads an exact historical receipt independently of the active native history', async () => {
    const message = { role: 'user', content: 'Exact receipt' };
    readMessages.mockResolvedValue({ success: true, value: [{ deliveryId: 'other', message: {} }, { deliveryId: 'delivery', message }] });
    mount({ receipt: { deliveryId: 'delivery', id: 'old-run' }, onSessionChange: vi.fn() });
    await act(async () => {});
    expect(readMessages).toHaveBeenCalledExactlyOnceWith('source', ['delivery']);
    expect(history).toEqual(expect.objectContaining({ sessionKey: member.sessionKey, observeSession: true, messages: [message], receiptLoading: false }));
    expect(screen.queryByText('Subtasks for peer')).toBeNull();
  });

  it.each(['failed', 'missing'])('retries a %s receipt with the same exact delivery locator', async failure => {
    readMessages.mockResolvedValueOnce(failure === 'failed' ? { success: false, error: 'offline' } : { success: true, value: [] });
    const message = { role: 'assistant', content: 'Recovered' };
    readMessages.mockResolvedValue({ success: true, value: [{ deliveryId: 'delivery', message }] });
    mount({ receipt: { deliveryId: 'delivery', id: 'old-run' } });
    await act(async () => {});
    expect(history.messages).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry receipt' }));
    await act(async () => {});
    expect(readMessages).toHaveBeenCalledTimes(2);
    expect(readMessages).toHaveBeenLastCalledWith('source', ['delivery']);
    expect(history.messages).toEqual([message]);
  });

  it('ignores a late receipt response after the selected member changes', async () => {
    let finish!: (value: unknown) => void;
    readMessages.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const view = mount({ receipt: { deliveryId: 'delivery', id: 'old-run' } });
    view.rerender(<CollaborationMemberHistory member={{ ...member, sessionKey: 'agent:other:peer' }} name="Other" workingDirectory="/project" receipt={{ deliveryId: 'new', id: 'new-run' }} />);
    await act(async () => finish({ success: true, value: [{ deliveryId: 'delivery', message: { content: 'Stale' } }] }));
    expect(history.messages).toEqual([]);
  });

  it('stops only the precise current native incarnation and run', async () => {
    mount({ roomId: 'room' });
    notify(state({ running: true, canStop: true, runId: 'run' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop this assistant' }));
    await act(async () => {});
    expect(stopMember).toHaveBeenCalledExactlyOnceWith({ sourceSessionId: 'source', roomId: 'room', targetSessionKey: member.sessionKey, runId: 'run', nativeSessionId: 'native-peer' });
  });

  it.each([
    { sessionKey: 'agent:other:peer' },
    { nativeSessionId: undefined },
    { runId: undefined },
    { canStop: false },
  ])('withholds stop admission for an incomplete or mismatched native state %j', bad => {
    mount({ roomId: 'room' });
    notify(state({ running: true, canStop: true, runId: 'run', ...bad }));
    const button = screen.queryByRole('button', { name: 'Stop this assistant' });
    if (button) expect(button.hasAttribute('disabled')).toBe(true);
    expect(stopMember).not.toHaveBeenCalled();
  });

  it('rechecks the live native state at click time instead of reusing rendered admission', async () => {
    mount({ roomId: 'room' });
    notify(state({ running: true, canStop: true, runId: 'old', readCurrent: () => state({ sessionKey: 'agent:other:peer', running: true, canStop: true, runId: 'new' }) }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop this assistant' }));
    await act(async () => {});
    expect(stopMember).not.toHaveBeenCalled();
  });
});
