import type { ChromeExtensionStreamEvent } from '@shared/chrome/chromeExtensionStream';
import { describe, expect, it } from 'vitest';

import { ChromeExtensionStream } from './chrome-extension-stream';

const user = { type: 'userMessage', content: [{ type: 'text', text: 'Question' }] };
const nativeUser = { ...user, inputRunId: 'input-1' };
const acceptedHistory = (items: Array<Record<string, unknown> & { type: string }> = []) => ({
  id: 'one',
  turns: [{ id: 'history-1', items: [nativeUser, ...items] }],
});
const history = (items: Array<Record<string, unknown> & { type: string }> = []) => ({
  id: 'one',
  turns: [{ id: 'history-1', items: [user, ...items] }],
});
const agent = (
  seq: number,
  stream: string,
  data: Record<string, unknown>,
): ChromeExtensionStreamEvent => ({
  kind: 'agent',
  event: {
    runId: 'run-1',
    sessionKey: 'agent:main:justdo:one',
    sessionId: null,
    lifecycleGeneration: null,
    agentId: 'main',
    spawnedBy: null,
    agentSeq: seq,
    frameSeq: seq,
    deliveryEvent: 'agent',
    stream,
    timestamp: seq,
    data,
  },
});
const chat = (
  state: 'delta' | 'final' | 'error' | 'aborted',
  text: string,
  sourceSeq?: number,
): ChromeExtensionStreamEvent => ({
  kind: 'chat',
  event: {
    runId: 'run-1',
    sessionKey: 'agent:main:justdo:one',
    sessionId: null,
    lifecycleGeneration: null,
    frameSeq: 100,
    sourceSeq,
    state,
    message: { content: text },
    replace: false,
  },
});
const items = (view: ChromeExtensionStream) => view.project().turns.flatMap(turn => turn.items);

