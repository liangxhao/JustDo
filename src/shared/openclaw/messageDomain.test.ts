import { describe, expect, test } from 'vitest';

import {
  reduceAgentEvent,
  type TranscriptReduceResult,
} from '../../renderer/libs/openclaw-chat/model/agent-event-reducer';
import {
  beginAssistantTurn,
  createChatTranscriptState,
} from '../../renderer/libs/openclaw-chat/model/chat-transcript-state';
import { normalizeAgentEvent, type NormalizedAgentEvent } from './agentEvent';
import {
  classifyAgentEvent,
  type MessageDomainRun,
  normalizeToolEvent,
} from './messageDomain';

type SemanticTool = {
  toolCallId: string;
  name: string;
  input?: unknown;
  output: string | null;
  status: string;
};

function createMainSemanticAdapter() {
  const selected = { sessionKey: 'agent:main:justdo:session-1', sessionId: null };
  let activeRun: MessageDomainRun | null = {
    runId: 'justdo-local',
    sessionId: null,
    lifecycleGeneration: null,
    lastAgentSeq: -1,
    status: 'running',
  };
  const tools = new Map<string, SemanticTool>();
  const results: TranscriptReduceResult[] = [];

  return {
    apply(event: NormalizedAgentEvent) {
      const admission = classifyAgentEvent({ selected, activeRun, event });
      if (
        admission === 'ignored-session' ||
        admission === 'ignored-run' ||
        admission === 'ignored-terminal'
      ) {
        results.push('ignored-run');
        return;
      }
      if (admission === 'ignored-sequence') {
        results.push('ignored-sequence');
        return;
      }
      if (admission === 'start-run') {
        activeRun = {
          runId: event.runId,
          sessionId: event.sessionId,
          lifecycleGeneration: event.lifecycleGeneration,
          lastAgentSeq: -1,
          status: 'running',
        };
      } else if (admission === 'bind-provisional-run' && activeRun) {
        activeRun.runId = event.runId;
      }
      if (!activeRun) throw new Error('Expected an admitted run');
      activeRun.lastAgentSeq = event.agentSeq;
      const tool = normalizeToolEvent(event.data, tools.get(event.data.toolCallId as string)?.name);
      if (event.stream === 'tool' && tool.toolCallId) {
        const previous = tools.get(tool.toolCallId);
        tools.set(tool.toolCallId, {
          toolCallId: tool.toolCallId,
          name: tool.name,
          ...(tool.input !== undefined ? { input: tool.input } : previous?.input !== undefined
            ? { input: previous.input }
            : {}),
          output: tool.output ?? previous?.output ?? null,
          status:
            previous?.status !== 'running' && tool.status === 'running'
              ? previous?.status ?? tool.status
              : tool.status,
        });
      }
      results.push('applied');
    },
    snapshot: () => ({ results, tools: [...tools.values()] }),
  };
}

