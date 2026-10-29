import { describe, expect, test } from 'vitest';

import { toolOutcome } from '../tools/tool-presentation';
import { foldCompletedProcessRows } from './completed-process';
import { type PersistedTimelineItem, projectPersistedTimeline } from './project-history-timeline';
import type { ContentTimelineItem, ProcessSummaryTimelineItem, ProgressReceiptTimelineItem, QuestionPresentationTimelineItem } from './project-turn-items';
import { prepareVisibleTimelineRows } from './timeline-avatar-state';

function message(key: string, role = 'assistant', completed = false): PersistedTimelineItem {
  return {
    kind: 'history-message',
    key,
    message: { role, content: key, __openclaw: { runId: 'run-1', id: key } },
    ...(completed ? { runState: 'completed', completedAt: 30 } : {}),
  };
}

function summary(key: string): ProcessSummaryTimelineItem {
  return {
    kind: 'process-summary',
    key,
    runId: 'run-1',
    items: [],
    thinkingCount: 1,
    toolCount: 1,
    errorCount: 0,
    interruptedCount: 0,
  };
}

function progressReceipt(
  key: string,
  status: ProgressReceiptTimelineItem['item']['status'] = 'completed',
): ProgressReceiptTimelineItem {
  return {
    kind: 'progress-receipt',
    key,
    item: {
      id: key,
      runId: 'run-1',
      type: 'tool',
      name: 'progress_card',
      toolCallId: key,
      firstSeq: 1,
      lastSeq: 1,
      startedAt: 1,
      updatedAt: 1,
      status,
      input: { plan: [{ step: 'Verify results', status: 'in_progress' }] },
    },
  };
}

function question(key: string): QuestionPresentationTimelineItem {
  return {
    kind: 'question-presentation',
    key,
    item: { ...progressReceipt(key, 'running').item, name: 'ask_user_question' },
  };
}

