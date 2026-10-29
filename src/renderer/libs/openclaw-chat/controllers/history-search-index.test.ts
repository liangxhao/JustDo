import { describe, expect, test } from 'vitest';

import type { ThinkingItem, ToolItem } from '../model/chat-transcript-state';
import type { VisibleTimelineItem, VisibleTimelineRow } from '../model/timeline/timeline-avatar-state';
import { HistorySearchIndex } from './history-search-index';

function thinking(id: string, text: string): ThinkingItem {
  return {
    id, text, runId: 'metadata-run', firstSeq: 1, lastSeq: 1,
    startedAt: 1, updatedAt: 1, type: 'thinking', status: 'completed',
  };
}

function tool(id: string, input: unknown, output: string): ToolItem {
  return {
    id, input, output, runId: 'metadata-run', firstSeq: 1, lastSeq: 1,
    startedAt: 1, updatedAt: 1, type: 'tool', status: 'completed',
    toolCallId: id, name: 'read',
  };
}

function row(item: VisibleTimelineItem): VisibleTimelineRow {
  return { item, showAvatar: true, showFooter: false };
}

function message(key: string, text: string): VisibleTimelineRow {
  return row({ kind: 'history-message', key, message: { role: 'assistant', content: text } });
}

describe('HistorySearchIndex', () => {
  test('finds offscreen reasoning deep inside a folded process without materializing it', () => {
    const index = new HistorySearchIndex();
    const children = Array.from({ length: 1_000 }, (_, position) => ({
      kind: 'process-summary' as const,
      key: `summary-${position}`,
      runId: `run-${position}`,
      items: [thinking(`thinking-${position}`, `Reasoning ${position}`)],
      thinkingCount: 1, toolCount: 0, errorCount: 0, interruptedCount: 0,
    }));
    const rows = [row({ kind: 'completed-process', key: 'completed', items: children })];

    const matches = index.find(rows, 'Reasoning 437', true);

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      path: ['completed', 'summary-437'], processId: 'thinking-437', occurrence: 0,
      text: 'Reasoning 437', start: 0, end: 13,
    });
    expect(children).toHaveLength(1_000);
  });

  test('counts literal occurrences in source order with independent case sensitivity', () => {
    const index = new HistorySearchIndex();
    const rows = [message('one', 'A.b a.b A.b'), message('two', 'a.b')];

    const sensitive = index.find(rows, 'A.b', true);
    expect(sensitive.map(match => [match.path, match.occurrence, match.start])).toEqual([
      [['one'], 0, 0], [['one'], 1, 8],
    ]);
    const insensitive = index.find(rows, 'a.b', false);
    expect(insensitive.map(match => [match.path, match.occurrence, match.start])).toEqual([
      [['one'], 0, 0], [['one'], 1, 4], [['one'], 2, 8], [['two'], 0, 0],
    ]);
    expect(index.find(rows, '   ', false)).toEqual([]);
  });

  test('searches rendered Markdown text, escaped HTML and code without indexing formatting or link destinations', () => {
    const index = new HistorySearchIndex();
    const rows = [message('body', [
      '# Heading **Needle**',
      '[Visible link](https://secret-destination.example)',
      '![private-image-alt](https://private-image.example)',
      '<span title="private-attribute">Visible HTML</span>',
      'A <script>private-script-source</script> B',
      '```typescript',
      'const codeNeedle = true;',
      '```',
    ].join('\n\n'))];

    expect(index.find(rows, 'Needle', true)).toHaveLength(2);
    expect(index.find(rows, 'Visible link', true)).toHaveLength(1);
    expect(index.find(rows, 'Visible HTML', true)).toHaveLength(1);
    expect(index.find(rows, 'private-attribute', true)).toHaveLength(1);
    expect(index.find(rows, 'private-script-source', true)).toHaveLength(1);
    for (const query of [
      'secret-destination', 'private-image', 'typescript',
    ])
      expect(index.find(rows, query, false)).toEqual([]);
  });

  test('retains raw inline and block HTML exactly as visible escaped source', () => {
    const index = new HistorySearchIndex();
    const rows = [
      message('inline', '<span title="NeedleAttr">body</span>'),
      message('block', '<script>NeedleScript</script>\n<style>.NeedleStyle {}</style>'),
      message('comment', '<!-- NeedleComment -->'),
    ];

    expect(index.find(rows, 'title="NeedleAttr"', true)).toHaveLength(1);
    expect(index.find(rows, '<span', true)).toHaveLength(1);
    expect(index.find(rows, 'NeedleScript', true)).toHaveLength(1);
    expect(index.find(rows, 'NeedleStyle', true)).toHaveLength(1);
    expect(index.find(rows, '<!-- NeedleComment -->', true)).toHaveLength(1);
  });

  test('indexes actual tool values and terminal text, including hidden process children', () => {
    const index = new HistorySearchIndex();
    const process = { ...tool('tool-id', { path: 'needle.txt' }, '\u001b[31mneedle output\u001b[0m'), name: 'exec' };
    const rows = [
      row({ kind: 'live-process', key: 'tool-row', item: process }),
      row({ kind: 'terminal', key: 'terminal-row', item: {
        id: 'terminal-id', runId: 'run', firstSeq: 2, lastSeq: 2, startedAt: 2, updatedAt: 2,
        type: 'terminal', status: 'error', message: 'A needle failure',
      } }),
    ];

    const matches = index.find(rows, 'needle', true);

    expect(matches).toHaveLength(3);
    expect(matches.map(match => [match.path, match.processId, match.occurrence])).toEqual([
      [['tool-row'], 'tool-id', 0], [['tool-row'], 'tool-id', 1],
      [['terminal-row'], undefined, 0],
    ]);
    expect(matches[0].text).not.toContain('\u001b');
  });

  test('does not index row/process metadata, native widget HTML or embed addresses', () => {
    const index = new HistorySearchIndex();
    const rows = [
      row({ kind: 'live-process', key: 'private-needle-key', item: {
        ...thinking('private-needle-id', 'Visible reasoning'), runId: 'private-needle-run',
      } }),
      row({ kind: 'native-widget', key: 'widget', preview: {
        html: 'private-needle HTML', docId: 'private-needle-document',
      } } as unknown as VisibleTimelineItem),
      message('embed', 'Before [embed url="https://private-needle.example" /] After'),
    ];

    expect(index.find(rows, 'private-needle', false)).toEqual([]);
    expect(index.find(rows, 'Visible reasoning', true)).toHaveLength(1);
    expect(index.find(rows, 'Before', true)).toHaveLength(1);
  });

  test('indexes file/code-mode reader source instead of omitted input metadata', () => {
    const index = new HistorySearchIndex();
    const write = { ...tool('write', { path: 'HiddenWritePath.txt', content: 'VisibleWriteCode' }, 'Write complete'), name: 'write' };
    const exec = { ...tool('exec', { code: 'VisibleExecCode()', title: 'HiddenExecTitle' }, 'Exec complete'), name: 'exec' };
    const patch = { ...tool('patch', [
      '*** Begin Patch',
      '*** Add File: HiddenPatchPath.txt',
      '+VisiblePatchCode',
      '*** End Patch',
    ].join('\n'), 'Patch complete'), name: 'apply_patch' };
    const edit = { ...tool('edit', { path: 'HiddenEditPath', oldText: 'VisibleOldCode', newText: 'VisibleNewCode' }, 'Edit complete'), name: 'edit' };
    const rows = [write, exec, patch, edit].map(item => row({ kind: 'live-process', key: item.id, item }));

    for (const query of ['VisibleWriteCode', 'VisibleExecCode', 'VisiblePatchCode', 'VisibleOldCode', 'VisibleNewCode'])
      expect(index.find(rows, query, true)).toHaveLength(1);
    for (const query of ['HiddenWritePath', 'HiddenExecTitle', 'HiddenPatchPath', 'Begin Patch', 'HiddenEditPath', 'oldText', 'newText'])
      expect(index.find(rows, query, true)).toEqual([]);
    expect(index.find(rows, 'VisibleOldCode', true)[0]).toMatchObject({ editDiff: true, processId: 'edit' });
    expect(index.find(rows, 'complete', true)).toHaveLength(4);
  });

  test('indexes only native diff hunks that are actually included in the bounded display', () => {
    const index = new HistorySearchIndex();
    const context = Array.from({ length: 30 }, (_, line) => line === 15 ? 'OmittedContext' : `Context ${line}`);
    const process = { ...tool('bounded-diff', {
      path: 'source.txt',
      oldText: [...context, 'VisibleOldCode'].join('\n'),
      newText: [...context, 'VisibleNewCode'].join('\n'),
    }, 'Edit complete'), name: 'edit' };
    const rows = [row({ kind: 'live-process', key: 'bounded-diff', item: process })];

    expect(index.find(rows, 'VisibleOldCode', true)).toHaveLength(1);
    expect(index.find(rows, 'VisibleNewCode', true)).toHaveLength(1);
    expect(index.find(rows, 'OmittedContext', true)).toEqual([]);
  });

  test('normalizes only terminal output using the reader ANSI and newline projection', () => {
    const index = new HistorySearchIndex();
    const input = 'literal \u001b[31mInputValue';
    const output = '\u001b]0;HiddenTerminalTitle\u0007Visible\r\nOutputValue\u001b[0m';
    const process = { ...tool('terminal', input, output), name: 'exec' };
    const rows = [row({ kind: 'live-process', key: 'terminal', item: process })];

    expect(index.find(rows, 'HiddenTerminalTitle', true)).toEqual([]);
    expect(index.find(rows, 'Visible\nOutputValue', true)).toHaveLength(1);
    expect(index.find(rows, '\u001b[31mInputValue', true)).toHaveLength(1);
  });

  test('indexes only question content visible in its current native presentation', () => {
    const index = new HistorySearchIndex();
    const questions = [{
      id: 'HiddenQuestionId', question: 'Visible **Prompt**', multiSelect: true,
      options: [
        { id: 'HiddenSelectedId', label: 'Visible selected answer', input: { label: 'Visible note label' } },
        { id: 'HiddenUnselectedId', label: 'Hidden unselected answer' },
      ],
    }];
    const completed: ToolItem = {
      ...tool('question-tool', { questions }, 'Hidden raw result'),
      name: 'ask_user_question',
      presentation: { questionResult: {
        version: 1, questions,
        response: { status: 'answered', answers: { HiddenQuestionId: {
          selected: ['HiddenSelectedId'],
          optionInputs: { HiddenSelectedId: 'Visible note value' },
          other: 'Visible other answer',
        } } },
      } },
    };
    const waiting = [row({ kind: 'question-presentation', key: 'question', item: {
      ...completed, status: 'running', presentation: undefined,
    } })];
    expect(index.find(waiting, 'Visible', true)).toEqual([]);

    const rows = [row({ kind: 'question-presentation', key: 'question', item: completed })];
    for (const query of ['Visible **Prompt**', 'Visible selected answer', 'Visible note label: Visible note value', 'Visible other answer'])
      expect(index.find(rows, query, true)).toHaveLength(1);
    for (const query of ['HiddenQuestionId', 'HiddenSelectedId', 'HiddenUnselectedId', 'Hidden unselected answer', 'Hidden raw result'])
      expect(index.find(rows, query, true)).toEqual([]);

    const failed = [row({ kind: 'question-presentation', key: 'question', item: {
      ...completed, status: 'failed', error: 'Visible native failure',
    } })];
    expect(index.find(failed, 'Visible native failure', true)).toHaveLength(1);
    expect(index.find(failed, 'Visible selected answer', true)).toEqual([]);
  });

  test('indexes only the visible progress receipt current step, not its plan envelope', () => {
    const index = new HistorySearchIndex();
    const receipt = { ...tool('progress', {
      plan: [
        { step: 'Hidden completed step', status: 'completed' },
        { step: 'Visible current step', status: 'in_progress' },
        { step: 'Hidden pending step', status: 'pending' },
      ],
      markdown: 'Hidden markdown note',
    }, 'Hidden raw output'), name: 'progress_card' };
    const rows = [row({ kind: 'progress-receipt', key: 'progress', item: receipt })];
    expect(index.find(rows, 'Visible current step', true)).toHaveLength(1);
    for (const query of ['Hidden', 'in_progress', 'markdown'])
      expect(index.find(rows, query, true)).toEqual([]);
    const waiting = [row({ kind: 'progress-receipt', key: 'progress', item: { ...receipt, status: 'running' } })];
    expect(index.find(waiting, 'Visible current step', true)).toEqual([]);
  });

  test('does not index the plan preview button or its unopened native document', () => {
    const index = new HistorySearchIndex();
    const rows = [row({ kind: 'plan-presentation', key: 'plan', item: {
      ...tool('plan', { title: 'Hidden preview title', plan: 'Hidden preview body' }, 'Hidden preview result'),
      name: 'present_plan',
    } })];
    expect(index.find(rows, 'Hidden', true)).toEqual([]);
  });

  test('uses the escaped-source fallback for oversized Markdown bodies', () => {
    const index = new HistorySearchIndex();
    const rows = [message('large', `${'text '.repeat(8_001)}**large needle**`)];

    expect(index.find(rows, '**large needle**', true)).toHaveLength(1);
  });

  test('caches immutable projections and queries, rebuilding after source replacement or clear', () => {
    const index = new HistorySearchIndex();
    const rows = [message('body', 'First needle')];
    const matches = index.find(rows, 'needle', false);
    expect(index.find(rows, ' needle ', false)).toBe(matches);
    expect(index.find([message('body', 'Other text')], 'needle', false)).toEqual([]);
    expect(index.find(rows, 'needle', false)).toHaveLength(1);
    index.clear();
    expect(index.find([], 'needle', false)).toEqual([]);
    expect(index.find(rows, 'needle', false)).not.toBe(matches);
  });

  test('does not inspect closed process sources before a nonempty search is requested', () => {
    const index = new HistorySearchIndex();
    let reads = 0;
    const process = thinking('lazy', 'needle');
    Object.defineProperty(process, 'text', { get() { reads += 1; return 'needle'; } });
    const rows = [row({ kind: 'live-process', key: 'lazy-row', item: process })];

    expect(index.find(rows, '', false)).toEqual([]);
    expect(index.find(rows, '   ', false)).toEqual([]);
    expect(reads).toBe(0);
    expect(index.find(rows, 'needle', false)).toHaveLength(1);
    expect(reads).toBe(1);
    expect(index.find(rows, '', false)).toEqual([]);
    const next = [message('next', 'different needle')];
    expect(index.find(next, '', false)).toEqual([]);
    expect(index.find(next, 'different', false)).toHaveLength(1);
  });
});
