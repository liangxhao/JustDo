import { describe, expect, it } from 'vitest';

import {
  type BrowserExtensionAtomicEntry,
  type BrowserExtensionProcessItem,
  foldBrowserExtensionEntries,
} from './browser-extension-timeline';

const message = (
  key: string,
  role: 'user' | 'assistant' | 'system' = 'assistant',
): BrowserExtensionAtomicEntry => ({ role, key, text: key });

const tool = (status = 'completed'): BrowserExtensionProcessItem => ({
  type: 'tool',
  key: `tool-${status}`,
  id: 'native-tool-1',
  title: 'Read',
  name: 'read',
  status,
  input: '{"path":"notes.txt"}',
  output: 'Native output',
});

const summary = (
  key: string,
  item: BrowserExtensionProcessItem = tool(),
): BrowserExtensionAtomicEntry => ({
  role: 'process',
  key,
  title: 'Tool × 1',
  running: false,
  items: [item],
  thinkingCount: 0,
  toolCount: 1,
  errorCount: item.status === 'failed' ? 1 : 0,
  interruptedCount: 0,
});

describe('browser extension desktop process folding adapter', () => {
  it('folds completed process and intermediate content together, preserving the full final block', () => {
    const entries = [
      message('question', 'user'),
      summary('first'),
      message('commentary'),
      summary('second', { ...tool('failed'), isError: true }),
      message('Final\n\nSecond paragraph'),
    ];
    const before = structuredClone(entries);

    const result = foldBrowserExtensionEntries(entries);

    expect(result.map(entry => entry.role)).toEqual(['user', 'completed-process', 'assistant']);
    expect(result[0]).toBe(entries[0]);
    expect(result[2]).toBe(entries[4]);
    expect(result[1]).toMatchObject({
      key: 'completed-process:first',
      items: entries.slice(1, -1),
    });
    if (result[1].role !== 'completed-process') throw new Error('Missing outer process');
    result[1].items.forEach((entry, index) => expect(entry).toBe(entries[index + 1]));
    expect(entries).toEqual(before);
  });

  it('retains native failures, interrupted body text and rich deliveries as visible boundaries', () => {
    const failures: BrowserExtensionAtomicEntry[] = [
      { ...message('failure'), display: { nativeFailure: true } } as BrowserExtensionAtomicEntry,
      { ...message('aborted'), display: { stopReason: 'aborted' } } as BrowserExtensionAtomicEntry,
      {
        role: 'assistant',
        key: 'image',
        text: '',
        rawMessage: {
          role: 'assistant',
          content: [{ type: 'image', data: 'AA==', mimeType: 'image/png' }],
        },
      },
      {
        role: 'assistant',
        key: 'media',
        text: 'File ready',
        rawMessage: {
          role: 'assistant',
          content: 'File ready',
          __openclaw: { media: [{ path: '/file.png' }] },
        },
      },
      { role: 'assistant', key: 'partial', text: 'An interrupted segment', status: 'interrupted' },
    ];
    const entries = [summary('first'), ...failures, summary('last'), message('final')];

    const result = foldBrowserExtensionEntries(entries);

    for (const entry of failures) expect(result).toContain(entry);
    expect(result[result.length - 1]).toBe(entries[entries.length - 1]);
  });

  it('does not split or fold an active tail when unsupported content is kept visible', () => {
    const entries: BrowserExtensionAtomicEntry[] = [
      summary('before'),
      message('commentary'),
      {
        role: 'assistant',
        key: 'interactive',
        text: 'Interactive fallback',
        display: { keepVisible: true },
      },
      summary('after'),
      message('final'),
    ];

    const active = foldBrowserExtensionEntries(entries, { protectTrailingTurn: true });
    const historical = foldBrowserExtensionEntries(entries);

    expect(active).toEqual(entries);
    expect(historical.map(entry => entry.role)).toEqual([
      'completed-process',
      'assistant',
      'completed-process',
      'assistant',
    ]);
    expect(historical[1]).toBe(entries[2]);
  });

  it('protects the current user suffix across system fallbacks while older turns still fold', () => {
    const current = [
      message('new question', 'user'),
      summary('active process'),
      message('intermediate'),
      {
        role: 'system',
        key: 'unsupported',
        text: 'Desktop content',
        display: { keepVisible: true },
      } as BrowserExtensionAtomicEntry,
      message('provider note', 'system'),
      summary('later process'),
      message('latest body'),
    ];
    const result = foldBrowserExtensionEntries(
      [message('old question', 'user'), summary('old process'), message('old final'), ...current],
      { protectTrailingTurn: true },
    );

    expect(result.slice(0, 3).map(entry => entry.role)).toEqual([
      'user',
      'completed-process',
      'assistant',
    ]);
    expect(result.slice(3)).toEqual(current);
    current.forEach((entry, index) => expect(result[index + 3]).toBe(entry));
  });

  it('does not move active protection past a native pending user input', () => {
    const entries: BrowserExtensionAtomicEntry[] = [
      message('current question', 'user'),
      summary('process'),
      message('intermediate'),
      { role: 'user', key: 'queued', text: 'Queued input', pendingInput: { state: 'queued' } },
      summary('later process'),
      message('latest body'),
    ];
    expect(foldBrowserExtensionEntries(entries, { protectTrailingTurn: true })).toEqual(entries);
  });

  it.each(['running', 'inProgress', 'unknown', undefined])(
    'keeps a Tool with incomplete result state %s directly accessible',
    status => {
      const pending = summary('pending', { ...tool(), status });
      const result = foldBrowserExtensionEntries([summary('before'), pending, message('final')]);
      expect(result).toContain(pending);
      expect(pending).toMatchObject({ items: [{ status }] });
    },
  );

  it('folds settled progress receipts without replacing their structured input or native identity', () => {
    const progress: BrowserExtensionAtomicEntry = {
      role: 'progress-receipt',
      key: 'progress',
      item: {
        ...tool(),
        name: 'progress_card',
        input: { plan: [{ step: 'Check', status: 'completed' }] },
      },
    };
    const pending: BrowserExtensionAtomicEntry = {
      ...progress,
      key: 'updating',
      item: { ...progress.item, status: 'inProgress' },
    };
    const result = foldBrowserExtensionEntries([
      progress,
      pending,
      summary('after'),
      message('final'),
    ]);

    expect(result[0]).toMatchObject({ role: 'completed-process', items: [progress] });
    if (result[0].role !== 'completed-process') throw new Error('Missing progress group');
    expect(result[0].items[0]).toBe(progress);
    expect(result[1]).toBe(pending);
  });

  it.each(['completed', 'failed', 'aborted', 'skipped', 'in-progress', 'unknown', undefined])(
    'uses the shared compaction marker rules for phase %s',
    phase => {
      const compaction: BrowserExtensionAtomicEntry = {
        role: 'compaction',
        key: 'compaction',
        rawMessage: {
          role: 'system',
          content: '',
          __openclaw: { kind: 'compaction-status', phase },
        },
      };
      const result = foldBrowserExtensionEntries([
        summary('before'),
        compaction,
        summary('after'),
        message('final'),
      ]);
      if (['completed', 'failed', 'aborted', 'skipped'].includes(phase ?? '')) {
        expect(result.map(entry => entry.role)).toEqual(['completed-process', 'assistant']);
        expect(result[0]).toMatchObject({ items: expect.arrayContaining([compaction]) });
      } else expect(result).toContain(compaction);
    },
  );

  it('does not fold process-only tails, records after final content, or cross user/phase boundaries', () => {
    const boundary: BrowserExtensionAtomicEntry = {
      role: 'phase-boundary',
      key: 'phase',
      text: '',
    };
    const entries = [
      summary('first'),
      message('first final'),
      boundary,
      summary('unanswered'),
      message('next question', 'user'),
      summary('second'),
      message('second final'),
      summary('after final'),
    ];
    const result = foldBrowserExtensionEntries(entries);

    expect(result).toContain(boundary);
    expect(result).toContain(entries[3]);
    expect(result[result.length - 1]).toBe(entries[entries.length - 1]);
    expect(result.filter(entry => entry.role === 'completed-process')).toHaveLength(2);
  });
});
