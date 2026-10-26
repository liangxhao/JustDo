import { describe, expect, it } from 'vitest';

import { sidePanelText as t } from '../conversation-overlay/modules/sidepanel-i18n.js';
import {
  isCurrentThreadRunning,
  mergePendingUserMessage,
  messagesFromThread,
  shouldShowTurnError,
  toolDisplayTitle,
  toolInputSummary,
} from '../conversation-overlay/modules/sidepanel-state.js';
import { BrowserExtensionStream } from '../conversation-overlay/modules/sidepanel-stream.js';

describe('browser extension side panel state', () => {
  it('folds pending and answered question history while retaining its structured values', () => {
    const questions = [{ id: 'stack', question: 'Which stack?', options: [{ id: 'react', label: 'React' }, { id: 'vue', label: 'Vue' }] }];
    const questionResult = { version: 1, questions, response: { status: 'answered', answers: { stack: { selected: ['react'] } } } };
    const project = (item: Record<string, unknown>) => messagesFromThread({ id: 'one', turns: [{ id: 'turn', items: [item] }], activity: {} });
    const pending = { type: 'toolCall', id: 'question-1', toolName: 'ask_user_question', status: 'inProgress', input: { questions } };
    expect(project(pending)).toMatchObject([{ role: 'completed-process', items: [{ role: 'question-presentation', item: { input: { questions } } }] }]);
    const answered = project({ ...pending, status: 'completed', questionResult });
    expect(answered).toMatchObject([{ role: 'completed-process', items: [{ role: 'question-presentation', item: { questionResult } }] }]);
    expect(answered[0].items[0].item.questionResult).toBe(questionResult);
    expect(project({ ...pending, status: 'failed', isError: true, questionResult })[0].role).toBe('completed-process');
    expect(project({ ...pending, input: { questions: [] } })[0].role).toBe('live-process');
  });

  it.each(['cancelled', 'interrupted', 'failed'])(
    'folds a %s unanswered question with no final reply and preserves another live tool',
    status => {
      const questions = [{ id: 'stack', question: 'Which stack?', options: [{ id: 'react', label: 'React' }, { id: 'vue', label: 'Vue' }] }];
      const entries = messagesFromThread({ id: 'one', activity: {}, turns: [{ id: 'turn', items: [
        { type: 'toolCall', id: 'read-1', toolName: 'read', status: 'inProgress', input: { path: 'README.md' } },
        { type: 'toolCall', id: 'question-1', toolName: 'ask_user_question', status, isError: status === 'failed', input: { questions }, output: 'Stopped waiting.' },
      ] }] });
      expect(entries.map(entry => entry.role)).toEqual(['live-process', 'completed-process']);
      expect(entries[1]).toMatchObject({ items: [{ role: 'question-presentation', item: { status, output: 'Stopped waiting.' } }] });
    },
  );

  it('uses accepted run identity when same-text pending inputs change', () => {
    const pending = { threadId: 'one', text: 'same', runId: 'current', persistedMatches: 1 };
    const old = { role: 'user', text: 'same', pendingInput: { runId: 'other' } };
    expect(mergePendingUserMessage([old], pending, 'one')).toHaveLength(2);
    const accepted = { role: 'user', text: 'same', pendingInput: { runId: 'current' } };
    expect(mergePendingUserMessage([accepted], pending, 'one')).toEqual([accepted]);
    const canonical = {
      role: 'user',
      text: 'same',
      rawMessage: { __openclaw: { idempotencyKey: 'current:user' } },
    };
    expect(mergePendingUserMessage([canonical], pending, 'one')).toEqual([canonical]);
  });
  it('preserves native pending status separately from canonical user messages', () => {
    const entries = messagesFromThread({
      id: 'one',
      turns: [
        {
          id: 'turn',
          items: [
            {
              type: 'userMessage',
              content: [{ type: 'text', text: 'accepted' }],
              pendingInput: { id: 'native-pending', state: 'interrupted' },
            },
          ],
        },
      ],
    });
    expect(entries[0].pendingInput).toEqual({ id: 'native-pending', state: 'interrupted' });
  });
  it('does not treat two empty thread ids as a running turn', () => {
    expect(isCurrentThreadRunning('', '')).toBe(false);
  });

  it('only reports a running turn for the selected real thread', () => {
    expect(isCurrentThreadRunning('thread-1', 'thread-1')).toBe(true);
    expect(isCurrentThreadRunning('thread-1', 'thread-2')).toBe(false);
  });

  it('does not show a completed turn error after switching threads', () => {
    expect(shouldShowTurnError('thread-1', 'thread-1', true)).toBe(true);
    expect(shouldShowTurnError('thread-1', 'thread-2', true)).toBe(false);
    expect(shouldShowTurnError('thread-1', 'thread-1', false)).toBe(false);
  });

  it('shows a submitted user message until it appears in persisted history', () => {
    const pending = { threadId: 'thread-1', text: 'Hello' };
    expect(mergePendingUserMessage([], pending, 'thread-1')).toEqual([
      { role: 'user', text: 'Hello' },
    ]);
    expect(mergePendingUserMessage([{ role: 'user', text: 'Hello' }], pending, 'thread-1')).toEqual(
      [{ role: 'user', text: 'Hello' }],
    );
    expect(mergePendingUserMessage([], pending, 'thread-2')).toEqual([]);
  });

  it('keeps a repeated user message optimistic until a new matching row is persisted', () => {
    const pending = { threadId: 'thread-1', text: 'Again', persistedMatches: 1 };
    const previous = [{ role: 'user', text: 'Again' }];
    expect(mergePendingUserMessage(previous, pending, 'thread-1')).toEqual([
      ...previous,
      { role: 'user', text: 'Again' },
    ]);
    expect(
      mergePendingUserMessage([...previous, { role: 'user', text: 'Again' }], pending, 'thread-1'),
    ).toEqual([...previous, { role: 'user', text: 'Again' }]);
  });

  it('formats a compact desktop-style tool input summary', () => {
    expect(toolInputSummary({ path: 'notes.txt', line: 12 })).toBe(
      '{ "path": "notes.txt", "line": 12 }',
    );
    expect(toolInputSummary('x'.repeat(200))).toBe(`${'x'.repeat(159)}…`);
  });

  it('uses the desktop tool display titles', () => {
    expect(toolDisplayTitle('read')).toBe('Read');
    expect(toolDisplayTitle('sessions_yield')).toBe('Yield');
    expect(toolDisplayTitle('custom_tool')).toBe('Custom Tool');
  });

  it('projects reasoning and completed tool calls for side panel rendering', () => {
    expect(
      messagesFromThread({
        turns: [
          {
            items: [
              { type: 'reasoning', summary: [], content: ['Check the file.'] },
              {
                type: 'toolCall',
                toolName: 'read',
                input: { path: 'notes.txt' },
                output: 'hello',
                status: 'completed',
              },
            ],
          },
        ],
      }),
    ).toMatchObject([
      {
        role: 'process',
        title: `${t('thinking')} × 1 · ${t('tool')} × 1`,
        running: false,
        thinkingCount: 1,
        toolCount: 1,
        items: [
          {
            id: undefined,
            type: 'thinking',
            text: 'Check the file.',
            title: t('thinking'),
            status: undefined,
          },
          {
            id: undefined,
            type: 'tool',
            title: 'Read',
            input: '{\n  "path": "notes.txt"\n}',
            output: 'hello',
            isError: false,
            status: 'completed',
          },
        ],
      },
    ]);
  });

  it('folds ended process before final content and leaves activity directly visible', () => {
    const entries = messagesFromThread({
      turns: [
        {
          items: [
            { type: 'reasoning', content: ['First thought.'] },
            { type: 'reasoning', content: ['Second thought.'] },
            { type: 'agentMessage', text: 'Interim answer' },
            { type: 'toolCall', toolName: 'read', status: 'inProgress' },
          ],
        },
      ],
    });

    expect(entries.map(entry => entry.role)).toEqual([
      'completed-process',
      'assistant',
      'live-process',
    ]);
    expect(entries[0].items).toMatchObject([
      { role: 'process', title: `${t('thinking')} × 2`, thinkingCount: 2 },
    ]);
    expect(entries[2].item).toMatchObject({ type: 'tool', status: 'inProgress', name: 'read' });
  });

  it('keeps a stable process key while new activity is appended', () => {
    const createThread = (items: Array<Record<string, unknown>>) => ({
      turns: [{ id: 'turn-1', items }],
    });
    const first = messagesFromThread(
      createThread([{ id: 'thinking-1', type: 'reasoning', content: ['First thought.'] }]),
    );
    const updated = messagesFromThread(
      createThread([
        { id: 'thinking-1', type: 'reasoning', content: ['First thought.'] },
        { id: 'tool-1', type: 'toolCall', toolName: 'read', status: 'inProgress' },
      ]),
    );

    expect(first[0].key).toBe(updated[0].key);
    expect(first[0].items[0].key).toBe(updated[0].items[0].key);
  });
});

