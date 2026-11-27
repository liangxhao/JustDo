// @vitest-environment jsdom
import '../justdo-chat';

import { render, type TemplateResult } from 'lit';
import { describe, expect, test } from 'vitest';

import { i18nService } from '@/services/i18n';

import { createChatTranscriptState } from '../../model/chat-transcript-state';
import { projectPersistedTimeline } from '../../model/timeline/project-history-timeline';
import {
  type LiveProcessTimelineItem,
  type ProcessSummaryTimelineItem,
  projectTurnItems,
} from '../../model/timeline/project-turn-items';
import { reduceAgentEvent } from '../../model/turn/agent-event-reducer';
import type { JustDoChatElement } from '../justdo-chat';
import { TOOL_OUTPUT_REQUEST,type ToolOutput } from '../tools/tool-output';
import { renderTimelineItem } from './active-turn-timeline';

function flatten(value: unknown): string {
  if (value == null || value === false) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(flatten).join('');
  if (typeof value === 'object' && '_$litDirective$' in value && 'values' in value) {
    const args = (value as { values: unknown[] }).values;
    if (Array.isArray(args[0]) && typeof args[2] === 'function')
      return args[0]
        .map(args[2] as (item: unknown) => unknown)
        .map(flatten)
        .join('');
    if (typeof args[0] === 'string' && typeof args[1] === 'function') return flatten(args[1]());
  }
  if (typeof value === 'object' && 'strings' in value && 'values' in value) {
    const template = value as TemplateResult;
    return template.strings.reduce(
      (result, string, index) => `${result}${string}${flatten(template.values[index])}`,
      '',
    );
  }
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>)
      .map(flatten)
      .join('');
  }
  return '';
}

function incrementalToolRow(
  failed = false,
  input: Record<string, unknown> = { command: 'npm test' },
  name = 'exec',
): LiveProcessTimelineItem {
  const state = createChatTranscriptState('justdo:session-1', 'session-1');
  let id = 0;
  const dependencies = {
    now: () => 3,
    createId: (prefix: string) => `${prefix}-${++id}`,
  };
  const base = {
    runId: 'run-1',
    sessionKey: 'justdo:session-1',
    sessionId: 'session-1',
    lifecycleGeneration: null,
    agentId: null,
    spawnedBy: null,
    frameSeq: null,
    deliveryEvent: 'agent' as const,
    stream: 'tool',
  };
  reduceAgentEvent(
    state,
    {
      ...base,
      agentSeq: 1,
      timestamp: 1,
      data: {
        phase: 'start',
        toolCallId: 'call-1',
        name,
        args: input,
      },
    },
    dependencies,
  );
  reduceAgentEvent(
    state,
    {
      ...base,
      agentSeq: 2,
      timestamp: 2,
      data: {
        phase: 'result',
        toolCallId: 'call-1',
        name,
        result: failed ? 'Process exited with code 1' : '761 tests passed',
        isError: failed,
      },
    },
    dependencies,
  );

  const item = projectTurnItems(state.activeTurn)[0];
  if (item?.kind !== 'live-process' || item.item.type !== 'tool')
    throw new Error('Expected an incremental Tool row');
  return item;
}

function refreshedSummary(
  failed = false,
  input: Record<string, unknown> = { command: 'npm test' },
  name = 'exec',
): ProcessSummaryTimelineItem {
  const item = projectPersistedTimeline([
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'call-1',
          name,
          arguments: input,
        },
      ],
    },
    {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: name,
      content: [{ type: 'text', text: failed ? 'Process exited with code 1' : '761 tests passed' }],
      isError: failed,
    },
  ])[0];
  if (item?.kind !== 'process-summary') throw new Error('Expected refreshed Tool summary');
  return item;
}

