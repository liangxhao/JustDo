import { describe, expect, it, vi } from 'vitest';

import { readWebLaunchFinal, selectWebLaunchFinal } from './browserWebLaunchResult';
import type { WebLaunchNativeBinding } from './browserWebLaunchStore';

const row = (id: string, text: string, extra = {}) => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', __openclaw: { id, runId: 'run-1' }, ...extra });
const binding: WebLaunchNativeBinding = { sessionKey: 'key', nativeSessionId: 'sid', lifecycleRevision: 'revision', clientGeneration: 1, nativeRunId: 'run-1', clientTurnId: 'client-1' };

describe('webpage exact final projection', () => {
  it('excludes the whole native tool-bearing message, including split text without stopReason', () => {
    const before = row('tool-message', 'intermediate', { stopReason: undefined });
    const tool = row('tool-message', '', { stopReason: 'toolUse', content: [{ type: 'toolCall', name: 'read' }] });
    expect(selectWebLaunchFinal([before, tool, row('final-message', 'final')], 'run-1', 'intermediate')).toBeNull();
    expect(selectWebLaunchFinal([before, tool, row('final-message', 'final')], 'run-1', 'final')).toMatchObject({ messageId: 'final-message', text: 'final' });
  });

  it('does not choose duplicate text, foreign runs, error rows or truncated bodies', () => {
    expect(selectWebLaunchFinal([row('one', 'final'), row('two', 'final')], 'run-1', 'final')).toBeNull();
    expect(selectWebLaunchFinal([row('one', 'final', { __openclaw: { id: 'one', runId: 'another' } })], 'run-1', 'final')).toBeNull();
    expect(selectWebLaunchFinal([row('one', 'final', { stopReason: 'error' })], 'run-1', 'final')).toBeNull();
    expect(selectWebLaunchFinal([row('one', 'final', { __openclaw: { id: 'one', runId: 'run-1', truncated: true } })], 'run-1', 'final')).toBeNull();
  });

  it('never interprets silent or missing live proof as a successful empty result', async () => {
    const client = { request: vi.fn(async () => ({ session: { key: 'key', sessionId: 'sid', lifecycleRevision: 'revision' } })) };
    const runtime = { fetchSessionHistoryByKey: vi.fn() };
    expect(await readWebLaunchFinal({ runtime: runtime as never, client: client as never, binding, candidate: { disposition: 'silent', agentSeq: 1 }, assertCurrent() {} })).toEqual({ status: 'unavailable' });
    expect(runtime.fetchSessionHistoryByKey).not.toHaveBeenCalled();
  });

  it('rejects an exact-message re-read whose body has changed under the same native ID', async () => {
    const client = { request: vi.fn(async (method: string) => method === 'sessions.describe' ? { session: { key: 'key', sessionId: 'sid', lifecycleRevision: 'revision' } } : { ok: true, message: row('final', 'changed') }) };
    const runtime = { fetchSessionHistoryByKey: vi.fn(async () => ({ messages: [row('final', 'expected')] })) };
    expect(await readWebLaunchFinal({ runtime: runtime as never, client: client as never, binding, candidate: { disposition: 'visible', text: 'expected', agentSeq: 1 }, assertCurrent() {} })).toEqual({ status: 'unavailable' });
  });
});