describe('foldCompletedProcessRows', () => {
  test.each(['blocked', 'skipped'])('preserves a native %s outcome on an outputless persisted Yield result', outcome => {
    const timeline = projectPersistedTimeline([
      { role: 'assistant', content: [{ type: 'toolCall', id: 'yield-negative', name: 'sessions_yield' }] },
      {
        role: 'toolResult', kind: 'tool', status: outcome, toolCallId: 'yield-negative',
        toolName: 'sessions_yield', content: [],
      },
      { role: 'assistant', content: 'The model continued.' },
    ]);
    const original = timeline[0];
    expect(original).toMatchObject({ kind: 'live-process', item: { status: 'running' } });
    const before = structuredClone(timeline);
    const folded = foldCompletedProcessRows(prepareVisibleTimelineRows(timeline), {
      foldUnresolvedTools: true,
    });
    expect(folded.map(row => row.item.kind)).toEqual(['completed-process', 'history-message']);
    const group = folded[0].item;
    if (group.kind !== 'completed-process') throw new Error('Missing process disclosure');
    const summary = group.items[0];
    if (summary.kind !== 'process-summary') throw new Error('Missing process summary');
    const tool = summary.items[0];
    if (tool.type !== 'tool') throw new Error('Missing Yield tool');
    expect(toolOutcome(tool)).toBe(outcome);
    expect(tool.presentation?.outcome).toBe(outcome);
    expect(tool.status).toBe('running');
    expect(timeline).toEqual(before);
    expect(foldCompletedProcessRows(folded, { foldUnresolvedTools: true })).toEqual(folded);
  });

  test.each(['failed', 'cancelled'])('keeps an existing %s presentation while folding an unresolved tool', outcome => {
    const persisted: PersistedTimelineItem = {
      kind: 'live-process', key: 'negative-result', origin: 'persisted',
      item: {
        ...progressReceipt('negative-result', 'running').item,
        name: 'read', presentation: { outcome },
      },
    };
    const folded = foldCompletedProcessRows(prepareVisibleTimelineRows([persisted, message('final')]), {
      foldUnresolvedTools: true,
    });
    const group = folded[0].item;
    if (group.kind !== 'completed-process') throw new Error('Missing process disclosure');
    const summary = group.items[0];
    if (summary.kind !== 'process-summary') throw new Error('Missing process summary');
    expect(summary.items[0]).toBe(persisted.item);
    expect(toolOutcome(persisted.item as Parameters<typeof toolOutcome>[0])).toBe(outcome);
    expect(summary.errorCount).toBe(outcome === 'failed' ? 1 : 0);
    expect(summary.interruptedCount).toBe(outcome === 'cancelled' ? 1 : 0);
  });

  test('folds missing historical Yield results into one process summary without changing their status', () => {
    const timeline = projectPersistedTimeline([
      { role: 'user', content: 'Run both checks' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'Checking the first worker.' },
        { type: 'toolCall', id: 'yield-first', name: 'sessions_yield' },
      ] },
      { role: 'toolResult', toolCallId: 'yield-first', toolName: 'sessions_yield', content: [] },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'Checking the second worker.' },
        { type: 'toolCall', id: 'yield-second', name: 'sessions_yield' },
      ] },
      { role: 'toolResult', toolCallId: 'yield-second', toolName: 'sessions_yield', content: [] },
      { role: 'assistant', content: 'Here are both checks.' },
    ]);
    const before = structuredClone(timeline);
    const result = foldCompletedProcessRows(prepareVisibleTimelineRows(timeline), {
      foldUnresolvedTools: true,
    });
    expect(result.map(row => row.item.kind)).toEqual([
      'history-message', 'completed-process', 'history-message',
    ]);
    const group = result[1].item;
    if (group.kind !== 'completed-process') throw new Error('Missing historical disclosure');
    expect(group.items).toHaveLength(1);
    const process = group.items[0];
    expect(process).toMatchObject({ kind: 'process-summary', thinkingCount: 2, toolCount: 2 });
    if (process.kind !== 'process-summary') throw new Error('Missing process summary');
    expect(process.items.filter(item => item.type === 'tool')).toMatchObject([
      { status: 'running', presentation: { outcome: 'unknown' } },
      { status: 'running', presentation: { outcome: 'unknown' } },
    ]);
    expect(timeline).toEqual(before);
    expect(foldCompletedProcessRows(result, { foldUnresolvedTools: true })).toEqual(result);
  });

  test.each(['read', 'exec'])('folds a missing %s result only for opted-in inactive history', name => {
    const historical: PersistedTimelineItem = {
      kind: 'live-process', key: 'missing-tool', origin: 'persisted',
      item: { ...progressReceipt('missing-tool', 'running').item, name },
    };
    const rows = prepareVisibleTimelineRows([historical, message('final')]);
    expect(foldCompletedProcessRows(rows)).toEqual(rows);
    expect(foldCompletedProcessRows(rows, {
      foldUnresolvedTools: true, protectTrailingTurn: true,
    })).toEqual(rows);
    expect(foldCompletedProcessRows(rows, {
      foldUnresolvedTools: true, keepVisibleKeys: new Set([historical.key]),
    })).toEqual(rows);
    const active = { ...historical, origin: undefined };
    const activeRows = prepareVisibleTimelineRows([active, message('final')]);
    expect(foldCompletedProcessRows(activeRows, { foldUnresolvedTools: true })).toEqual(activeRows);
    const folded = foldCompletedProcessRows(rows, { foldUnresolvedTools: true });
    expect(folded.map(row => row.item.kind)).toEqual(['completed-process', 'history-message']);
    expect(historical.item).not.toHaveProperty('presentation.outcome');
  });

  test('keeps approvals, interactive deliveries and running progress visible beside an archived historical gap', () => {
    const historical: PersistedTimelineItem = {
      kind: 'live-process', key: 'old-yield', origin: 'persisted',
      item: { ...progressReceipt('old-yield', 'running').item, name: 'sessions_yield' },
    };
    const approval: PersistedTimelineItem = {
      kind: 'plan-presentation', key: 'approval',
      item: { ...progressReceipt('approval', 'running').item, name: 'present_plan' },
    };
    const interactive = message('interactive');
    if (interactive.kind !== 'history-message') throw new Error('Missing interactive fixture');
    interactive.message = { role: 'assistant', content: [{ type: 'canvas', title: 'Interactive answer' }] };
    const progress = progressReceipt('pending-progress', 'running');
    const rows = prepareVisibleTimelineRows([historical, approval, interactive, progress, message('final')]);
    const folded = foldCompletedProcessRows(rows, { foldUnresolvedTools: true });
    expect(folded.map(row => row.item.kind)).toEqual([
      'completed-process', 'plan-presentation', 'history-message', 'progress-receipt', 'history-message',
    ]);
    expect(folded[1].item).toBe(approval);
    expect(folded[2].item).toBe(interactive);
    expect(folded[3].item).toBe(progress);
  });

  test('does not archive an active historical tool when a system error flushes its rendering segment', () => {
    const historical: PersistedTimelineItem = {
      kind: 'live-process', key: 'current-yield', origin: 'persisted',
      item: { ...progressReceipt('current-yield', 'running').item, name: 'sessions_yield' },
    };
    const rows = prepareVisibleTimelineRows([
      message('current request', 'user'), historical, message('Parent commentary'),
      message('Native error detail', 'system'),
    ]);
    const folded = foldCompletedProcessRows(rows, {
      protectTrailingTurn: true, foldUnresolvedTools: true,
    });
    expect(folded.find(row => row.item.key === historical.key)?.item).toBe(historical);
    expect(historical.item).not.toHaveProperty('presentation.outcome');
    expect(folded.some(row => row.item.kind === 'completed-process' &&
      row.item.items.some(item => item.kind === 'process-summary' && item.items.some(process =>
        process.type === 'tool' && (process.status === 'running' && process.presentation?.outcome === 'unknown'),
      )),
    )).toBe(false);
  });

  test.each([
    { runId: 'announce:v1:agent:main:subagent:child' },
    { metadata: { modelName: 'openclaw/gateway-injected' } },
    { model: 'delivery-mirror', openclawDeliveryMirror: { kind: 'channel-final' } },
  ])('keeps a historical wait visible when only an injected delivery follows: %o', metadata => {
    const timeline = projectPersistedTimeline([
      { role: 'assistant', content: [{ type: 'toolCall', id: 'waiting', name: 'sessions_yield' }] },
      { role: 'assistant', content: 'Worker progress arrived.', ...metadata },
    ]);
    const rows = prepareVisibleTimelineRows(timeline);
    expect(foldCompletedProcessRows(rows, { foldUnresolvedTools: true })).toEqual(rows);
    expect(rows[0].item).toMatchObject({ kind: 'live-process', item: { status: 'running' } });
  });

  test.each(['cancelled', 'interrupted', 'failed'] as const)(
    'keeps a %s unanswered question folded without hiding another running tool or requiring final text',
    status => {
      const stopped = question('stopped');
      stopped.item.status = status;
      const otherTool: PersistedTimelineItem = {
        kind: 'live-process', key: 'other-tool',
        item: { ...progressReceipt('other-tool', 'running').item, name: 'read' },
      };
      const result = foldCompletedProcessRows(prepareVisibleTimelineRows([otherTool, stopped]), { protectTrailingTurn: true });

      expect(result.map(row => row.item.kind)).toEqual(['live-process', 'completed-process']);
      expect(result[0].item).toBe(otherTool);
      expect(result[1].item).toMatchObject({ items: [stopped] });
      expect(stopped.item.status).toBe(status);
    },
  );

  test('folds pending question history while protecting other active process and body rows', () => {
    const source = [summary('thinking'), message('commentary'), question('question')];
    const result = foldCompletedProcessRows(prepareVisibleTimelineRows(source), { protectTrailingTurn: true });

    expect(result.map(row => row.item.kind)).toEqual(['process-summary', 'history-message', 'completed-process']);
    expect(result[0].item).toBe(source[0]);
    expect(result[1].item).toBe(source[1]);
    expect(result[2].item).toMatchObject({ key: 'completed-process:question', items: [source[2]] });
    expect(result[2].showAvatar).toBe(false);
  });

  test('folds question-only and trailing question records without requiring a final reply', () => {
    const pending = question('pending');
    const only = foldCompletedProcessRows(prepareVisibleTimelineRows([pending]));
    expect(only).toMatchObject([{ item: { kind: 'completed-process', items: [pending] }, showAvatar: true }]);
    const final = message('final', 'assistant', true);
    const trailing = foldCompletedProcessRows(prepareVisibleTimelineRows([final, pending]));
    expect(trailing.map(row => row.item.kind)).toEqual(['history-message', 'completed-process']);
    expect(trailing[0].item).toBe(final);
  });

  test('merges cached pending question disclosures with adjacent settled process exactly once', () => {
    const pending = question('question');
    const protectedRows = foldCompletedProcessRows(prepareVisibleTimelineRows([summary('thinking'), pending]), { protectTrailingTurn: true });
    const final = message('final', 'assistant', true);
    const result = foldCompletedProcessRows([...protectedRows, ...prepareVisibleTimelineRows([summary('tool'), final])]);

    expect(result.map(row => row.item.kind)).toEqual(['completed-process', 'history-message']);
    expect(result[0].item).toMatchObject({ items: [summary('thinking'), pending, summary('tool')] });
    if (result[0].item.kind !== 'completed-process') throw new Error('Missing process group');
    expect(result[0].item.items.map(item => item.kind)).toEqual(['process-summary', 'question-presentation', 'process-summary']);
  });

  test('does not join question history across user or execution phase boundaries', () => {
    const boundary: PersistedTimelineItem = { kind: 'phase-boundary', key: 'phase', label: 'Continuation' };
    const source = [question('first'), message('user', 'user'), question('second'), boundary, question('third')];
    const result = foldCompletedProcessRows(prepareVisibleTimelineRows(source));

    expect(result.map(row => row.item.kind)).toEqual(['completed-process', 'history-message', 'completed-process', 'phase-boundary', 'completed-process']);
  });

  test('keeps host-marked rich rows visible without splitting a protected trailing turn', () => {
    const source = [
      summary('before'),
      message('commentary'),
      message('interactive fallback'),
      summary('after'),
      message('final'),
    ];
    const rows = prepareVisibleTimelineRows(source);
    const keepVisibleKeys = new Set(['interactive fallback']);

    expect(foldCompletedProcessRows(rows, { keepVisibleKeys, protectTrailingTurn: true })).toEqual(
      rows,
    );
    const folded = foldCompletedProcessRows(rows, { keepVisibleKeys });
    expect(folded.map(row => row.item.kind)).toEqual([
      'completed-process',
      'history-message',
      'completed-process',
      'history-message',
    ]);
    expect(folded[1].item).toBe(source[2]);
  });
  test.each([
    { kind: 'compaction' },
    { kind: 'compaction-skipped' },
    ...['completed', 'failed', 'aborted', 'skipped'].map(phase => ({
      kind: 'compaction-status',
      phase,
    })),
  ])('folds settled compaction with adjacent process records: %o', marker => {
    const compaction: PersistedTimelineItem = {
      kind: 'history-message',
      key: 'compaction',
      message: { role: 'system', content: '', __openclaw: { ...marker, id: 'compact-1' } },
    };
    const source = [
      summary('before'),
      message('commentary'),
      compaction,
      summary('after'),
      message('final'),
    ];
    const before = structuredClone(source);

    const result = foldCompletedProcessRows(prepareVisibleTimelineRows(source));

    expect(result.map(row => row.item.kind)).toEqual(['completed-process', 'history-message']);
    if (result[0].item.kind !== 'completed-process') throw new Error('Missing process group');
    expect(result[0].item.items).toEqual(source.slice(0, -1));
    expect(result[0].item.items[2]).toBe(compaction);
    expect(result[1].item).toBe(source[4]);
    expect(source).toEqual(before);
  });

  test.each(['in-progress', 'unknown', undefined])(
    'keeps unsettled compaction visible between folded records: %s',
    phase => {
      const compaction: PersistedTimelineItem = {
        kind: 'history-message',
        key: 'compaction',
        message: { role: 'system', __openclaw: { kind: 'compaction-status', phase } },
      };
      const source = [summary('before'), compaction, summary('after'), message('final')];

      const result = foldCompletedProcessRows(prepareVisibleTimelineRows(source));

      expect(result.map(row => row.item.kind)).toEqual([
        'completed-process',
        'history-message',
        'completed-process',
        'history-message',
      ]);
      expect(result[1].item).toBe(compaction);
    },
  );

  test.each([false, true])(
    'preserves one assistant avatar when compaction leads a process group (thinking: %s)',
    withThinking => {
      const compaction: PersistedTimelineItem = {
        kind: 'history-message',
        key: 'compaction',
        message: { role: 'system', __openclaw: { kind: 'compaction' } },
      };
      const source = [compaction, ...(withThinking ? [summary('thinking')] : []), message('final')];

      const result = foldCompletedProcessRows(prepareVisibleTimelineRows(source));

      expect(result.map(row => row.item.kind)).toEqual(['completed-process', 'history-message']);
      expect(result.map(row => row.showAvatar)).toEqual(
        withThinking ? [true, false] : [false, true],
      );
    },
  );

  test('keeps ordinary system messages as turn boundaries', () => {
    const system = message('system notice', 'system');
    const source = [
      summary('before'),
      message('earlier reply'),
      system,
      summary('after'),
      message('final'),
    ];

    const result = foldCompletedProcessRows(prepareVisibleTimelineRows(source));

    expect(result.map(row => row.item.kind)).toEqual([
      'completed-process',
      'history-message',
      'history-message',
      'completed-process',
      'history-message',
    ]);
    expect(result[2].item).toBe(system);
  });

  test.each(['system', 'assistant'])(
    'keeps %s compaction in the live tail, after the final answer, and without a final answer visible',
    role => {
      const compaction: PersistedTimelineItem = {
        kind: 'history-message',
        key: 'compaction',
        message: { role, __openclaw: { kind: 'compaction', id: 'compact-1' } },
      };
      const live = prepareVisibleTimelineRows([summary('before'), compaction, message('partial')]);
      expect(foldCompletedProcessRows(live, { protectTrailingTurn: true })).toEqual(live);
      const processOnly = prepareVisibleTimelineRows([summary('before'), compaction]);
      expect(foldCompletedProcessRows(processOnly)).toEqual(processOnly);
      const source = [summary('before'), message('final'), compaction];
      const result = foldCompletedProcessRows(prepareVisibleTimelineRows(source));
      expect(result.map(row => row.item.kind)).toEqual([
        'completed-process',
        'history-message',
        'history-message',
      ]);
      expect(result[2].item).toBe(compaction);
    },
  );

  test.each(['completed', 'failed', 'cancelled', 'interrupted'] as const)(
    'folds a %s progress receipt together with adjacent process records',
    status => {
      const progress = progressReceipt('progress', status);
      const source = [
        summary('before-progress'),
        progress,
        summary('after-progress'),
        message('commentary'),
        message('final', 'assistant', true),
      ];

      const result = foldCompletedProcessRows(prepareVisibleTimelineRows(source));

      expect(result.map(row => row.item.kind)).toEqual(['completed-process', 'history-message']);
      const group = result[0].item;
      if (group.kind !== 'completed-process') throw new Error('Missing process group');
      expect(group.items).toEqual(source.slice(0, -1));
      expect(group.items[1]).toBe(progress);
      expect(progress.item.status).toBe(status);
      expect(result[1].item).toBe(source[4]);
    },
  );

  test('keeps an unfinished progress receipt visible as a boundary between folded records', () => {
    const pending = progressReceipt('updating', 'running');
    const source = [summary('before'), pending, summary('after'), message('final')];

    const result = foldCompletedProcessRows(prepareVisibleTimelineRows(source));

    expect(result.map(row => row.item.kind)).toEqual([
      'completed-process',
      'progress-receipt',
      'completed-process',
      'history-message',
    ]);
    expect(result[1].item).toBe(pending);
  });

  test('folds all intermediate content in order and preserves the complete final block', () => {
    const source = [
      message('prompt', 'user'),
      summary('thinking'),
      message('commentary'),
      summary('tools'),
      message('final\n\nsecond paragraph', 'assistant', true),
    ];
    const rows = prepareVisibleTimelineRows(source);

    const result = foldCompletedProcessRows(rows);

    expect(result.map(row => row.item.kind)).toEqual([
      'history-message',
      'completed-process',
      'history-message',
    ]);
    const group = result[1].item;
    expect(group.kind).toBe('completed-process');
    if (group.kind !== 'completed-process') throw new Error('Missing process group');
    expect(group.items).toEqual(source.slice(1, -1));
    group.items.forEach((item, index) => expect(item).toBe(source[index + 1]));
    expect(result[2]).toBe(rows[4]);
    expect(result[1].showAvatar).toBe(true);
    expect(result[2].showFooter).toBe(true);
  });

  test('keeps the final reply visible before media-only and blank assistant deliveries', () => {
    const final = message('final', 'assistant', true);
    const audio = message('audio');
    const blank = message('blank');
    if (audio.kind !== 'history-message' || blank.kind !== 'history-message') {
      throw new Error('Invalid fixture');
    }
    audio.message = {
      role: 'assistant',
      model: 'gateway-injected',
      content: [{ type: 'audio', url: '/api/chat/media/outgoing/session/voice/full' }],
    };
    blank.message.content = [{ type: 'text', text: ' \n ' }];
    const process = summary('process');

    const result = foldCompletedProcessRows(
      prepareVisibleTimelineRows([process, final, audio, blank]),
    );

    expect(result[0].item).toMatchObject({ kind: 'completed-process', items: [process] });
    expect(result.slice(1).map(row => row.item)).toEqual([final, audio, blank]);
  });

  test.each([
    'MEDIA:E:/output/voice.wav',
    'MEDIA:E:/output/clip.mp4',
    '[[audio_as_voice]]\n[[reply_to_current]]',
  ])('keeps the final reply visible before delivery-only text: %s', text => {
    const final = message('final', 'assistant', true);
    const delivery = message('delivery');
    if (delivery.kind !== 'history-message') throw new Error('Invalid fixture');
    delivery.message.content = [{ type: 'text', text }];
    const process = summary('process');

    const result = foldCompletedProcessRows(prepareVisibleTimelineRows([process, final, delivery]));

    expect(result[0].item).toMatchObject({ kind: 'completed-process', items: [process] });
    expect(result.slice(1).map(row => row.item)).toEqual([final, delivery]);
    const onlyDelivery = prepareVisibleTimelineRows([process, delivery]);
    expect(foldCompletedProcessRows(onlyDelivery)).toEqual(onlyDelivery);
  });

  test('does not fold process records when the only assistant delivery is media', () => {
    const media = message('media');
    if (media.kind !== 'history-message') throw new Error('Invalid fixture');
    media.message.content = [{ type: 'video', url: '/api/chat/media/outgoing/session/video/full' }];
    const rows = prepareVisibleTimelineRows([summary('process'), media]);

    expect(foldCompletedProcessRows(rows)).toEqual(rows);
  });

  test.each([
    'MEDIA:E:/output/voice.wav',
    '[embed ref="report" /]',
  ])('keeps a historical rich delivery visible before the final reply: %s', text => {
    const delivery = message('delivery');
    if (delivery.kind !== 'history-message') throw new Error('Invalid fixture');
    delivery.message.content = [{ type: 'text', text }];
    const process = summary('process');
    const final = message('final', 'assistant', true);

    const result = foldCompletedProcessRows(prepareVisibleTimelineRows([process, delivery, final]));

    expect(result[0].item).toMatchObject({ kind: 'completed-process', items: [process] });
    expect(result.slice(1).map(row => row.item)).toEqual([delivery, final]);
  });

  test('keeps a completed live video delivery visible before the final reply', () => {
    const video: ContentTimelineItem = {
      kind: 'content',
      key: 'live-video',
      item: {
        id: 'live-video',
        runId: 'run-1',
        type: 'content',
        status: 'completed',
        sourceMode: 'delta',
        text: 'MEDIA:E:/output/clip.mp4',
        firstSeq: 1,
        lastSeq: 1,
        startedAt: 1,
        updatedAt: 1,
      },
    };
    const process = summary('process');
    const final = message('final', 'assistant', true);

    const result = foldCompletedProcessRows(prepareVisibleTimelineRows([process, video, final]));

    expect(result[0].item).toMatchObject({ kind: 'completed-process', items: [process] });
    expect(result.slice(1).map(row => row.item)).toEqual([video, final]);
  });

  test('uses mixed text and media as the final reply while keeping the complete delivery visible', () => {
    const media = message('media');
    if (media.kind !== 'history-message') throw new Error('Invalid fixture');
    media.message.content = [
      { type: 'text', text: 'Listen to the recording.' },
      { type: 'audio', url: '/api/chat/media/outgoing/session/voice/full' },
    ];
    const commentary = message('commentary');
    const process = summary('process');

    const result = foldCompletedProcessRows(prepareVisibleTimelineRows([process, commentary, media]));

    expect(result[0].item).toMatchObject({ kind: 'completed-process', items: [process, commentary] });
    expect(result[1].item).toBe(media);
  });

  test.each([' \n ', '[[audio_as_voice]]\nMEDIA:E:/output/voice.wav'])(
    'ignores live content without visible body text without bypassing streaming protection: %s',
    text => {
      const live: ContentTimelineItem = {
        kind: 'content',
        key: 'live-content',
        item: {
          id: 'live-content',
          runId: 'run-1',
          type: 'content',
          status: 'streaming',
          sourceMode: 'delta',
          text,
          firstSeq: 1,
          lastSeq: 1,
          startedAt: 1,
          updatedAt: 1,
        },
      };
      const final = message('final', 'assistant', true);
      const process = summary('process');
      const blankRows = prepareVisibleTimelineRows([process, final, live]);

      const result = foldCompletedProcessRows(blankRows);

      expect(result[0].item).toMatchObject({ kind: 'completed-process', items: [process] });
      expect(result.slice(1).map(row => row.item)).toEqual([final, live]);
      const streaming = { ...live, item: { ...live.item, text: 'More details are arriving.' } };
      const streamingRows = prepareVisibleTimelineRows([process, final, streaming]);
      expect(foldCompletedProcessRows(streamingRows)).toEqual(streamingRows);
    },
  );

  test('leaves explicitly running outcomes unfolded', () => {
    const final = message('final', 'assistant', true);
    if (final.kind !== 'history-message') throw new Error('Invalid fixture');
    final.runState = 'running';
    const rows = prepareVisibleTimelineRows([
      summary('process'),
      progressReceipt('progress'),
      message('commentary'),
      final,
    ]);

    expect(foldCompletedProcessRows(rows)).toEqual(rows);
  });

  test.each(['failed', 'aborted'] as const)(
    'folds settled process records before a %s reply without changing its outcome',
    state => {
      const final = message('final', 'assistant', true);
      if (final.kind !== 'history-message') throw new Error('Invalid fixture');
      final.runState = state;
      const commentary = message('commentary', 'assistant', true);
      if (commentary.kind !== 'history-message') throw new Error('Invalid fixture');
      commentary.runState = state;
      const source = [summary('process'), progressReceipt('progress'), commentary, final];
      const before = structuredClone(source);

      const result = foldCompletedProcessRows(prepareVisibleTimelineRows(source));

      expect(result.map(row => row.item.kind)).toEqual(['completed-process', 'history-message']);
      expect(result[0].item).toMatchObject({ items: source.slice(0, -1) });
      expect(result[1].item).toBe(final);
      expect(final.runState).toBe(state);
      expect(source).toEqual(before);
    },
  );

  test.each([
    { stopReason: 'error' },
    { stop_reason: 'error' },
    { stopReason: 'aborted' },
    { stop_reason: 'aborted' },
    { __justdoFailedRunMessage: true },
  ])('keeps an explicit failed reply visible between process groups: %o', failure => {
    const failed = message('failure');
    if (failed.kind !== 'history-message') throw new Error('Invalid fixture');
    failed.message = { ...failed.message, ...failure };
    const source = [summary('before-failure'), failed, summary('after-failure'), message('final')];

    const result = foldCompletedProcessRows(prepareVisibleTimelineRows(source));

    expect(result.map(row => row.item.kind)).toEqual([
      'completed-process',
      'history-message',
      'completed-process',
      'history-message',
    ]);
    expect(result[1].item).toBe(failed);
    expect(result[3].item).toBe(source[3]);
  });

  test('keeps a final failure message visible while folding its earlier process', () => {
    const final = message('failure');
    if (final.kind !== 'history-message') throw new Error('Invalid fixture');
    final.message = { ...final.message, __justdoFailedRunMessage: true };
    const process = summary('process');

    const result = foldCompletedProcessRows(prepareVisibleTimelineRows([process, final]));

    expect(result[0].item).toMatchObject({ kind: 'completed-process', items: [process] });
    expect(result[1].item).toBe(final);
  });

  test('folds historical rows without local timing receipts while retaining their native identities', () => {
    const final = message('final');
    const process = { ...summary('history-process'), runId: 'history-message-fallback' };
    const commentary = message('commentary');
    const result = foldCompletedProcessRows(
      prepareVisibleTimelineRows([process, commentary, final]),
    );

    expect(result[0].item).toMatchObject({
      kind: 'completed-process',
    });
    if (result[0].item.kind !== 'completed-process') throw new Error('Missing process group');
    expect(result[0].item.items).toEqual([process, commentary]);
    expect(result[0].item.items[0]).toBe(process);
    expect(process.runId).toBe('history-message-fallback');
    expect(result[1].item).toBe(final);
  });

  test('protects the live tail independently of receipts while folding earlier user turns', () => {
    const oldProcess = summary('old-process');
    const liveProcess = summary('live-process');
    const source = [
      message('old user', 'user'),
      oldProcess,
      message('old final'),
      message('new user', 'user'),
      liveProcess,
      progressReceipt('live-progress'),
      message('new commentary'),
      message('new partial', 'assistant', true),
    ];
    const result = foldCompletedProcessRows(prepareVisibleTimelineRows(source), {
      protectTrailingTurn: true,
    });

    expect(result.filter(row => row.item.kind === 'completed-process')).toHaveLength(1);
    expect(result[1].item).toMatchObject({ kind: 'completed-process', items: [oldProcess] });
    expect(result.slice(-4).map(row => row.item)).toEqual(source.slice(-4));
  });

  test('keeps approval cards, interactive deliveries, and pending tools outside disclosures', () => {
    const error = { ...summary('failed-tool'), errorCount: 1 };
    const plan: PersistedTimelineItem = {
      kind: 'plan-presentation',
      key: 'approval',
      item: {
        id: 'plan',
        runId: 'run-1',
        type: 'tool',
        name: 'present_plan',
        toolCallId: 'plan',
        firstSeq: 1,
        lastSeq: 1,
        startedAt: 1,
        updatedAt: 1,
        status: 'completed',
        input: {},
      },
    };
    const live: PersistedTimelineItem = {
      kind: 'live-process',
      key: 'pending',
      item: { ...plan.item, status: 'running' },
    };
    const media = message('delivery');
    if (media.kind !== 'history-message') throw new Error('Invalid fixture');
    media.message.content = [{ type: 'canvas', url: 'https://example.com/view' }];
    const source = [
      message('prompt', 'user'),
      message('commentary'),
      error,
      plan,
      media,
      live,
      message('final', 'assistant', true),
    ];

    const result = foldCompletedProcessRows(prepareVisibleTimelineRows(source));

    expect(result.map(row => row.item.kind)).toEqual([
      'history-message',
      'completed-process',
      'plan-presentation',
      'history-message',
      'live-process',
      'history-message',
    ]);
    expect(result[1].item).toMatchObject({
      kind: 'completed-process',
      items: [source[1], error],
    });
    expect(result.slice(2, 5).map(row => row.item)).toEqual([plan, media, live]);
  });

  test('keeps failed and interrupted process clusters in one disclosure with their original statuses', () => {
    const failed = { ...summary('failed'), errorCount: 2 };
    failed.items = [
      {
        id: 'failed-thinking',
        runId: 'run-1',
        type: 'thinking',
        status: 'failed',
        text: 'failed',
        firstSeq: 1,
        lastSeq: 1,
        startedAt: 1,
        updatedAt: 1,
      },
    ];
    const interrupted = { ...summary('interrupted'), interruptedCount: 1 };
    interrupted.items = [{ ...failed.items[0], id: 'interrupted-thinking', status: 'interrupted' }];
    const source = [
      summary('first'),
      message('first commentary'),
      failed,
      message('second commentary'),
      interrupted,
      message('final'),
    ];

    const result = foldCompletedProcessRows(prepareVisibleTimelineRows(source));

    expect(result).toHaveLength(2);
    expect(result[0].item).toMatchObject({
      kind: 'completed-process',
      items: source.slice(0, -1),
    });
    if (result[0].item.kind !== 'completed-process') throw new Error('Missing process group');
    expect(result[0].item.items[2]).toBe(failed);
    expect(result[0].item.items[4]).toBe(interrupted);
    expect(failed.items[0].status).toBe('failed');
    expect(interrupted.items[0].status).toBe('interrupted');
  });

  test('keeps user turns, phase boundaries, and explicit other runs separate', () => {
    const otherRun = { ...summary('other-run'), runId: 'run-other' };
    const phase = { kind: 'phase-boundary' as const, key: 'phase', label: 'Implementation' };
    const source = [
      message('first user', 'user'),
      message('earlier commentary'),
      message('next user', 'user'),
      otherRun,
      phase,
      message('current commentary'),
      message('final', 'assistant', true),
    ];

    const result = foldCompletedProcessRows(prepareVisibleTimelineRows(source));

    expect(result.slice(0, 5).map(row => row.item)).toEqual(source.slice(0, 5));
    expect(result[5].item).toMatchObject({ kind: 'completed-process', items: [source[5]] });
    expect(result[6].item).toBe(source[6]);
  });

  test('does not hide process-only replies or trailing records after the final answer', () => {
    const progress = progressReceipt('progress');
    const onlyProcess = prepareVisibleTimelineRows([summary('process'), progress]);
    expect(foldCompletedProcessRows(onlyProcess)).toEqual(onlyProcess);
    const trailing = summary('trailing');
    const final = message('final', 'assistant', true);
    const result = foldCompletedProcessRows(
      prepareVisibleTimelineRows([message('commentary'), final, trailing, progress]),
    );
    expect(result.map(row => row.item.kind)).toEqual([
      'completed-process',
      'history-message',
      'process-summary',
      'progress-receipt',
    ]);
    expect(result[1].item).toBe(final);
    expect(result[2].item).toBe(trailing);
    expect(result[3].item).toBe(progress);
  });

  test('groups display rows across native run boundaries without merging or rewriting their ownership', () => {
    const otherRun = { ...summary('other-run'), runId: 'run-other' };
    const source = [
      message('prompt', 'user'),
      otherRun,
      message('commentary'),
      message('final', 'assistant', true),
    ];

    const result = foldCompletedProcessRows(prepareVisibleTimelineRows(source));

    expect(result[1].item).toMatchObject({
      kind: 'completed-process',
      items: [otherRun, source[2]],
    });
    if (result[1].item.kind !== 'completed-process') throw new Error('Missing process group');
    expect(result[1].item.items[0]).toBe(otherRun);
    expect(otherRun.runId).toBe('run-other');
    expect(result[2].item).toBe(source[3]);
  });

  test('retains the native identities inside a coalesced process summary', () => {
    const mixed = summary('mixed');
    mixed.items = [
      {
        id: 'foreign-thinking',
        runId: 'run-other',
        type: 'thinking',
        text: 'Other run',
        status: 'completed',
        firstSeq: 1,
        lastSeq: 1,
        startedAt: 1,
        updatedAt: 1,
      },
    ];
    const rows = prepareVisibleTimelineRows([mixed, message('final', 'assistant', true)]);

    const result = foldCompletedProcessRows(rows);
    expect(result[0].item.kind).toBe('completed-process');
    if (result[0].item.kind !== 'completed-process') throw new Error('Missing process group');
    expect(result[0].item.items[0]).toBe(mixed);
    expect(mixed.items[0].runId).toBe('run-other');
    expect(result[1]).toBe(rows[1]);
  });
});
