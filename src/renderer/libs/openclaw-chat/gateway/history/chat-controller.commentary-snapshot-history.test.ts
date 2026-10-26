import { afterEach, expect, test, vi } from 'vitest';

import { projectPersistedTimeline } from '../../model/timeline/project-history-timeline';
import { projectTurnItems } from '../../model/timeline/project-turn-items';
import type { GatewayMessage } from '../../types';
import { ChatController } from '../chat-controller';
import { extractSnapshotText } from '../chat-controller-support';

const controllers: ChatController[] = [];
const sessionKey = 'agent:main:commentary-snapshot-history';
const sessionId = 'physical-commentary-snapshot-history';
const runId = 'run-commentary-snapshot-history';
const scopeId = 'model-message-1';
const firstText = 'First paragraph.';
const secondText = 'Second paragraph.';
const wholeText = `${firstText}\n${secondText}`;

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.disconnect();
  vi.useRealTimers();
});

// Verified against the locked 10.7 projectChatDisplayMessagesWithState with
// includeCommentaryFallbacks:true and activity:false. Public history splits
// signed commentary into segment rows and omits it from the Tool sibling.
// Feeding raw [A, Thinking, B, Tool] transcript blocks into the controller would
// exercise a different contract from the authenticated public history path.
function publicHistory(withThinking: boolean) {
  const meta = { id: 'source-1', seq: 2, runId };
  const sibling = {
    role: 'assistant', timestamp: 1_000, stopReason: 'toolUse',
    content: [
      ...(withThinking ? [{ type: 'thinking', thinking: 'Review the files.' }] : []),
      { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'example.txt' } },
    ],
    openclawDelivery: { messageScopeId: scopeId },
    __openclaw: meta,
  };
  const messages = [
    ...[firstText, secondText].map((text, index) => ({
      role: 'assistant', timestamp: 1_000,
      content: [{ type: 'text', text }],
      openclawStreamFallback: {
        replacementText: text, source: 'segment', itemId: `commentary-${index}`,
      },
      __openclaw: meta,
    })),
    sibling,
  ];
  return { messages, sibling };
}

test.each([false, true])(
  'keeps a whole commentary snapshot single across public history hydration (Thinking: %s)',
  async withThinking => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const controller = new ChatController();
    controllers.push(controller);
    controller.state.sessionKey = sessionKey;
    controller.state.currentSessionId = sessionId;
    controller.state.transcript.sessionKey = sessionKey;
    controller.state.transcript.sessionId = sessionId;
    controller.state.initialHistoryReady = true;
    const internal = controller as unknown as {
      handleEvent(event: { event: string; payload: unknown }): void;
    };
    const emit = (seq: number, stream: string, data: Record<string, unknown>) =>
      internal.handleEvent({
        event: 'agent',
        payload: { sessionKey, sessionId, runId, seq, ts: 1_000 + seq, stream, data },
      });
    const preamble = (seq: number, owner: string, text: string, complete = false) =>
      emit(seq, 'item', {
        kind: 'preamble', itemId: owner, phase: complete ? 'end' : 'update', progressText: text,
        assistantTextScope: {
          id: scopeId, commentarySnapshot: 'message',
          ...(complete ? { commentaryItemIds: ['commentary-0', 'commentary-1'] } : {}),
        },
      });
    const visible = () => projectTurnItems(controller.state.transcript.activeTurn)
      .flatMap(item => item.kind === 'content' ? [item.item.text] : []);

    emit(1, 'lifecycle', { phase: 'start' });
    preamble(2, 'commentary-0', firstText);
    if (withThinking) emit(3, 'thinking', { text: 'Review the files.' });
    preamble(4, 'commentary-1', wholeText);
    const turn = controller.state.transcript.activeTurn!;
    const owners = turn.items.filter(item => item.type === 'content');
    expect(visible()).toEqual([wholeText]);

    emit(5, 'assistant', {
      itemId: 'preview-1', text: '', replace: true,
      assistantTextScope: { id: scopeId, commentaryItemIds: ['commentary-0', 'commentary-1'] },
    });
    preamble(6, 'commentary-1', wholeText, true);
    emit(7, 'tool', { phase: 'start', toolCallId: 'read-1', name: 'read', args: { path: 'example.txt' } });
    const liveTool = turn.toolById.get('read-1');
    const { messages, sibling } = publicHistory(withThinking);

    internal.handleEvent({
      event: 'session.message',
      payload: { sessionKey, sessionId, activeRunIds: [runId], hasActiveRun: true, message: sibling },
    });
    expect(visible()).toEqual([wholeText]);
    const request = vi.fn().mockResolvedValue({
      sessionId,
      sessionInfo: { sessionId, hasActiveRun: true, activeRunIds: [runId] },
      messages: [
        { role: 'user', timestamp: 900, content: 'Inspect the example.', __openclaw: { id: 'user-1', seq: 1, runId } },
        ...messages,
      ],
    });
    controller.state.client = { request, stop: vi.fn() } as never;
    controller.state.connected = true;
    // Active-run history repairs the Tool boundary while the live transcript
    // retains display ownership, so the full history replacement is deferred.
    expect(await controller.loadHistory()).toBe(false);
    expect(await controller.loadHistory()).toBe(false);
    expect(request).toHaveBeenCalledWith('chat.history', expect.anything(), expect.anything());

    expect(controller.state.transcript.activeTurn).toBe(turn);
    expect(turn.toolById.get('read-1')).toBe(liveTool);
    expect(turn.items.filter(item => item.type === 'content' && item.preambleItemId !== undefined)).toEqual(owners);
    expect(owners.map(item => item.text)).toEqual([firstText, wholeText]);
    expect(visible()).toEqual([wholeText]);
    // An independently paced old owner may fill a lower per-run sequence gap.
    // It must not become visible over the newer whole-message snapshot.
    preamble(3, 'commentary-0', firstText);
    preamble(6, 'commentary-1', wholeText, true);
    expect(visible()).toEqual([wholeText]);
    expect(turn.items.filter(item => item.type === 'content' && item.preambleItemId !== undefined)).toEqual(owners);

    const answer = { role: 'assistant', timestamp: 1_200, content: [{ type: 'text', text: 'Done.' }],
      __openclaw: { id: 'answer-1', seq: 3, runId } };
    request.mockResolvedValue({
      sessionId,
      sessionInfo: { sessionId, hasActiveRun: false, activeRunIds: [] },
      messages: [
        { role: 'user', timestamp: 900, content: 'Inspect the example.', __openclaw: { id: 'user-1', seq: 1, runId } },
        ...messages,
        answer,
      ],
    });
    emit(8, 'tool', { phase: 'result', toolCallId: 'read-1', name: 'read', result: 'Read successfully.' });
    emit(9, 'assistant', { itemId: 'answer-1', text: 'Done.', replace: true,
      assistantTextScope: { id: 'model-message-2', commentaryItemIds: [] } });
    emit(10, 'lifecycle', { phase: 'end', executionSettled: true });
    internal.handleEvent({ event: 'chat', payload: {
      sessionKey, sessionId, runId, seq: 10, state: 'final', message: answer,
    } });
    await vi.waitFor(() => expect(controller.state.chatLoading).toBe(false));
    expect(await controller.loadHistory()).toBe(true);
    expect(controller.state.transcript.activeTurn).toBeNull();
    const persistedBodies = projectPersistedTimeline(controller.state.chatMessages as GatewayMessage[])
      .flatMap(item => item.kind === 'history-message' ? [extractSnapshotText(item.message)] : []);
    expect(persistedBodies).toEqual(['Inspect the example.', firstText, secondText, 'Done.']);
  },
);