describe('extension live projection', () => {
  it('retains the structured question result for the browser presentation', () => {
    const questionResult = {
      version: 1,
      questions: [
        {
          id: 'stack',
          question: 'Which stack?',
          options: [
            { id: 'react', label: 'React' },
            { id: 'vue', label: 'Vue' },
          ],
        },
      ],
      response: { status: 'answered', answers: { stack: { selected: ['react'] } } },
    };
    const view = new ChromeExtensionStream('one');
    view.start('Question');
    view.bindRun('run-1');
    view.accept(
      agent(1, 'tool', {
        phase: 'start',
        toolCallId: 'question-1',
        name: 'ask_user_question',
        args: { questions: questionResult.questions },
      }),
    );
    view.accept(
      agent(2, 'tool', {
        phase: 'result',
        toolCallId: 'question-1',
        name: 'ask_user_question',
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                askUserQuestion: questionResult,
                summary: 'User selected: React',
              }),
            },
          ],
        },
      }),
    );

    expect(items(view).find(item => item.type === 'toolCall')).toMatchObject({
      status: 'completed',
      questionResult,
    });
  });

  it('buffers a pending send until the explicit native binding selects its events', () => {
    const view = new ChromeExtensionStream('one');
    view.start('Question');
    const oldRun = agent(100, 'assistant', { text: 'Late previous run' });
    oldRun.event.runId = 'previous-run';
    expect(view.accept(oldRun)).toBe(false);
    expect(view.accept(agent(1, 'assistant', { text: 'Current reply' }))).toBe(false);
    expect(items(view).filter(item => item.type === 'agentMessage')).toEqual([]);
    expect(view.bindRun('run-1')).toBe(true);
    expect(items(view).filter(item => item.type === 'agentMessage')).toMatchObject([
      { text: 'Current reply' },
    ]);
    view.accept(agent(2, 'assistant', { text: 'Current reply continues' }));
    expect(items(view).slice(-1)[0]?.text).toBe('Current reply continues');
  });

  it('rebinds a successor to the same displayed user turn and ignores delayed predecessor frames', () => {
    const view = new ChromeExtensionStream('one');
    view.start('Question', undefined, 'input-1');
    expect(view.bindRun('run-1')).toBe(true);
    view.accept(agent(30, 'assistant', { text: 'Earlier native commentary' }));
    view.setHistory(acceptedHistory([{ type: 'agentMessage', text: 'Earlier native commentary' }]));
    const retry = { ...agent(1, 'assistant', { text: 'Continued reply' }), retryAttempt: 1 };
    retry.event.runId = 'run-2';
    expect(view.accept(retry)).toBe(true);
    expect(view.accept(agent(50, 'assistant', { text: 'Late predecessor frame' }))).toBe(false);
    expect(view.bindRun('run-1', 1, 0)).toBe(false);
    expect(items(view).map(item => item.type)).toEqual([
      'userMessage',
      'agentMessage',
      'agentMessage',
    ]);
    expect(items(view).map(item => item.text)).toEqual([
      undefined,
      'Earlier native commentary',
      'Continued reply',
    ]);
  });

  it('calibrates overflowed pending deltas from history instead of displaying a missing prefix', () => {
    const view = new ChromeExtensionStream('one');
    view.start('Question');
    for (let sequence = 1; sequence <= 65; sequence += 1)
      view.accept(agent(sequence, 'assistant', { delta: 'part ' }));
    view.bindRun('run-1');
    expect(items(view).filter(item => item.type === 'agentMessage')).toEqual([]);
    expect(view.accept(agent(66, 'assistant', { delta: 'missing-prefix tail' }))).toBe(false);
    expect(items(view).filter(item => item.type === 'agentMessage')).toEqual([]);
    view.setHistory(history([{ type: 'agentMessage', text: 'Complete native reply' }]));
    expect(items(view).slice(-1)[0]?.text).toBe('Complete native reply');
    expect(
      view.accept(agent(67, 'assistant', { delta: 'still missing the stream baseline' })),
    ).toBe(false);
    expect(items(view).slice(-1)[0]?.text).toBe('Complete native reply');
  });

  it('projects admitted progress without creating a tool before native execution starts', () => {
    const view = new ChromeExtensionStream('one');
    view.start('Question');
    expect(view.bindRun('run-1', 1)).toBe(true);
    view.accept(agent(1, 'run_status', { phase: 'preparing_workspace' }));
    expect(view.project().activity).toMatchObject({
      runId: 'run-1',
      stage: 'preparing-workspace',
      startedAt: 1,
    });
    view.accept(
      agent(2, 'item', {
        itemId: 'run-stream-progress',
        kind: 'status',
        phase: 'update',
        status: 'running',
        progress: {
          kind: 'tool-input',
          toolCallId: 'read-1',
          name: 'read',
          receivedChars: 250,
          complete: false,
        },
      }),
    );
    expect(view.project().activity).toMatchObject({
      stage: 'generating-tool-input',
      progress: { kind: 'tool-input', receivedChars: 250 },
    });
    expect(items(view).some(item => item.type === 'toolCall')).toBe(false);
    view.accept(agent(3, 'tool', { phase: 'start', name: 'read', toolCallId: 'read-1' }));
    view.accept(
      agent(4, 'item', {
        kind: 'tool',
        phase: 'update',
        toolCallId: 'read-1',
        progressText: 'Reading chapter 2',
      }),
    );
    expect(view.project().activity).toMatchObject({
      stage: 'running-tool',
      progress: { kind: 'tool', name: 'read', summary: 'Reading chapter 2' },
    });
    expect(items(view).find(item => item.type === 'toolCall')).toMatchObject({
      progressText: 'Reading chapter 2',
      startedAt: 3,
      updatedAt: 4,
      status: 'inProgress',
    });
    view.accept(agent(5, 'tool', { phase: 'result', toolCallId: 'read-1', result: 'Done' }));
    expect(view.project().activity?.stage).toBe('waiting-model');
    expect(items(view).find(item => item.type === 'toolCall')?.progressText).toBeUndefined();
  });

  it('keeps whole-run activity after a chat final and clears it only when explicitly finished', () => {
    const view = new ChromeExtensionStream('one');
    view.bindRun('run-1', 1);
    view.accept(agent(1, 'assistant', { text: 'A final message' }));
    view.accept(chat('final', 'A final message'));
    expect(view.project().activity?.runId).toBe('run-1');
    view.finish(true);
    expect(view.project().activity).toBeUndefined();
    expect(view.accept(agent(2, 'assistant', { text: 'Late reply' }))).toBe(false);
  });

  it('ignores foreign runs, incarnations and stale progress for the bound native execution', () => {
    const view = new ChromeExtensionStream('one');
    view.bindRun('run-1', 1);
    const accepted = agent(10, 'thinking', { thinking: 'Inspecting' });
    accepted.event.sessionId = 'physical-1';
    accepted.event.lifecycleGeneration = 'generation-1';
    view.accept(accepted);
    const activity = view.project().activity;
    const foreignRun = agent(11, 'run_status', { phase: 'preparing_workspace' });
    foreignRun.event.runId = 'run-2';
    expect(view.accept(foreignRun)).toBe(false);
    const replaced = agent(12, 'run_status', { phase: 'preparing_workspace' });
    replaced.event.sessionId = 'physical-2';
    replaced.event.lifecycleGeneration = 'generation-2';
    expect(view.accept(replaced)).toBe(false);
    expect(view.accept(agent(9, 'run_status', { phase: 'starting_model' }))).toBe(false);
    expect(view.project().activity).toBe(activity);
    expect(view.bindRun('run-2')).toBe(false);
  });

  it('keeps the newest activity when a sparse tool snapshot backfills an earlier sequence', () => {
    const view = new ChromeExtensionStream('one');
    view.accept(agent(10, 'thinking', { thinking: 'New thinking' }));
    const snapshot = agent(5, 'tool', {
      phase: 'result',
      toolCallId: 'earlier',
      name: 'read',
      result: 'Old output',
    });
    if (snapshot.kind === 'agent') snapshot.event.deliveryEvent = 'session.tool';
    expect(view.accept(snapshot)).toBe(true);
    expect(view.project().activity?.stage).toBe('thinking');
    expect(items(view).find(item => item.toolUseId === 'earlier')?.output).toBe('Old output');
  });

  it('hides a scoped preview and restores its complete prefix after a delta-only final', () => {
    const view = new ChromeExtensionStream('one');
    view.setHistory(history());
    view.start('Question');
    view.bindRun('run-1');
    view.accept(
      agent(1, 'assistant', {
        text: 'Checking.',
        itemId: 'body-1',
        assistantTextScope: { id: 'source-1' },
      }),
    );
    view.accept(
      agent(2, 'item', {
        kind: 'preamble',
        phase: 'update',
        itemId: 'commentary-1',
        progressText: 'Checking.',
        assistantTextScope: { id: 'source-1' },
      }),
    );
    expect(items(view).filter(item => item.type === 'agentMessage')).toMatchObject([
      { text: 'Checking.' },
    ]);
    view.accept(
      agent(3, 'assistant', {
        delta: ' More.',
        itemId: 'body-1',
        assistantTextScope: { id: 'source-1', commentaryItemIds: [] },
      }),
    );
    expect(items(view).filter(item => item.type === 'agentMessage' && item.text)).toMatchObject([
      { text: 'Checking. More.' },
    ]);
  });

  it('rebases a compacted snapshot on exact native input identity even before terminal', () => {
    const view = new ChromeExtensionStream('one');
    view.setHistory({
      id: 'one',
      turns: [
        { id: 'old-1', items: [user] },
        { id: 'old-2', items: [user] },
      ],
    });
    view.start('Question', undefined, 'input-1');
    view.bindRun('run-1');
    view.accept(agent(1, 'assistant', { text: 'Current answer' }));
    const displayId = view.project().turns[2].id;
    const compacted = acceptedHistory([{ type: 'agentMessage', text: 'Current answer persisted' }]);
    view.setHistory(history([{ type: 'agentMessage', text: 'Current answer persisted' }]));
    expect(view.project().turns).toHaveLength(3);
    view.setHistory(compacted);
    expect(view.project().turns).toHaveLength(1);
    expect(view.project().turns[0].id).toBe(displayId);
    view.finish();
    expect(items(view)).toMatchObject([user, { text: 'Current answer persisted' }]);
    expect(view.project().turns).toHaveLength(1);
  });

  it('does not match post-tool text to history before an unpersisted tool', () => {
    const view = new ChromeExtensionStream('one');
    view.setHistory(history([{ type: 'agentMessage', text: 'Hello' }]));
    view.accept(agent(1, 'thinking', { thinking: 'inspect' }));
    view.accept(
      agent(2, 'tool', { phase: 'result', toolCallId: 't1', name: 'read', result: 'content' }),
    );
    view.accept(agent(3, 'assistant', { text: 'Hello' }));
    expect(items(view)).toMatchObject([
      user,
      { text: 'Hello' },
      { content: ['inspect'] },
      { toolUseId: 't1' },
      { text: 'Hello' },
    ]);
    view.setHistory(
      history([
        { type: 'agentMessage', text: 'Hello' },
        { type: 'reasoning', content: ['inspect'] },
        { type: 'toolCall', toolUseId: 't1', status: 'completed', output: 'content' },
        { type: 'agentMessage', text: 'Hello' },
      ]),
    );
    expect(items(view)).toMatchObject([
      user,
      { text: 'Hello' },
      { content: ['inspect'] },
      { toolUseId: 't1' },
      { text: 'Hello' },
    ]);
  });

  it('retains persisted tool input when joining at the result and does not rewind terminal results', () => {
    const view = new ChromeExtensionStream('one');
    view.setHistory(
      history([
        {
          type: 'toolCall',
          toolUseId: 't1',
          toolName: 'read',
          input: { path: 'a.txt' },
          status: 'inProgress',
        },
      ]),
    );
    view.accept(
      agent(10, 'tool', { phase: 'result', toolCallId: 't1', name: 'read', result: 'content' }),
    );
    expect(items(view).slice(-1)[0]).toMatchObject({
      input: { path: 'a.txt' },
      output: 'content',
      status: 'completed',
    });

    const late = new ChromeExtensionStream('one');
    late.setHistory(
      history([
        {
          type: 'toolCall',
          toolUseId: 't1',
          toolName: 'read',
          input: { path: 'a.txt' },
          output: 'content',
          status: 'completed',
        },
      ]),
    );
    late.accept(agent(1, 'tool', { phase: 'start', toolCallId: 't1', name: 'read' }));
    expect(items(late).slice(-1)[0]).toMatchObject({
      input: { path: 'a.txt' },
      output: 'content',
      status: 'completed',
    });
  });

  it('does not confuse a new text segment with the same prefix before a persisted tool', () => {
    const view = new ChromeExtensionStream('one');
    view.setHistory(
      history([
        { type: 'agentMessage', text: 'Hello previously' },
        { type: 'toolCall', toolUseId: 't1', status: 'completed' },
      ]),
    );
    view.accept(agent(20, 'assistant', { text: 'Hello' }));
    expect(items(view)).toMatchObject([
      user,
      { text: 'Hello previously' },
      { toolUseId: 't1' },
      { text: 'Hello' },
    ]);
  });

  it('joins the exact commentary owner when history reaches a tool before the live stream', () => {
    const view = new ChromeExtensionStream('one');
    view.setHistory(history());
    view.accept(
      agent(1, 'item', {
        kind: 'preamble',
        phase: 'update',
        itemId: 'commentary-1',
        progressText: 'Checking the file.',
      }),
    );
    view.setHistory(
      history([
        {
          type: 'agentMessage',
          text: 'Checking the file.',
          display: { sourceId: 'message-1', sourceSegmentId: 'commentary-1', sourceIndex: 0 },
        },
        { type: 'toolCall', toolUseId: 'read-1', status: 'inProgress' },
      ]),
    );

    expect(items(view)).toMatchObject([
      user,
      { text: 'Checking the file.' },
      { toolUseId: 'read-1' },
    ]);
    view.accept(agent(2, 'tool', { phase: 'start', toolCallId: 'read-1', name: 'read' }));
    expect(items(view)).toHaveLength(3);
  });

  it.each([
    { rich: false, thinking: false },
    { rich: true, thinking: true },
  ])(
    'reconciles whole-message commentary with split history ($rich, $thinking)',
    ({ rich, thinking }) => {
      const view = new ChromeExtensionStream('one');
      view.setHistory(history());
      const preamble = (seq: number, itemId: string, text: string) =>
        view.accept(
          agent(seq, 'item', {
            kind: 'preamble',
            phase: 'update',
            itemId,
            progressText: text,
            assistantTextScope: { id: 'scope-1', commentarySnapshot: 'message' },
          }),
        );
      preamble(1, 'commentary-1', 'First paragraph.');
      if (thinking) view.accept(agent(2, 'thinking', { text: 'Inspect the file.' }));
      preamble(3, 'commentary-2', 'First paragraph.\nSecond paragraph.');
      const native = (second: string) =>
        history([
          {
            type: 'agentMessage',
            text: 'First paragraph.',
            display: { sourceId: 'message-1', sourceSegmentId: 'commentary-1', sourceIndex: 0 },
            ...(rich
              ? {
                  rawMessage: {
                    role: 'assistant',
                    content: [
                      { type: 'text', text: 'First paragraph.' },
                      { type: 'image', source: { type: 'url', url: '/image.png' } },
                    ],
                  },
                }
              : {}),
          },
          {
            type: 'agentMessage',
            text: second,
            display: { sourceId: 'message-1', sourceSegmentId: 'commentary-2', sourceIndex: 0 },
          },
          ...(thinking ? [{ type: 'reasoning', content: ['Inspect the file.'] }] : []),
        ]);
      view.setHistory(native('Second'));
      expect(items(view).filter(item => item.type === 'agentMessage')).toMatchObject([
        { text: 'First paragraph.' },
        { text: 'Second paragraph.' },
      ]);
      expect(items(view).filter(item => item.type === 'reasoning')).toHaveLength(thinking ? 1 : 0);
      if (rich)
        expect(items(view).find(item => item.rawMessage)?.rawMessage).toMatchObject({
          content: expect.arrayContaining([
            { type: 'image', source: { type: 'url', url: '/image.png' } },
          ]),
        });
      view.finish(true);
      expect(
        items(view)
          .filter(item => item.type === 'agentMessage')
          .map(item => item.text),
      ).toEqual(['First paragraph.', 'Second paragraph.']);

      view.setHistory(native('Second paragraph.'));
      // Once history covers the snapshot, retire the live projection and retain
      // the native segmentation rather than persisting a coalesced transcript.
      expect(items(view).filter(item => item.type === 'agentMessage')).toMatchObject([
        { text: 'First paragraph.' },
        { text: 'Second paragraph.' },
      ]);
      expect(items(view).filter(item => item.type === 'reasoning')).toHaveLength(thinking ? 1 : 0);
    },
  );

  it('keeps equal commentary from distinct native scopes separate', () => {
    const view = new ChromeExtensionStream('one');
    view.setHistory(
      history([
        {
          type: 'agentMessage',
          text: 'Checking.',
          display: {
            sourceId: 'previous-message',
            sourceSegmentId: 'previous-commentary',
            sourceIndex: 0,
          },
        },
      ]),
    );
    view.accept(
      agent(1, 'item', {
        kind: 'preamble',
        phase: 'update',
        itemId: 'current-commentary',
        progressText: 'Checking.',
        assistantTextScope: { id: 'current-scope', commentarySnapshot: 'message' },
      }),
    );

    expect(
      items(view)
        .filter(item => item.type === 'agentMessage')
        .map(item => item.text),
    ).toEqual(['Checking.', 'Checking.']);
  });

  it('preserves unmatched historical activities when a tool event arrives late', () => {
    const view = new ChromeExtensionStream('one');
    view.setHistory(
      history([
        { type: 'toolCall', toolUseId: 't1', status: 'completed', output: 'first' },
        { type: 'reasoning', content: ['Later thinking'] },
        { type: 'toolCall', toolUseId: 't2', status: 'completed', output: 'second' },
      ]),
    );
    view.accept(
      agent(10, 'tool', { phase: 'result', toolCallId: 't1', name: 'read', result: 'first' }),
    );
    expect(items(view)).toMatchObject([
      user,
      { toolUseId: 't1' },
      { content: ['Later thinking'] },
      { toolUseId: 't2' },
    ]);
  });

  it('joins earlier persisted commentary when subscribing at a later cumulative owner', () => {
    const view = new ChromeExtensionStream('one');
    view.accept(
      agent(5, 'item', {
        kind: 'preamble',
        phase: 'update',
        itemId: 'commentary-2',
        progressText: 'First.\nSecond.',
        assistantTextScope: { id: 'scope-1', commentarySnapshot: 'message' },
      }),
    );
    view.setHistory(
      history([
        {
          type: 'agentMessage',
          text: 'First.',
          display: { sourceId: 'message-1', sourceSegmentId: 'commentary-1', sourceIndex: 0 },
        },
        {
          type: 'agentMessage',
          text: 'Second.',
          display: { sourceId: 'message-1', sourceSegmentId: 'commentary-2', sourceIndex: 0 },
        },
      ]),
    );

    expect(
      items(view)
        .filter(item => item.type === 'agentMessage')
        .map(item => item.text),
    ).toEqual(['First.', 'Second.']);
    view.finish(true);
    expect(view.project().activity).toBeUndefined();
    expect(
      items(view)
        .filter(item => item.type === 'agentMessage')
        .map(item => item.text),
    ).toEqual(['First.', 'Second.']);
  });

  it('preserves a revised whole-message snapshot and historical media until history catches up', () => {
    const view = new ChromeExtensionStream('one');
    view.accept(
      agent(5, 'item', {
        kind: 'preamble',
        phase: 'update',
        itemId: 'commentary-2',
        progressText: 'Revised first.\nSecond. More.',
        assistantTextScope: { id: 'scope-1', commentarySnapshot: 'message' },
      }),
    );
    view.setHistory(
      history([
        {
          type: 'agentMessage',
          text: 'First.',
          rawMessage: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'First.' },
              { type: 'image', source: { type: 'url', url: '/image.png' } },
            ],
          },
          display: { sourceId: 'message-1', sourceSegmentId: 'commentary-1', sourceIndex: 0 },
        },
        {
          type: 'agentMessage',
          text: 'Second.',
          display: { sourceId: 'message-1', sourceSegmentId: 'commentary-2', sourceIndex: 0 },
        },
      ]),
    );

    const visibleText = () =>
      items(view)
        .filter(item => item.type === 'agentMessage' && item.text)
        .map(item => item.text);
    expect(visibleText()).toEqual(['Revised first.\nSecond. More.']);
    expect(items(view).find(item => item.rawMessage)?.rawMessage).toMatchObject({
      content: expect.arrayContaining([
        { type: 'image', source: { type: 'url', url: '/image.png' } },
      ]),
    });
    view.finish(true);
    expect(visibleText()).toEqual(['Revised first.\nSecond. More.']);
  });

  it('aligns repeated text using shared tool boundaries when full history arrives', () => {
    const view = new ChromeExtensionStream('one');
    view.setHistory(history());
    view.accept(agent(1, 'assistant', { text: 'Hello first' }));
    view.accept(
      agent(2, 'tool', { phase: 'result', toolCallId: 't1', name: 'read', result: 'first' }),
    );
    view.accept(agent(3, 'assistant', { text: 'Hello second' }));
    view.setHistory(
      history([
        { type: 'agentMessage', text: 'Hello first' },
        { type: 'toolCall', toolUseId: 't1', status: 'completed', output: 'first' },
        { type: 'agentMessage', text: 'Hello second' },
      ]),
    );
    expect(items(view)).toMatchObject([
      user,
      { text: 'Hello first' },
      { toolUseId: 't1' },
      { text: 'Hello second' },
    ]);
  });

  it('keeps an optimistic turn display identity after persistence and completion', () => {
    const view = new ChromeExtensionStream('one');
    view.start('Question', undefined, 'input-1');
    view.bindRun('run-1');
    view.accept(agent(1, 'thinking', { thinking: 'Inspect' }));
    const turnId = view.project().turns[0].id;
    view.setHistory(acceptedHistory([{ type: 'reasoning', content: ['Inspect'] }]));
    expect(view.project().turns[0].id).toBe(turnId);
    view.finish();
    expect(view.project().turns[0].id).toBe(turnId);
    view.setHistory(acceptedHistory([{ type: 'reasoning', content: ['Inspect'] }]));
    expect(view.project().turns[0].id).toBe(turnId);
  });

  it('keeps process display identity while authoritative history takes over its longer content', () => {
    const view = new ChromeExtensionStream('one');
    view.setHistory(history());
    view.accept(agent(1, 'thinking', { thinking: 'Inspect' }));
    const liveId = items(view).find(item => item.type === 'reasoning')?.id;
    view.setHistory(
      history([{ id: 'native-reasoning', type: 'reasoning', content: ['Inspect details'] }]),
    );
    expect(items(view).find(item => item.type === 'reasoning')).toMatchObject({
      id: liveId,
      content: ['Inspect details'],
    });
    view.finish();
    expect(items(view).find(item => item.type === 'reasoning')?.id).toBe(liveId);
  });

  it('does not reuse a learned display key for duplicated or unrelated native sources', () => {
    const view = new ChromeExtensionStream('one');
    const persisted = {
      id: 'native-reasoning',
      type: 'reasoning',
      content: ['Inspect details'],
      display: { sourceId: 'native-owner', sourceIndex: 0 },
    };
    view.setHistory(history());
    view.accept(agent(1, 'thinking', { thinking: 'Inspect' }));
    view.setHistory(history([persisted]));
    const displayKey = items(view).find(item => item.type === 'reasoning')?.displayKey;
    expect(displayKey).toBeTruthy();
    view.finish();

    view.setHistory(
      history([{ ...persisted, display: { sourceId: 'unrelated-owner', sourceIndex: 0 } }]),
    );
    expect(items(view).find(item => item.type === 'reasoning')?.displayKey).toBeUndefined();
    view.setHistory(
      history([persisted, { ...persisted, id: 'other', content: ['Different body'] }]),
    );
    expect(
      items(view)
        .filter(item => item.type === 'reasoning')
        .map(item => item.displayKey),
    ).toEqual([undefined, undefined]);
    expect(
      items(view)
        .filter(item => item.type === 'reasoning')
        .map(item => item.content),
    ).toEqual([['Inspect details'], ['Different body']]);
    view.setHistory(history([persisted]));
    expect(items(view).find(item => item.type === 'reasoning')?.displayKey).toBeUndefined();
  });

  it('bounds retained presentation identities and restores only exact native source discriminators', () => {
    const view = new ChromeExtensionStream('one');
    const rows = Array.from({ length: 2049 }, (_, index) => ({
      type: 'reasoning',
      id: `native-${index}`,
      displayKey: `local-${index}`,
      content: ['Body'],
      display: { sourceId: `owner-${index}`, sourceIndex: 0 },
    }));
    view.setHistory(history(rows));
    const nativeOnly = (index: number) => ({
      type: 'reasoning',
      id: `native-${index}`,
      content: ['Body'],
      display: { sourceId: `owner-${index}`, sourceIndex: 0 },
    });
    view.setHistory(
      history([
        nativeOnly(0),
        nativeOnly(2048),
        {
          ...nativeOnly(2048),
          display: { sourceId: 'owner-2048', sourceIndex: 1 },
        },
      ]),
    );
    expect(
      items(view)
        .filter(item => item.type === 'reasoning')
        .map(item => item.displayKey),
    ).toEqual([undefined, 'local-2048', undefined]);
  });

  it('removes a rejected optimistic turn so the next send can reconcile history', () => {
    const view = new ChromeExtensionStream('one');
    view.start('Rejected question');
    view.cancelStart();
    expect(view.project().turns).toEqual([]);
    view.start('Question', undefined, 'input-1');
    view.bindRun('run-1');
    view.setHistory(acceptedHistory());
    view.accept(agent(1, 'assistant', { text: 'Reply' }));
    expect(items(view)).toMatchObject([user, { text: 'Reply' }]);
  });
  it.each([false, true])(
    'keeps the exact local input before an assistant-first snapshot and through terminal (existing chat: %s)',
    existing => {
      const view = new ChromeExtensionStream('one');
      const previous = { ...user, inputRunId: 'earlier-input' };
      const oldTurn = { id: 'old-turn', items: [previous] };
      const priorTurns = existing ? [oldTurn] : [];
      view.setHistory({ id: 'one', turns: priorTurns });
      view.start('Question', undefined, 'input-1');
      view.bindRun('native-run');
      const reply = { type: 'agentMessage', text: 'New reply' };
      view.setHistory({ id: 'one', turns: [...priorTurns, { id: 'new-turn', items: [reply] }] });
      expect(view.project().turns[priorTurns.length].items).toMatchObject([user, reply]);

      view.setHistory({ id: 'one', turns: [] }, true);
      view.finish();
      expect(items(view)).toMatchObject([user]);

      view.setHistory({
        id: 'one',
        turns: [...priorTurns, { id: 'new-turn', items: [nativeUser, reply] }],
      });
      expect(items(view)).toMatchObject([...(existing ? [previous] : []), nativeUser, reply]);
    },
  );

  it('keeps a late preceding reply in its original turn when the next input is absent', () => {
    const view = new ChromeExtensionStream('one');
    const oldUser = { ...user, id: 'old-user', inputRunId: 'old-input' };
    const oldReply = { id: 'old-reply', type: 'agentMessage', text: 'Earlier reply' };
    const previous = { id: 'history', items: [oldUser, oldReply] };
    view.setHistory({ id: 'one', turns: [previous] });
    view.start('Question', undefined, 'input-1');
    const nextReply = { id: 'new-reply', type: 'agentMessage', text: 'Late preceding reply' };
    const snapshot = { id: 'one', turns: [{ ...previous, items: [...previous.items, nextReply] }] };

    view.setHistory(snapshot, true);
    view.finish();
    expect(view.project().turns.map(turn => turn.items)).toMatchObject([
      [oldUser, oldReply, nextReply],
      [user],
    ]);

    view.setHistory(snapshot);
    expect(items(view)).toMatchObject([oldUser, oldReply, nextReply, user]);
  });

  it('retains attachment-only input until the exact native row, even across a pending-row gap', () => {
    const view = new ChromeExtensionStream('one');
    const rawMessage = {
      role: 'user',
      content: [{ type: 'attachment', attachment: { label: 'file.pdf' } }],
    };
    view.start('', rawMessage, 'input-1');
    const local = view.project().turns[0].items[0];
    expect(local.rawMessage).toEqual(rawMessage);

    const native = { ...local, inputRunId: 'input-1' };
    view.setHistory({
      id: 'one',
      turns: [
        { id: 'native', items: [{ ...native, pendingInput: { id: 'transfer', state: 'queued' } }] },
      ],
    });
    expect(items(view)).toHaveLength(1);
    expect(items(view)[0].pendingInput).toEqual({ id: 'transfer', state: 'queued' });

    view.setHistory({ id: 'one', turns: [] }, true);
    view.finish();
    expect(items(view)).toEqual([local]);
    view.setHistory({ id: 'one', turns: [{ id: 'native', items: [native] }] });
    expect(items(view)).toEqual([native]);
  });

  it('binds a website submission after history arrives without merging same-text inputs or cancelling another launch', () => {
    const view = new ChromeExtensionStream('one');
    const old = { id: 'prior', items: [{ ...user, inputRunId: 'other-input' }] };
    view.start('Question', undefined, 'website-request');
    view.setHistory({ id: 'one', turns: [old] });
    expect(items(view)).toHaveLength(2);
    view.finish();
    view.start('Question', undefined, 'next-request');
    view.setHistory({ id: 'one', turns: [old, { id: 'accepted', items: [nativeUser] }] });
    expect(items(view)).toHaveLength(4);

    expect(view.identifyInput('website-request', 'input-1')).toBe(true);
    expect(items(view)).toHaveLength(3);
    expect(items(view).filter(item => item.inputRunId === 'input-1')).toHaveLength(1);
    view.cancelStart('website-request');
    expect(items(view)).toHaveLength(3);
    view.cancelStart('next-request');
    expect(items(view)).toHaveLength(2);
  });

  it('settles buffered output only for the matching local submission', () => {
    const view = new ChromeExtensionStream('one');
    view.start('Question', undefined, 'web-launch');
    expect(view.accept(agent(1, 'assistant', { text: 'Fast reply' }))).toBe(false);
    expect(view.finishSubmission('unrelated-launch', 'run-1')).toBe(false);
    expect(items(view)).toMatchObject([user]);

    expect(view.finishSubmission('web-launch', 'run-1')).toBe(true);
    expect(items(view)).toMatchObject([user, { text: 'Fast reply' }]);

    view.identifyInput('web-launch', 'input-1');
    view.setHistory(acceptedHistory([{ type: 'agentMessage', text: 'Fast reply' }]));
    expect(items(view)).toMatchObject([nativeUser, { text: 'Fast reply' }]);
    view.start('New input', undefined, 'new-input');
    expect(view.finishSubmission('web-launch', 'run-1')).toBe(false);
    expect(items(view).at(-1)?.content).toEqual([{ type: 'text', text: 'New input' }]);
  });

  it('retains interrupted text until authoritative history contains it', () => {
    const view = new ChromeExtensionStream('one');
    view.setHistory(history());
    view.accept(agent(1, 'assistant', { text: 'Partial reply' }));
    view.finish(true);
    expect(items(view)).toMatchObject([user, { text: 'Partial reply' }]);
    expect(view.accept(agent(2, 'assistant', { text: 'Late reply' }))).toBe(false);
    view.setHistory(history([{ type: 'agentMessage', text: 'Partial reply persisted' }]));
    expect(items(view)).toMatchObject([user, { text: 'Partial reply persisted' }]);
  });
  it('shows growing text before history contains an assistant reply', () => {
    const view = new ChromeExtensionStream('one');
    view.setHistory(history());
    view.accept(agent(1, 'assistant', { text: 'Hello' }));
    expect(items(view)).toMatchObject([user, { type: 'agentMessage', text: 'Hello' }]);
    view.setHistory(history());
    view.accept(agent(2, 'assistant', { text: 'Hello world' }));
    expect(items(view)).toMatchObject([user, { text: 'Hello world' }]);
  });

  it('deduplicates repeated events and the parallel chat delivery path', () => {
    const view = new ChromeExtensionStream('one');
    view.setHistory(history());
    view.accept(agent(1, 'assistant', { delta: 'Hello' }));
    expect(view.accept(agent(1, 'assistant', { delta: 'Hello' }))).toBe(false);
    view.accept(chat('delta', 'Hello'));
    view.accept(agent(2, 'assistant', { delta: ' world' }));
    expect(items(view).slice(-1)[0]?.text).toBe('Hello world');
  });

  it('keeps Thinking, tool input/result and subsequent content in order', () => {
    const view = new ChromeExtensionStream('one');
    view.setHistory(history());
    view.accept(agent(1, 'thinking', { thinking: 'Inspect' }));
    view.accept(agent(2, 'thinking', { thinking: 'Inspect the file' }));
    view.accept(
      agent(3, 'tool', { phase: 'start', toolCallId: 't1', name: 'read', args: { path: 'a.txt' } }),
    );
    expect(items(view).slice(-1)[0]).toMatchObject({
      type: 'toolCall',
      input: { path: 'a.txt' },
      status: 'inProgress',
    });
    view.accept(
      agent(4, 'tool', { phase: 'result', toolCallId: 't1', name: 'read', result: 'file content' }),
    );
    view.accept(agent(5, 'assistant', { text: '**Done**' }));
    expect(items(view)).toMatchObject([
      user,
      { type: 'reasoning', content: ['Inspect the file'] },
      { type: 'toolCall', output: 'file content', status: 'completed' },
      { type: 'agentMessage', text: '**Done**' },
    ]);
  });

  it('does not duplicate live content when lagging history catches up', () => {
    const view = new ChromeExtensionStream('one');
    view.setHistory(history());
    view.accept(agent(1, 'assistant', { text: 'Hello world' }));
    view.setHistory(history([{ type: 'agentMessage', text: 'Hello' }]));
    expect(items(view)).toMatchObject([user, { text: 'Hello world' }]);
    view.setHistory(history([{ type: 'agentMessage', text: 'Hello world!' }]));
    view.finish();
    expect(items(view)).toMatchObject([user, { text: 'Hello world!' }]);
    expect(view.accept(agent(2, 'assistant', { text: 'late' }))).toBe(false);
  });

  it('keeps the previous turn separate while a new user message is not persisted', () => {
    const view = new ChromeExtensionStream('one');
    view.setHistory(history([{ type: 'agentMessage', text: 'Previous answer' }]));
    view.start('Next question');
    view.bindRun('run-1');
    view.accept(agent(1, 'assistant', { text: 'New answer' }));
    view.setHistory(history([{ type: 'agentMessage', text: 'Previous answer' }]));
    expect(view.project().turns).toHaveLength(2);
    expect(view.project().turns[0].items.slice(-1)[0]?.text).toBe('Previous answer');
    expect(view.project().turns[1].items.slice(-1)[0]?.text).toBe('New answer');
  });

  it('retains already persisted activities when joining halfway through a run', () => {
    const view = new ChromeExtensionStream('one');
    view.setHistory(
      history([
        { type: 'reasoning', content: ['Earlier thinking'] },
        { type: 'toolCall', toolUseId: 't1', status: 'completed' },
        { type: 'agentMessage', text: 'Hel' },
      ]),
    );
    view.accept(agent(10, 'assistant', { text: 'Hello' }));
    expect(items(view)).toHaveLength(4);
    expect(items(view).slice(-1)[0]?.text).toBe('Hello');
  });

  it('rejects another session and out of order snapshots', () => {
    const view = new ChromeExtensionStream('one');
    view.setHistory(history());
    view.accept(agent(5, 'assistant', { text: 'Current' }));
    const other = agent(6, 'assistant', { text: 'Wrong session' });
    other.event.sessionKey = 'agent:main:justdo:two';
    expect(view.accept(other)).toBe(false);
    expect(view.accept(agent(4, 'assistant', { text: 'Old' }))).toBe(false);
    expect(items(view).slice(-1)[0]?.text).toBe('Current');
  });

  it('does not end a live run on a retry-attempt error', () => {
    const view = new ChromeExtensionStream('one');
    view.setHistory(history());
    view.accept(agent(1, 'thinking', { text: 'Working' }));
    expect(view.accept(chat('error', 'Gateway timeout'))).toBe(false);
    view.accept(agent(2, 'assistant', { text: 'Recovered reply' }));
    expect(items(view).slice(-1)[0]?.text).toBe('Recovered reply');
  });

  it('removes rolled back terminal observations and accepts the corrected text', () => {
    const view = new ChromeExtensionStream('one');
    view.setHistory(history());
    view.accept(
      agent(1, 'assistant', {
        text: 'Tentative',
        itemId: 'candidate-1',
        justdoTerminalGuardObservation: { token: 'a', action: 'update' },
      }),
    );
    view.accept(
      agent(2, 'assistant', { justdoTerminalGuardObservation: { token: 'a', action: 'rollback' } }),
    );
    expect(items(view)).toEqual([user]);
    expect(view.accept(chat('delta', 'Corrected', 3))).toBe(true);
    expect(items(view).slice(-1)[0]?.text).toBe('Corrected');
    view.accept(agent(3, 'assistant', { text: 'Corrected' }));
    expect(items(view).slice(-1)[0]?.text).toBe('Corrected');
  });

  it('supports chat-only streams and terminal final snapshots', () => {
    const view = new ChromeExtensionStream('one');
    view.setHistory(history());
    view.accept(chat('delta', 'Hel'));
    view.accept(chat('delta', 'Hello'));
    view.accept(chat('final', 'Hello world'));
    expect(items(view)).toMatchObject([user, { text: 'Hello world' }]);
  });
});