const displayThread = (items: Array<Record<string, unknown>>, extra = {}) => ({
  id: 'thread',
  turns: [{ id: 'turn', items }],
  ...extra,
});
const endedTool = (extra = {}) => ({
  type: 'toolCall',
  toolUseId: 'tool-1',
  toolName: 'read',
  status: 'completed',
  input: { path: 'one.txt' },
  output: 'Native output',
  ...extra,
});
const reasoning = { type: 'reasoning', id: 'thinking', content: ['Inspect'] };
const finalMessage = {
  type: 'agentMessage',
  id: 'final',
  text: 'Final\n\nAll paragraphs remain visible',
};

describe('browser extension shared display boundaries', () => {
  it('groups completed Thinking, Tool and intermediate body under the desktop outer disclosure', () => {
    const entries = messagesFromThread(
      displayThread([
        reasoning,
        endedTool(),
        { type: 'agentMessage', id: 'middle', text: 'Checking the result' },
        endedTool({ toolUseId: 'tool-2', status: 'failed', isError: true }),
        finalMessage,
      ]),
    );

    expect(entries.map(entry => entry.role)).toEqual(['completed-process', 'assistant']);
    expect(entries[0].items).toMatchObject([
      { role: 'process', thinkingCount: 1, toolCount: 1 },
      { role: 'assistant', text: 'Checking the result' },
      { role: 'process', errorCount: 1, items: [{ status: 'failed', isError: true }] },
    ]);
    expect(entries[1].text).toBe(finalMessage.text);
  });

  it.each([undefined, 'unknown', 'inProgress', 'running'])(
    'keeps a Tool with %s result state visible',
    status => {
      const entries = messagesFromThread(displayThread([endedTool({ status }), finalMessage]));
      expect(entries[0]).toMatchObject({ role: 'live-process', item: { type: 'tool', status } });
    },
  );

  it.each(['nativeFailure', 'keepVisible'])(
    'keeps authenticated %s display content visible',
    flag => {
      const entries = messagesFromThread(
        displayThread([
          reasoning,
          { type: 'agentMessage', text: 'Native fallback', display: { [flag]: true } },
          endedTool(),
          finalMessage,
        ]),
      );
      expect(entries.map(entry => entry.role)).toEqual([
        'completed-process',
        'assistant',
        'completed-process',
        'assistant',
      ]);
      expect(entries[1].text).toBe('Native fallback');
    },
  );

  it('keeps native aborted content visible without treating a failed Tool as a run failure', () => {
    const entries = messagesFromThread(
      displayThread([
        endedTool({ status: 'failed', isError: true }),
        { type: 'agentMessage', text: 'Partial answer', display: { stopReason: 'aborted' } },
        finalMessage,
      ]),
    );
    expect(entries.map(entry => entry.role)).toEqual([
      'completed-process',
      'assistant',
      'assistant',
    ]);
    expect(entries[1].display).toEqual({ stopReason: 'aborted' });
  });

  it.each([{}, { activity: { phase: 'running' } }])(
    'protects active and unknown tails without hiding a kept-visible boundary',
    extra => {
      const entries = messagesFromThread(
        displayThread(
          [
            reasoning,
            { type: 'agentMessage', text: 'Fallback', display: { keepVisible: true } },
            endedTool(),
            finalMessage,
          ],
          extra,
        ),
        { protectTrailingTurn: !('activity' in extra) },
      );
      expect(entries.map(entry => entry.role)).toEqual([
        'process',
        'assistant',
        'process',
        'assistant',
      ]);
    },
  );

  it('preserves empty native reset markers as boundaries without clearing history or using fixed final_answer phase', () => {
    const entries = messagesFromThread(
      displayThread([
        reasoning,
        { type: 'agentMessage', text: 'Before', phase: 'final_answer' },
        { type: 'systemMessage', text: '', display: { kind: 'phase-boundary' } },
        endedTool(),
        finalMessage,
      ]),
    );
    expect(entries.map(entry => entry.role)).toEqual([
      'completed-process',
      'assistant',
      'phase-boundary',
      'completed-process',
      'assistant',
    ]);
    expect(entries[1].text).toBe('Before');
  });

  it('keeps unsupported empty rich content as a visible desktop fallback', () => {
    const entries = messagesFromThread(
      displayThread([
        reasoning,
        {
          type: 'systemMessage',
          text: '',
          display: {
            kind: 'unsupported-content',
            keepVisible: true,
            sourceId: 'delivery',
            sourceIndex: 0,
          },
        },
        finalMessage,
      ]),
    );
    expect(entries[1]).toMatchObject({
      role: 'system',
      text: t('desktopContent'),
      display: { keepVisible: true },
    });
    expect(entries.map(entry => entry.role)).toEqual(['process', 'system', 'assistant']);
  });

  it.each([{}, { activity: { phase: 'running' } }])(
    'protects the active user turn before and after system fallback boundaries',
    extra => {
      const question = (text: string) => ({
        type: 'userMessage',
        content: [{ type: 'text', text }],
      });
      const entries = messagesFromThread(
        displayThread(
          [
            question('Old question'),
            reasoning,
            { type: 'agentMessage', text: 'Old final' },
            question('Current question'),
            reasoning,
            { type: 'agentMessage', text: 'Intermediate' },
            {
              type: 'systemMessage',
              text: '',
              display: { kind: 'unsupported-content', keepVisible: true },
            },
            { type: 'systemMessage', text: 'Provider notice' },
            endedTool(),
            finalMessage,
          ],
          extra,
        ),
        { protectTrailingTurn: !('activity' in extra) },
      );
      expect(entries.map(entry => entry.role)).toEqual([
        'user',
        'completed-process',
        'assistant',
        'user',
        'process',
        'assistant',
        'system',
        'system',
        'process',
        'assistant',
      ]);
      expect(entries[4].items[0].text).toBe('Inspect');
      expect(entries[5].text).toBe('Intermediate');
    },
  );

  it('keeps plan and explicitly retained interaction Tool readers directly accessible', () => {
    const entries = messagesFromThread(
      displayThread([
        endedTool({ toolName: 'present_plan', output: 'Plan' }),
        endedTool({
          toolUseId: 'tool-2',
          display: { keepVisible: true },
          output: 'Interactive fallback',
        }),
        finalMessage,
      ]),
    );
    expect(entries.map(entry => entry.role)).toEqual(['live-process', 'live-process', 'assistant']);
    expect(entries[0].item).toMatchObject({
      name: 'present_plan',
      status: 'completed',
      output: 'Plan',
    });
    expect(entries[1].item.output).toBe('Interactive fallback');
  });

  it('retains structured progress and genuine compaction markers through desktop folding', () => {
    const input = { plan: [{ step: 'Check', status: 'completed' }] };
    const rawMessage = {
      role: 'system',
      content: '',
      __openclaw: { kind: 'compaction', summary: 'Context retained' },
    };
    const entries = messagesFromThread(
      displayThread([
        endedTool({ toolName: 'progress_card', input }),
        { type: 'systemMessage', text: '', rawMessage },
        finalMessage,
      ]),
    );
    expect(entries[0]).toMatchObject({
      role: 'completed-process',
      items: [
        { role: 'progress-receipt', item: { input } },
        { role: 'compaction', rawMessage },
      ],
    });
    expect(entries[0].items[0].item.input).toBe(input);
    expect(entries[0].items[1].rawMessage).toBe(rawMessage);
  });

  it.each([undefined, 'in-progress', 'unknown'])(
    'does not hide compaction with unsettled phase %s',
    phase => {
      const entries = messagesFromThread(
        displayThread([
          { type: 'systemMessage', text: '', display: { kind: 'compaction-status', phase } },
          finalMessage,
        ]),
      );
      expect(entries.map(entry => entry.role)).toEqual(['compaction', 'assistant']);
    },
  );

  it('preserves commentary sidecars with one native owner using the actual segment discriminator', () => {
    const entries = messagesFromThread(
      displayThread([
        {
          type: 'agentMessage',
          text: 'First sidecar',
          display: { sourceId: 'owner', sourceIndex: 0, sourceSegmentId: 'segment-a' },
        },
        {
          type: 'agentMessage',
          text: 'Second sidecar',
          display: { sourceId: 'owner', sourceIndex: 0, sourceSegmentId: 'segment-b' },
        },
        { ...finalMessage, display: { sourceId: 'owner', sourceIndex: 0 } },
      ]),
    );
    expect(entries[0].items.map(entry => entry.text)).toEqual(['First sidecar', 'Second sidecar']);
    const keys = [...entries[0].items.map(entry => entry.key), entries[1].key];
    expect(new Set(keys).size).toBe(3);
    expect(entries[1].text).toBe(finalMessage.text);
  });

  it('keeps duplicate source shapes as distinct rows using local occurrence keys', () => {
    const entries = messagesFromThread(
      displayThread([
        {
          type: 'agentMessage',
          text: 'First distinct body',
          display: { sourceId: 'owner', sourceIndex: 0 },
        },
        {
          type: 'agentMessage',
          text: 'Second distinct body',
          display: { sourceId: 'owner', sourceIndex: 0 },
        },
        finalMessage,
      ]),
    );
    expect(entries[0].items.map(entry => entry.text)).toEqual([
      'First distinct body',
      'Second distinct body',
    ]);
    expect(entries[0].items[0].key).not.toBe(entries[0].items[1].key);
  });

  it('preserves two Tools with a reused native toolCallId without mixing input, result or status', () => {
    const entries = messagesFromThread(
      displayThread([
        endedTool({
          display: { sourceId: 'first-run-message', sourceIndex: 0 },
          output: 'First result',
        }),
        endedTool({
          display: { sourceId: 'second-run-message', sourceIndex: 0 },
          input: { path: 'two.txt' },
          output: 'Second failure',
          status: 'failed',
          isError: true,
        }),
        finalMessage,
      ]),
    );
    const items = entries[0].items[0].items;
    expect(items.map(item => item.output)).toEqual(['First result', 'Second failure']);
    expect(items[0].key).not.toBe(items[1].key);
    expect(items[1]).toMatchObject({
      input: '{\n  "path": "two.txt"\n}',
      status: 'failed',
      isError: true,
    });
    const firstOnly = messagesFromThread(
      displayThread([
        endedTool({
          display: { sourceId: 'second-run-message', sourceIndex: 0 },
          input: { path: 'two.txt' },
          output: 'Second failure',
          status: 'failed',
          isError: true,
        }),
        finalMessage,
      ]),
    );
    expect(firstOnly[0].items[0].items[0].key).toBe(items[1].key);
  });

  it('keeps a Thinking key during actual live projection, history takeover and later exact-source refresh', () => {
    const view = new BrowserExtensionStream('thread');
    view.setHistory(displayThread([]));
    view.accept({
      kind: 'agent',
      event: {
        runId: 'run',
        sessionKey: 'agent:main:thread',
        sessionId: null,
        lifecycleGeneration: null,
        agentId: 'main',
        spawnedBy: null,
        agentSeq: 1,
        frameSeq: 1,
        deliveryEvent: 'agent',
        stream: 'thinking',
        timestamp: 1,
        data: { thinking: 'Inspect' },
      },
    });
    const live = messagesFromThread(view.project());
    const liveKey = live[0].item.key;
    const persisted = displayThread([
      {
        type: 'reasoning',
        id: 'ordinal-reasoning',
        content: ['Inspect details'],
        display: { sourceId: 'native-owner', sourceIndex: 0 },
      },
      finalMessage,
    ]);
    view.setHistory(persisted);
    expect(messagesFromThread(view.project())[0].item.key).toBe(liveKey);
    view.finish();
    const archived = messagesFromThread(view.project());
    expect(archived[0].items[0].items[0].key).toBe(liveKey);
    view.setHistory(persisted);
    const refreshed = messagesFromThread(view.project());
    expect(refreshed[0].items[0].items[0].key).toBe(liveKey);
    expect(refreshed[1].text).toBe(finalMessage.text);
  });
});
