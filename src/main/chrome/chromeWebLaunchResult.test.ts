import { describe, expect, it, vi } from 'vitest';

import { readWebLaunchFinal, selectWebLaunchFinal } from './chromeWebLaunchResult';
import type { WebLaunchNativeBinding } from './chromeWebLaunchStore';
import { webLaunchDigest } from './chromeWebLaunchValidation';

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

  it('adds only the exact final message artifacts and detects a changed source on reread', async () => {
    const content = 'Completed\n';
    const final = row('final', content, { openclawDelivery: { mediaUrls: ['./report.pdf'] } });
    let reread = {
      ...final,
      content: [
        ...final.content,
        { type: 'attachment', attachment: {
          artifactId: 'native-artifact', url: '/api/chat/media/outgoing/key/e17ee19d-f929-4c85-9991-53c953fe61bd/full',
          kind: 'document', label: 'report.pdf', mimeType: 'application/pdf',
        } },
      ],
    };
    const client = { request: vi.fn(async (method: string) => method === 'sessions.describe'
      ? { session: { key: 'key', sessionId: 'sid', lifecycleRevision: 'revision' } }
      : { ok: true, message: reread }) };
    const runtime = { fetchSessionHistoryByKey: vi.fn(async () => ({ messages: [
      row('tool', 'Completed', {
        stopReason: 'toolUse', openclawDelivery: { mediaUrls: ['/private/tool-file.txt'] },
      }),
      final,
      row('later', 'Completed', {
        __openclaw: { id: 'later', runId: 'another' }, openclawDelivery: { mediaUrls: ['/private/late.txt'] },
      }),
    ] })) };
    const options = { runtime: runtime as never, client: client as never, binding, assertCurrent() {} };

    const expected = {
      status: 'available',
      output: { text: content, artifacts: [{ name: 'report.pdf', kind: 'document', mimeType: 'application/pdf' }] },
      reference: { messageId: 'final', digest: webLaunchDigest(content), mediaDigest: expect.any(String) },
    };
    expect(await readWebLaunchFinal({
      ...options, candidate: { disposition: 'visible', text: 'Completed\nMEDIA: ./report.pdf', agentSeq: 1 },
    })).toEqual(expected);
    const split = { ...row('final', ''), content: reread.content.slice(1) };
    expect(selectWebLaunchFinal([final, split], 'run-1', 'Completed\nMEDIA: ./report.pdf'))
      .toEqual(selectWebLaunchFinal([final], 'run-1', 'Completed\nMEDIA: ./report.pdf'));
    expect(selectWebLaunchFinal([final], 'run-1', 'Completed\n```\nMEDIA: ./report.pdf\n```')).toBeNull();
    const legacy = { messageId: 'final', digest: webLaunchDigest(content) };
    const restored = await readWebLaunchFinal({ ...options, reference: legacy });
    expect(restored).toEqual(expected);
    reread = row('final', content, { openclawDelivery: { mediaUrls: ['/another/report.pdf'] } });
    expect(await readWebLaunchFinal({ ...options, reference: restored.reference })).toEqual({ status: 'unavailable' });
  });

  it('returns media-only success only for a uniquely matched native final media message', async () => {
    const final = row('final', '', {
      content: [],
      openclawDelivery: { mediaUrls: ['./chart.png'] },
    });
    const client = { request: vi.fn(async (method: string) => method === 'sessions.describe'
      ? { session: { key: 'key', sessionId: 'sid', lifecycleRevision: 'revision' } }
      : { ok: true, message: final }) };
    const runtime = { fetchSessionHistoryByKey: vi.fn(async () => ({ messages: [final] })) };
    const options = { runtime: runtime as never, client: client as never, binding, assertCurrent() {} };
    const expected = {
      status: 'available',
      output: { artifacts: [{ name: 'chart.png', kind: 'image', mimeType: 'image/png' }] },
      reference: { messageId: 'final', digest: webLaunchDigest(''), mediaDigest: expect.any(String) },
    };
    expect(await readWebLaunchFinal({
      ...options, candidate: { disposition: 'visible', text: 'MEDIA: ./chart.png', agentSeq: 1 },
    })).toEqual(expected);
    expect(await readWebLaunchFinal({
      ...options, candidate: { disposition: 'empty', agentSeq: 1 },
    })).toEqual(expected);
    expect(await readWebLaunchFinal({
      ...options, candidate: { disposition: 'empty', emptyWithReason: true, agentSeq: 1 },
    })).toEqual({ status: 'unavailable' });
    expect(selectWebLaunchFinal([final, row('another-media', '', {
      content: [], openclawDelivery: { mediaUrls: ['/private/chart-two.png'] },
    })], 'run-1', '')).toBeNull();
  });
});