describe('shared OpenClaw message-domain corpus', () => {
  test('keeps Renderer timeline and Main persistence semantics in parity', () => {
    let now = 100;
    let nextId = 0;
    const renderer = createChatTranscriptState('justdo:session-1');
    const dependencies = {
      now: () => now++,
      createId: (prefix: string) => `${prefix}-${++nextId}`,
    };
    beginAssistantTurn(renderer, { runId: 'justdo-local' }, dependencies);
    const main = createMainSemanticAdapter();
    const corpus = [
      {
        deliveryEvent: 'agent' as const,
        payload: {
          runId: 'run-1',
          sessionKey: 'agent:main:justdo:session-1',
          seq: 1,
          stream: 'assistant',
          data: { text: 'working' },
        },
      },
      {
        deliveryEvent: 'agent' as const,
        payload: {
          runId: 'run-1',
          sessionKey: 'justdo:session-1',
          seq: 3,
          stream: 'tool',
          data: { phase: 'result', toolCallId: 'call-1', name: 'exec', result: 'ok' },
        },
      },
      {
        deliveryEvent: 'session.tool' as const,
        payload: {
          runId: 'run-1',
          sessionKey: 'agent:main:justdo:session-1',
          seq: 3,
          stream: 'tool',
          data: { phase: 'result', toolCallId: 'call-1', name: 'exec', result: 'ok' },
        },
      },
      {
        deliveryEvent: 'agent' as const,
        payload: {
          runId: 'run-1',
          sessionKey: 'justdo:session-1',
          seq: 4,
          stream: 'tool',
          data: {
            phase: 'start',
            tool_call_id: 'call-1',
            tool_name: 'exec',
            arguments: '{"command":"npm test"}',
          },
        },
      },
    ].map(entry => {
      const normalized = normalizeAgentEvent(entry);
      if (!normalized.event) throw new Error(`Invalid corpus event: ${normalized.reason}`);
      return normalized.event;
    });

    const rendererResults = corpus.map(event =>
      reduceAgentEvent(renderer, event, dependencies),
    );
    for (const event of corpus) main.apply(event);

    const rendererTools = (renderer.activeTurn?.items ?? [])
      .filter(item => item.type === 'tool')
      .map(item => ({
        toolCallId: item.toolCallId,
        name: item.name,
        input: item.input,
        output: item.output ?? null,
        status: item.status,
      }));

    expect(main.snapshot()).toEqual({
      results: rendererResults,
      tools: rendererTools,
    });
    expect(rendererResults).toEqual([
      'applied',
      'applied',
      'ignored-sequence',
      'applied',
    ]);
    expect(rendererTools[0]).toMatchObject({
      input: { command: 'npm test' },
      output: 'ok',
      status: 'completed',
    });
  });

  test('treats lifecycle generation as an optional discriminator, not an admission requirement', () => {
    const activeRun: MessageDomainRun = {
      runId: 'run-1',
      sessionId: 'session-id-1',
      lifecycleGeneration: 'life-1',
      lastAgentSeq: 1,
      status: 'running',
    };
    const event: NormalizedAgentEvent = {
      runId: 'run-1',
      sessionKey: 'agent:main:justdo:session-1',
      sessionId: 'session-id-1',
      lifecycleGeneration: null,
      agentId: 'main',
      spawnedBy: null,
      agentSeq: 2,
      frameSeq: 2,
      deliveryEvent: 'agent',
      stream: 'assistant',
      timestamp: 2,
      data: { text: 'continued without serialized generation' },
    };

    expect(
      classifyAgentEvent({
        selected: {
          sessionKey: 'agent:main:justdo:session-1',
          sessionId: 'session-id-1',
        },
        activeRun,
        event,
      }),
    ).toBe('admitted');
    expect(
      classifyAgentEvent({
        selected: {
          sessionKey: 'agent:main:justdo:session-1',
          sessionId: 'session-id-1',
        },
        activeRun,
        event: { ...event, lifecycleGeneration: 'life-2' },
      }),
    ).toBe('ignored-run');
  });

  test('starts a spawned subagent run when the event explicitly identifies the selected session', () => {
    const selected = {
      sessionKey: 'agent:researcher:subagent:child-1',
      sessionId: 'child-session-id',
    };
    const event: NormalizedAgentEvent = {
      runId: 'child-run-1',
      sessionKey: selected.sessionKey,
      sessionId: selected.sessionId,
      lifecycleGeneration: null,
      agentId: 'researcher',
      spawnedBy: 'agent:main:justdo:parent-1',
      agentSeq: 1,
      frameSeq: 1,
      deliveryEvent: 'agent',
      stream: 'thinking',
      timestamp: 1,
      data: { text: 'Inspecting the repository' },
    };

    expect(classifyAgentEvent({ selected, activeRun: null, event })).toBe('start-run');
  });

  test('keeps parent-delivered spawned events dormant without selected-session identity', () => {
    const selected = {
      sessionKey: 'agent:main:justdo:parent-1',
      sessionId: 'parent-session-id',
    };
    const event: NormalizedAgentEvent = {
      runId: 'child-run-1',
      sessionKey: null,
      sessionId: null,
      lifecycleGeneration: null,
      agentId: 'researcher',
      spawnedBy: selected.sessionKey,
      agentSeq: 1,
      frameSeq: 1,
      deliveryEvent: 'agent',
      stream: 'thinking',
      timestamp: 1,
      data: { text: 'Inspecting the repository' },
    };

    expect(classifyAgentEvent({ selected, activeRun: null, event })).toBe('ignored-run');
  });
});

describe('normalizeToolEvent terminal phases', () => {
  test.each([
    ['error', 'failed'],
    ['failed', 'failed'],
    ['cancel', 'cancelled'],
    ['cancelled', 'cancelled'],
    ['canceled', 'cancelled'],
    ['aborted', 'cancelled'],
    ['finish', 'completed'],
    ['finished', 'completed'],
    ['done', 'completed'],
  ] as const)('normalizes %s as %s', (phase, status) => {
    expect(normalizeToolEvent({ phase, toolCallId: 'tool-1' }).status).toBe(status);
  });
});