describe('Tool timeline consistency', () => {
  test('keeps native nested Tool rows adjacent and indented through incremental updates and reload', async () => {
    const state = createChatTranscriptState('nested-session');
    const runId = 'nested-run';
    const rootId = 'wrapper';
    const childId = 'exec-nested';
    const otherId = 'read-other';
    const childArgs = { command: 'echo nested' };
    const dependencies = { now: () => 10, createId: (prefix: string) => `${prefix}-${seq}` };
    let seq = 0;
    const send = (data: Record<string, unknown>) => {
      seq += 1;
      reduceAgentEvent(state, {
        runId, sessionKey: 'nested-session', sessionId: null, lifecycleGeneration: null,
        agentId: null, spawnedBy: null, frameSeq: null, deliveryEvent: 'agent',
        stream: 'tool', agentSeq: seq, timestamp: seq, data,
      }, dependencies);
      chat.activeTurn = state.activeTurn && { ...state.activeTurn };
    };

    const chat = document.createElement('justdo-chat') as JustDoChatElement;
    document.body.append(chat);
    const visibleToolRows = () => Array.from(chat.shadowRoot!.querySelectorAll<HTMLElement>(
      '.process-live--tool, .process-summary__item--tool',
    )).map(row => ({
      title: row.querySelector('.process-summary__tool-title strong')?.textContent?.trim(),
      indent: row.style.getPropertyValue('--tool-nesting-indent'),
    }));
    const commit = async () => {
      await chat.updateComplete;
      await chat.historyRenderComplete;
    };
    const expected = [
      { title: 'Tool Call', indent: '' },
      { title: 'Exec', indent: '16px' },
      { title: 'Read', indent: '' },
    ];
    try {
      send({ phase: 'start', toolCallId: rootId, name: 'tool_call', args: { name: 'exec' } });
      send({ phase: 'start', toolCallId: otherId, name: 'read', args: { path: 'notes.txt' } });
      await commit();
      expect(visibleToolRows()).toEqual([expected[0], expected[2]]);

      send({ phase: 'start', toolCallId: childId, name: 'exec', parentToolCallId: rootId, args: childArgs });
      await commit();
      expect(visibleToolRows()).toEqual(expected);
      send({ phase: 'result', toolCallId: childId, name: 'exec', result: 'nested' });
      await commit();
      expect(visibleToolRows()).toEqual(expected);

      chat.activeTurn = null;
      chat.processSummariesExpanded = true;
      chat.messages = [
        { role: 'assistant', runId, content: [
          { type: 'toolCall', id: rootId, name: 'tool_call', arguments: { name: 'exec' } },
          { type: 'toolCall', id: otherId, name: 'read', arguments: { path: 'notes.txt' } },
        ] },
        { role: 'custom', runId, customType: 'openclaw.nested-tool.v1', display: true, content: [
          { type: 'toolCall', runId, id: childId, name: 'exec', parentToolCallId: rootId, arguments: childArgs },
          { type: 'toolResult', runId, toolCallId: childId, toolName: 'exec', parentToolCallId: rootId, content: 'nested' },
        ] },
        { role: 'toolResult', runId, toolCallId: rootId, toolName: 'tool_call', content: 'Returned.' },
        { role: 'toolResult', runId, toolCallId: otherId, toolName: 'read', content: 'Notes.' },
      ];
      await commit();
      expect(visibleToolRows()).toEqual(expected);
    } finally {
      chat.remove();
    }
  });

  test('displays an Exec input title in incremental and refreshed rows', () => {
    const input = { command: 'npm test', title: '  Run\n focused tests  ' };

    for (const row of [incrementalToolRow(false, input), refreshedSummary(false, input)]) {
      const view = document.createElement('div');
      render(renderTimelineItem(row, 3, true), view);

      const heading = view.querySelector('.process-summary__tool-title');
      expect(heading?.querySelector('strong')?.textContent?.trim()).toBe('Exec');
      expect(heading?.querySelector('.process-summary__tool-input')?.textContent).toBe(
        'Run focused tests',
      );
      const terminal = view.querySelector<ToolOutput>('[data-tool-search-source="exec-result"]');
      expect(terminal?.terminalCommand).toBe(input.command);
      expect(terminal?.text).toBe('761 tests passed');
      expect(terminal?.paginate).toBe(false);
    }
  });

  test('defers Read output while the live Tool row waits for Content', async () => {
    const row = incrementalToolRow(false, { path: 'report.txt' }, 'read');
    const view = document.createElement('div');
    document.body.append(view);
    try {
      render(renderTimelineItem(row, 3), view);
      const details = view.querySelector<HTMLDetailsElement>('details[data-tool-identity]')!;
      expect(details.open).toBe(false);
      expect(details.querySelector('justdo-tool-output')).toBeNull();

      details.querySelector('summary')!.click();
      const readers = details.querySelectorAll<ToolOutput>('justdo-tool-output');
      const result = readers[readers.length - 1];
      await result.updateComplete;
      expect(details.open).toBe(true);
      expect(result.querySelector('pre')?.textContent).toBe('761 tests passed');
    } finally {
      view.remove();
    }
  });

  test.each([false, true])(
    'renders Code Mode source and titles consistently after refresh (failed=%s)',
    failed => {
      const input = {
        code: 'const values = [1, 2];\nreturn values.map(n => n * 2);',
        title: 'Summarize results',
      };
      for (const row of [incrementalToolRow(failed, input), refreshedSummary(failed, input)]) {
        const markup = flatten(renderTimelineItem(row, 3, true));
        expect(markup).toContain('.terminalCommandLanguage=javascript');
        expect(markup).toContain(input.code);
        expect(markup).toContain('Summarize results');
        expect(markup).toContain(
          `process-summary__tool-status--${failed ? 'failed' : 'completed'}`,
        );
        expect(markup).not.toContain('"code":');
      }
    },
  );

  test.each([
    {
      name: 'edit',
      input: { path: 'example.ts', edits: [{ oldText: 'before', newText: 'after' }] },
      previewSelector: '.edit-diff',
    },
    {
      name: 'write',
      input: { path: 'vite.config.mts', content: 'export const ready = true;\n' },
      previewSelector: '[data-tool-search-source="write"]',
      style: { editor: true, language: 'typescript' },
    },
    {
      name: 'write',
      input: { path: 'README.md', content: '# Notes\n' },
      previewSelector: '[data-tool-search-source="write"]',
      style: { editor: false, language: 'markdown' },
    },
    {
      name: 'tool_call',
      input: { id: 'openclaw:core:exec', args: { command: 'npm test\n  npm run lint', timeout: 120 } },
      previewSelector: '[data-tool-search-source="exec-result"]',
    },
  ])(
    'renders the $name preview beside collapsed raw details in live and archived rows',
    ({ name, input, previewSelector, style }) => {
      const items = [
        incrementalToolRow(false, input, name),
        refreshedSummary(false, input, name),
      ];

      for (const item of items) {
        const view = document.createElement('div');
        render(renderTimelineItem(item, 3, true), view);
        const details = view.querySelector<HTMLDetailsElement>('details[data-tool-identity]')!;
        const preview = details.nextElementSibling!.querySelector(previewSelector);
        expect(preview).not.toBeNull();
        if (style) {
          const output = preview as ToolOutput;
          expect(output.editorStyle).toBe(style.editor);
          expect(output.language).toBe(style.language);
        }
        expect(details.open).toBe(false);
        expect(details.querySelector('justdo-tool-output')).toBeNull();

        details.querySelector('summary')!.click();

        expect(details.open).toBe(true);
        expect(details.nextElementSibling!.querySelector(previewSelector)).toBe(preview);
        const rawInput = details.querySelector<ToolOutput>('[data-tool-search-source="raw-input"]')!;
        const rawResult = details.querySelector<ToolOutput>('[data-tool-search-source="raw-result"]')!;
        expect(JSON.parse(rawInput.text)).toEqual(input);
        expect(rawResult.text).toBe('761 tests passed');
        expect(rawResult.terminal).toBe(false);
      }
    },
  );

  test('shows typed progress only while a tool is running', () => {
    const row = incrementalToolRow();
    const tool = row.item;
    if (tool.type !== 'tool') throw new Error('Expected tool');
    tool.status = 'running';
    tool.progressText = 'Reading 50%';
    const view = document.createElement('div');
    render(renderTimelineItem(row, 3, true), view);
    expect(view.querySelector<ToolOutput>('[data-tool-search-source="exec-result"]')?.text).toBe('Reading 50%');
    view.querySelector<HTMLElement>('details[data-tool-identity] > summary')!.click();
    expect(view.querySelector<ToolOutput>('[data-tool-search-source="raw-result"]')?.text).toBe('761 tests passed');
    tool.status = 'completed';
    const completed = flatten(renderTimelineItem(row, 3, true));
    expect(completed).not.toContain('Reading 50%');
    expect(completed).toContain('761 tests passed');
  });

  test.each([false, true])('shares an Exec result recovered with raw details open=%s', async rawOpen => {
    const summary = refreshedSummary();
    const tool = summary.items[0];
    if (tool.type !== 'tool') throw new Error('Expected tool');
    tool.output = 'truncated';
    tool.presentation = { partial: true, resultMessageId: 'native-result-1' };
    const view = document.createElement('div');
    document.body.append(view);
    try {
      const fullOutput = '\u001b[32mcomplete output\u001b[0m\n';
      let requests = 0;
      view.addEventListener(TOOL_OUTPUT_REQUEST, event => {
        requests += 1;
        (event as CustomEvent<{ complete(text: string): void }>).detail.complete(fullOutput);
      });
      render(renderTimelineItem(summary, 3, true), view);
      const terminal = view.querySelector<ToolOutput>('[data-tool-search-source="exec-result"]')!;
      const trigger = view.querySelector<HTMLElement>('details[data-tool-identity] > summary')!;
      const getRawResult = () => view.querySelector<ToolOutput>('[data-tool-search-source="raw-result"]');
      if (rawOpen) trigger.click();
      else expect(getRawResult()).toBeNull();
      await terminal.updateComplete;
      const recover = Array.from(terminal.querySelectorAll<HTMLButtonElement>('button')).find(
        button => button.textContent?.trim() === i18nService.t('messageFullOutput'),
      )!;
      recover.click();
      await terminal.updateComplete;
      if (!rawOpen) trigger.click();
      const raw = getRawResult()!;
      await raw.updateComplete;
      expect(requests).toBe(1);
      expect(raw.querySelector('pre')?.textContent).toBe(fullOutput);
      expect(raw.querySelector('.message-reader-actions')).toBeNull();
      expect(terminal.querySelector('.tool-output-terminal')?.textContent).toBe('complete output\n');
    } finally {
      view.remove();
    }
  });

  test.each([
    ['completed', false, '761 tests passed'],
    ['failed', true, 'Process exited with code 1'],
  ] as const)(
    'renders incremental and fully refreshed %s Tools with the same status and detail structure',
    (status, failed, output) => {
      const incremental = flatten(renderTimelineItem(incrementalToolRow(failed), 3, true));
      const refreshed = flatten(renderTimelineItem(refreshedSummary(failed), 3, true));

      expect(incremental).toContain('process-live--tool');
      expect(refreshed).toContain('process-summary__item--tool');
      for (const rendered of [incremental, refreshed]) {
        expect(rendered).toMatch(/<details[^>]*class=process-summary__tool(?: process-live__tool)?\s*>/u);
        expect(rendered).toContain('process-summary__tool-title');
        expect(rendered).toContain(`process-summary__tool-status--${status}`);
        expect(rendered).toContain('process-tool-preview');
        expect(rendered).toContain('Exec');
        expect(rendered).toContain('npm test');
        expect(rendered).toContain(output);
        expect(rendered).not.toContain('process-row--tool');
      }
    },
  );
});
