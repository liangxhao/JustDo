import type { TemplateResult } from 'lit';
import { describe, expect, test } from 'vitest';

import { reduceAgentEvent } from '../model/agent-event-reducer';
import { createChatTranscriptState } from '../model/chat-transcript-state';
import { projectPersistedTimeline } from '../model/project-history-timeline';
import { type ProcessSummaryTimelineItem, projectTurnItems } from '../model/project-turn-items';
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

function incrementalSummary(failed = false): ProcessSummaryTimelineItem {
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
        name: 'exec',
        args: { command: 'npm test' },
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
        name: 'exec',
        result: failed ? 'Process exited with code 1' : '761 tests passed',
        isError: failed,
      },
    },
    dependencies,
  );

  const item = projectTurnItems(state.activeTurn)[0];
  if (item?.kind !== 'process-summary') throw new Error('Expected incremental Tool summary');
  return item;
}

function refreshedSummary(failed = false): ProcessSummaryTimelineItem {
  const item = projectPersistedTimeline([
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: 'call-1',
          name: 'exec',
          arguments: { command: 'npm test' },
        },
      ],
    },
    {
      role: 'toolResult',
      toolCallId: 'call-1',
      toolName: 'exec',
      content: [{ type: 'text', text: failed ? 'Process exited with code 1' : '761 tests passed' }],
      isError: failed,
    },
  ])[0];
  if (item?.kind !== 'process-summary') throw new Error('Expected refreshed Tool summary');
  return item;
}

describe('Tool timeline consistency', () => {
  test.each([
    ['completed', false, '761 tests passed'],
    ['failed', true, 'Process exited with code 1'],
  ] as const)(
    'renders incremental and fully refreshed %s Tools with the same status and detail structure',
    (status, failed, output) => {
      const incremental = flatten(renderTimelineItem(incrementalSummary(failed), 3, true));
      const refreshed = flatten(renderTimelineItem(refreshedSummary(failed), 3, true));

      for (const rendered of [incremental, refreshed]) {
        expect(rendered).toContain('process-summary__item--tool');
        expect(rendered).toMatch(/<details\s+class=["']?process-summary__tool["']?\s*>/u);
        expect(rendered).toContain('process-summary__tool-title');
        expect(rendered).toContain(`process-summary__tool-status--${status}`);
        expect(rendered).toContain('process-summary__tool-detail');
        expect(rendered).toContain('Bash');
        expect(rendered).toContain('npm test');
        expect(rendered).toContain(output);
        expect(rendered).not.toContain('process-row--tool');
      }
    },
  );
});
