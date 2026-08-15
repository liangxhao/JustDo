import type { TemplateResult } from 'lit';
import { describe, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

vi.mock('./markdown', () => ({
  toSanitizedMarkdownHtml: (text: string) => `<p>${text}</p>`,
  toStreamingMarkdownHtml: (text: string) => text,
}));

import { latestPlanUpdateKey, type ProcessSummaryTimelineItem } from '../model/project-turn-items';
import { renderTimelineItem } from './active-turn-timeline';

function flatten(value: unknown): string {
  if (value == null || value === false) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(flatten).join('');
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

function summary(): ProcessSummaryTimelineItem {
  return {
    kind: 'process-summary',
    key: 'process:run-1:0:thinking-1',
    runId: 'run-1',
    thinkingCount: 1,
    toolCount: 1,
    errorCount: 0,
    interruptedCount: 0,
    items: [
      {
        id: 'thinking-1',
        runId: 'run-1',
        firstSeq: 1,
        lastSeq: 1,
        startedAt: 1,
        updatedAt: 1,
        type: 'thinking',
        status: 'completed',
        text: 'private reasoning',
      },
      {
        id: 'tool-1',
        runId: 'run-1',
        firstSeq: 2,
        lastSeq: 3,
        startedAt: 2,
        updatedAt: 3,
        type: 'tool',
        status: 'completed',
        toolCallId: 'call-1',
        name: 'request',
        input: { apiKey: 'secret-value', query: 'safe' },
        output: 'result',
      },
    ],
  };
}

describe('active turn timeline', () => {
  test('renders the assistant avatar and animated indicator while waiting for the first event', () => {
    const rendered = flatten(
      renderTimelineItem({
        kind: 'waiting',
        key: 'waiting:run-1',
      }),
    );

    expect(rendered).toContain('chat-avatar assistant');
    expect(rendered).toContain('chat-reading-indicator');
    expect(rendered).not.toContain('active-turn__footer');
  });

  test('renders a temporary waiting status as polite auxiliary text', () => {
    const rendered = flatten(
      renderTimelineItem({
        kind: 'waiting-status',
        key: 'waiting-status:run-1:slow-active',
        status: { kind: 'slow-active', tone: 'neutral', quietMs: 60_000 },
      }),
    );

    expect(rendered).toContain('waiting-status--neutral');
    expect(rendered).toContain('role="status"');
    expect(rendered).toContain('aria-live="polite"');
    expect(rendered).toContain(i18nService.t('coworkWaitingSlowActive'));
    expect(rendered).not.toContain('chat-avatar assistant');
  });

  test('renders running Thinking as an independently streaming block', () => {
    const rendered = flatten(
      renderTimelineItem({
        kind: 'live-process',
        key: 'thinking-live',
        item: {
          id: 'thinking-live',
          runId: 'run-1',
          firstSeq: 1,
          lastSeq: 2,
          startedAt: 1,
          updatedAt: 2,
          type: 'thinking',
          status: 'running',
          text: 'streamed reasoning',
        },
      }),
    );

    expect(rendered).toContain('chat-group--streaming-thinking');
    expect(rendered).toContain('streamed reasoning');
    expect(rendered).not.toContain('data-process-summary-key');
  });

  test('renders a running Tool independently from the archived summary', () => {
    const rendered = flatten(
      renderTimelineItem({
        kind: 'live-process',
        key: 'tool-live',
        item: {
          id: 'tool-live',
          runId: 'run-1',
          firstSeq: 1,
          lastSeq: 1,
          startedAt: 1,
          updatedAt: 1,
          type: 'tool',
          status: 'running',
          toolCallId: 'call-live',
          name: 'exec',
          input: { command: 'npm test' },
        },
      }),
    );

    expect(rendered).toContain('data-live-process-id');
    expect(rendered).toContain('process-summary__tool-status--running');
    expect(rendered).toContain('npm test');
    expect(rendered).not.toContain('process-live__status');
    expect(rendered).not.toContain('<div class="process-summary__detail-label">Result</div>');
    expect(rendered).not.toContain('data-process-summary-key');
  });

  test('renders update_plan as an always-visible ordered plan card', () => {
    const plan = {
      kind: 'plan-update' as const,
      key: 'plan:tool-plan',
      item: {
        id: 'tool-plan',
        runId: 'run-1',
        firstSeq: 1,
        lastSeq: 1,
        startedAt: 1,
        updatedAt: 1,
        type: 'tool' as const,
        status: 'running' as const,
        toolCallId: 'call-plan',
        name: 'update_plan',
        input: {
          explanation: 'Starting the implementation',
          plan: [
            { step: 'Inspect existing code', status: 'completed' },
            { step: 'Build the timeline card', status: 'in_progress' },
            { step: 'Run validation', status: 'pending' },
          ],
        },
      },
    };
    const rendered = flatten(renderTimelineItem(plan));
    const liveRendered = flatten(renderTimelineItem(plan, Date.now(), false, true, true));
    const latestPlan = {
      ...plan,
      key: 'plan:tool-plan-latest',
      item: { ...plan.item, id: 'tool-plan-latest' },
    };

    expect(rendered).toContain('data-plan-update-id');
    expect(rendered).toContain('chat-group--plan-update');
    expect(rendered).toContain('更新计划');
    expect(rendered).toContain('已完成 1/3');
    expect(rendered.indexOf('<strong>更新计划</strong>')).toBeLessThan(
      rendered.indexOf('已完成 1/3'),
    );
    expect(rendered).toContain('Starting the implementation');
    expect(rendered.indexOf('Inspect existing code')).toBeLessThan(
      rendered.indexOf('Build the timeline card'),
    );
    expect(rendered).toContain('execution-plan-update__step--completed');
    expect(rendered).toContain('execution-plan-update__step--in_progress');
    expect(rendered).toContain('execution-plan-update__step--pending');
    expect(rendered.match(/aria-label=已完成/g)).toHaveLength(1);
    expect(rendered.match(/aria-label=进行中/g)).toHaveLength(1);
    expect(rendered.match(/aria-label=待处理/g)).toHaveLength(1);
    expect(rendered).not.toContain('<details');
    expect(rendered).not.toContain('execution-plan-update--live');
    expect(liveRendered).toContain('execution-plan-update--live');
    expect(latestPlanUpdateKey([plan, latestPlan])).toBe(latestPlan.key);
  });

  test('does not put archived details or Tool input into the main timeline DOM', () => {
    const rendered = flatten(renderTimelineItem(summary()));

    expect(rendered).toContain('data-process-summary-key');
    expect(rendered).not.toContain('private reasoning');
    expect(rendered).not.toContain('secret-value');
  });

  test.each([
    [0, 2, 'Tool × 2', 'Thinking ×'],
    [3, 0, 'Thinking × 3', 'Tool ×'],
  ] as const)(
    'omits zero-count process types from the summary',
    (thinkingCount, toolCount, visibleLabel, omittedPrefix) => {
      const fixture = summary();
      fixture.thinkingCount = thinkingCount;
      fixture.toolCount = toolCount;

      const rendered = flatten(renderTimelineItem(fixture));

      expect(rendered).toContain(visibleLabel);
      expect(rendered).not.toContain(omittedPrefix);
    },
  );

  test('removes the OpenClaw log hint from streaming active Content', () => {
    const rendered = flatten(
      renderTimelineItem({
        kind: 'content',
        key: 'content:redacted',
        item: {
          id: 'content:redacted',
          runId: 'run-1',
          firstSeq: 1,
          lastSeq: 1,
          startedAt: 1,
          updatedAt: 1,
          type: 'content',
          status: 'streaming',
          text: 'Task failed\nLogs: openclaw logs --follow',
          sourceMode: 'delta',
        },
      }),
    );

    expect(rendered).toContain('Task failed');
    expect(rendered).not.toContain('openclaw logs --follow');
  });

  test.each(['Logs:', 'Logs: openclaw', 'Logs: openclaw logs'])(
    'hides the incomplete OpenClaw log hint while it is streaming: %s',
    text => {
      const rendered = flatten(
        renderTimelineItem({
          kind: 'content',
          key: `content:partial:${text}`,
          item: {
            id: `content:partial:${text}`,
            runId: 'run-1',
            firstSeq: 1,
            lastSeq: 1,
            startedAt: 1,
            updatedAt: 1,
            type: 'content',
            status: 'streaming',
            text,
            sourceMode: 'delta',
          },
        }),
      );

      expect(rendered).not.toContain(text);
      expect(rendered.toLowerCase()).not.toContain('openclaw');
    },
  );

  test('keeps an ordinary Logs heading in completed active Content', () => {
    const rendered = flatten(
      renderTimelineItem({
        kind: 'content',
        key: 'content:completed-logs',
        item: {
          id: 'content:completed-logs',
          runId: 'run-1',
          firstSeq: 1,
          lastSeq: 1,
          startedAt: 1,
          updatedAt: 1,
          type: 'content',
          status: 'completed',
          text: 'Logs:\nApplication started',
          sourceMode: 'delta',
        },
      }),
    );

    expect(rendered).toContain('Logs:');
    expect(rendered).toContain('Application started');
  });

  test('expands archived Thinking and Tool inline in chronological order', () => {
    const rendered = flatten(renderTimelineItem(summary(), 100, true));

    expect(rendered.indexOf('private reasoning')).toBeLessThan(rendered.indexOf('Request'));
    expect(rendered).toContain(
      'process-summary__thinking-marker process-summary__thinking-marker--completed',
    );
    expect(rendered.indexOf('process-summary__thinking-marker')).toBeLessThan(
      rendered.indexOf('<strong>Thinking</strong>'),
    );
    expect(rendered).toContain('class="process-summary__thinking markdown-content"');
    expect(rendered).toContain('<p>private reasoning</p>');
    expect(rendered).toContain('secret-value');
    expect(rendered).toContain('result');
    expect(rendered).not.toContain('process-summary__item-index');
    expect(rendered).not.toContain('1.0s');
    expect(rendered).not.toContain('process-drawer');
  });

  test('keeps archived details out of the DOM while the summary is collapsed', () => {
    const rendered = flatten(renderTimelineItem(summary(), 100, false));

    expect(rendered).not.toContain('private reasoning');
    expect(rendered).not.toContain('secret-value');
    expect(rendered).not.toContain('result');
  });

  test('uses the process summary as the outer disclosure and each Tool as a detail disclosure', () => {
    const collapsed = flatten(renderTimelineItem(summary(), 100, false));
    const expanded = flatten(renderTimelineItem(summary(), 100, true));

    expect(collapsed).toContain('class="process-summary"');
    expect(collapsed).toContain('aria-expanded=');
    expect(collapsed).not.toContain('<details');
    expect(collapsed).not.toContain('<summary');
    expect(expanded).toContain('<details class="process-summary__tool">');
    expect(expanded).toContain('<summary class="process-summary__tool-title">');
    expect(expanded).toContain('Request');
    expect(expanded).toContain('apiKey');
  });

  test('labels an expanded summary with the collapse action', () => {
    const rendered = flatten(renderTimelineItem(summary(), 100, true));

    expect(rendered).toContain(i18nService.t('coworkProcessCloseDetails'));
    expect(rendered).not.toContain(i18nService.t('coworkProcessOpenDetails'));
  });

  test('shows the assistant avatar only when requested by the turn-level renderer', () => {
    const first = flatten(renderTimelineItem(summary(), 100, false, true));
    const continuation = flatten(renderTimelineItem(summary(), 100, false, false));

    expect(first).toContain('chat-avatar assistant');
    expect(first).not.toContain('chat-group--continuation');
    expect(continuation).not.toContain('chat-avatar assistant');
    expect(continuation).toContain('chat-group--continuation');
  });

  test.each(['running', 'completed', 'failed', 'cancelled', 'interrupted'] as const)(
    'shows a %s status dot before the Tool title',
    status => {
      const fixture = summary();
      const tool = fixture.items[1];
      if (tool.type !== 'tool') throw new Error('Expected Tool fixture');
      fixture.items[1] = { ...tool, status };
      const rendered = flatten(renderTimelineItem(fixture, 100, true));

      expect(rendered).toContain(`process-summary__tool-status--${status}`);
      expect(rendered.indexOf('process-summary__tool-status')).toBeLessThan(
        rendered.indexOf('<strong>Request</strong>'),
      );
      expect(rendered).not.toContain('data-process-details-id');
      expect(rendered).not.toContain('data-dismiss-process-id');
    },
  );

  test.each([
    ['streaming', true],
    ['completed', false],
  ] as const)(
    'renders %s active Content with the persisted assistant bubble structure',
    (status, streaming) => {
      const rendered = flatten(
        renderTimelineItem({
          kind: 'content',
          key: `content:${status}`,
          item: {
            id: `content:${status}`,
            runId: 'run-1',
            firstSeq: 1,
            lastSeq: 1,
            startedAt: 1,
            updatedAt: 1,
            type: 'content',
            status,
            text: 'visible answer',
            sourceMode: 'delta',
          },
        }),
      );

      expect(rendered).toContain('chat-group--assistant');
      expect(rendered).toContain('chat-bubble--assistant');
      expect(rendered).toContain('visible answer');
      expect(rendered).not.toContain('timeline-content');
      expect(rendered.includes('chat-group--streaming')).toBe(streaming);
    },
  );
});
