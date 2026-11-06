import { describe, expect, it, vi } from 'vitest';

import type { NormalizedAgentEvent } from '../../../shared/openclaw/agentEvent';
import { AppServerNotificationMethod } from '../../appServer/appServerProtocol';
import { BrowserAppServerLiveProjection } from './browserAppServerLiveProjection';

const event = (agentSeq: number, stream: string, data: Record<string, unknown>, sessionId = 'physical-session') => ({
  kind: 'agent' as const, turnId: 'logical-turn', event: {
    agentSeq, stream, data, sessionId, runId: 'native-run', lifecycleGeneration: 'incarnation',
    sessionKey: 'native-key', agentId: 'main', spawnedBy: null, timestamp: 1000, frameSeq: agentSeq,
    deliveryEvent: 'agent',
  } as NormalizedAgentEvent,
});

describe('shared browser standard item projection', () => {
  it('admits the bounded image input twice without overflowing its pre-response item queue', () => {
    const notify = vi.fn();
    const fail = vi.fn();
    const projection = new BrowserAppServerLiveProjection('thread', notify, fail);
    const content = [{ type: 'image', url: `data:image/png;base64,${Buffer.alloc(4 * 1024 * 1024).toString('base64')}` }];
    projection.prepareTurn('logical-turn', content, 1000);
    projection.accept(event(1, 'lifecycle', { phase: 'start' }));
    expect(notify).not.toHaveBeenCalled();
    projection.admitTurn('logical-turn');
    const userItems = notify.mock.calls.filter(([, params]) => params.item?.type === 'userMessage');
    expect(userItems).toHaveLength(2);
    expect(userItems[0][1].item.content).toEqual(content);
    expect(fail).not.toHaveBeenCalled();
  });

  it('buffers actual native items until the response and keeps the exact public turn identity', () => {
    const notify = vi.fn();
    const fail = vi.fn();
    const projection = new BrowserAppServerLiveProjection('thread', notify, fail);
    projection.prepareTurn('logical-turn', 'User request', 1000);
    projection.accept(event(1, 'lifecycle', { phase: 'start' }));
    projection.accept(event(2, 'assistant', { text: 'Answer' }));
    expect(notify).not.toHaveBeenCalled();

    projection.admitTurn('logical-turn');
    projection.finishTurn('logical-turn', 'Answer');

    expect(notify).toHaveBeenCalledWith(AppServerNotificationMethod.AgentMessageDelta,
      expect.objectContaining({ threadId: 'thread', turnId: 'logical-turn', delta: 'Answer' }));
    expect(notify.mock.calls.filter(([method]) => method === AppServerNotificationMethod.AgentMessageDelta)).toHaveLength(1);
    expect(notify.mock.calls.filter(([method, params]) => method === AppServerNotificationMethod.ItemCompleted && params.item.type === 'userMessage')).toHaveLength(1);
    expect(JSON.stringify(notify.mock.calls)).not.toMatch(/physical-session|native-key|native-run/);
    expect(fail).not.toHaveBeenCalled();
  });

  it('does not fabricate user text for an attached observer or treat display-final as execution settlement', () => {
    const notify = vi.fn();
    const projection = new BrowserAppServerLiveProjection('thread', notify, vi.fn());
    projection.accept(event(1, 'lifecycle', { phase: 'start' }));
    projection.accept(event(2, 'assistant', { text: 'Observed text' }));
    expect(notify.mock.calls.some(([, params]) => params.item?.type === 'userMessage')).toBe(false);
    expect(notify.mock.calls.some(([method]) => method === AppServerNotificationMethod.TurnCompleted)).toBe(false);
  });

  it('rejects unstamped, duplicate and conflicting incarnation progress without replacing accepted text', () => {
    const notify = vi.fn();
    const projection = new BrowserAppServerLiveProjection('thread', notify, vi.fn());
    projection.accept({ ...event(1, 'assistant', { text: 'unattributed' }), turnId: undefined });
    projection.accept(event(2, 'assistant', { text: 'accepted' }));
    projection.accept(event(2, 'assistant', { text: 'duplicate' }));
    projection.accept(event(3, 'assistant', { text: 'different session' }, 'replacement-session'));
    projection.accept({ ...event(4, 'assistant', { text: 'different run' }),
      event: { ...event(4, 'assistant', { text: 'different run' }).event, runId: 'replacement-run' } });
    projection.accept({ ...event(5, 'assistant', { text: 'different key' }),
      event: { ...event(5, 'assistant', { text: 'different key' }).event, sessionKey: 'replacement-key' } });
    projection.accept({ ...event(4, 'assistant', { text: 'different generation' }),
      event: { ...event(4, 'assistant', {}).event, data: { text: 'different generation' }, lifecycleGeneration: 'replacement' } });
    expect(notify.mock.calls.filter(([method]) => method === AppServerNotificationMethod.AgentMessageDelta))
      .toEqual([[AppServerNotificationMethod.AgentMessageDelta, expect.objectContaining({ delta: 'accepted' })]]);
  });

  it('retires a settled projection and never reopens it from a late native update', () => {
    const notify = vi.fn();
    const projection = new BrowserAppServerLiveProjection('thread', notify, vi.fn());
    projection.accept(event(1, 'assistant', { text: 'Accepted' }));
    projection.finishTurn('logical-turn', 'Accepted');
    const count = notify.mock.calls.length;
    projection.accept(event(2, 'assistant', { text: 'Late' }));
    projection.prepareTurn('logical-turn', 'Replay', 2000);
    projection.admitTurn('logical-turn');
    expect(notify).toHaveBeenCalledTimes(count);
  });

  it('retains trusted sparse native tool results without rewinding newer assistant text', () => {
    const notify = vi.fn();
    const projection = new BrowserAppServerLiveProjection('thread', notify, vi.fn());
    projection.accept(event(10, 'assistant', { text: 'Newer text' }));
    const tool = event(8, 'tool', { phase: 'result', toolCallId: 'tool-id', name: 'read',
      result: { content: [{ type: 'text', text: 'Actual native result' }] } });
    projection.accept({ ...tool, event: { ...tool.event, deliveryEvent: 'session.tool' } });
    projection.accept({ ...tool, event: { ...tool.event, deliveryEvent: 'session.tool' } });
    projection.accept(event(9, 'assistant', { text: 'Older text must not replace the newer item' }));
    expect(notify.mock.calls.filter(([method, params]) => method === AppServerNotificationMethod.ItemCompleted &&
      params.item.type === 'mcpToolCall')).toHaveLength(1);
    expect(notify.mock.calls.some(([method, params]) => method === AppServerNotificationMethod.ItemCompleted &&
      params.item.type === 'agentMessage')).toBe(false);
    expect(notify.mock.calls.filter(([method]) => method === AppServerNotificationMethod.AgentMessageDelta))
      .toEqual([[AppServerNotificationMethod.AgentMessageDelta, expect.objectContaining({ delta: 'Newer text' })]]);
  });

  it('withdraws unconfirmed admission items and contains output failure without inventing a terminal', () => {
    const notify = vi.fn(() => { throw new Error('viewer disconnected'); });
    const fail = vi.fn();
    const projection = new BrowserAppServerLiveProjection('thread', notify, fail);
    projection.prepareTurn('logical-turn', 'Input', 1000);
    projection.accept(event(1, 'assistant', { text: 'Not yet published' }));
    projection.discardTurn('logical-turn');
    projection.admitTurn('logical-turn');
    expect(notify).not.toHaveBeenCalled();
    projection.accept(event(2, 'assistant', { text: 'Native observation' }));
    expect(fail).toHaveBeenCalledOnce();
    projection.finishTurn('logical-turn');
    expect(notify.mock.calls.some(([method]) => method === AppServerNotificationMethod.TurnCompleted)).toBe(false);
  });
});
