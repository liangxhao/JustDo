import type { NormalizedAgentEvent } from '@shared/openclaw/agentEvent';
import { describe, expect, it } from 'vitest';

import { isNativeMcpAppPreview } from '../pipeline/native-mcp-app';
import { reduceAgentEvent } from './agent-event-reducer';
import { createChatTranscriptState } from './chat-transcript-state';
import { projectPersistedTimeline } from './project-history-timeline';
import { projectTurnItems } from './project-turn-items';

const descriptor = {
  viewId: 'mcp-app-history',
  serverName: 'demo',
  toolName: 'show',
  uiResourceUri: 'ui://demo/app',
  toolCallId: 'native-call',
};
// This is the public OpenClaw 2026.10.4 history projection: native preview
// identity stays in details; business content has no serialized agent result.
const projectedResult = {
  role: 'toolResult',
  toolName: 'demo__show',
  toolCallId: descriptor.toolCallId,
  content: [{ type: 'text', text: 'The business result is ready.' }],
  details: {
    mcpAppPreview: {
      kind: 'canvas',
      view: { id: descriptor.viewId, title: 'Demo' },
      presentation: { target: 'assistant_message', sandbox: 'scripts' },
      mcpApp: descriptor,
    },
  },
};
const nestedCallId = 'tool_call:dispatcher-call:demo__show:1';
const nestedCall = {
  type: 'toolCall',
  id: nestedCallId,
  runId: 'native-run',
  name: 'demo__show',
  arguments: {},
  parentToolCallId: 'dispatcher-call',
  timestamp: 1,
};
const nestedResult = {
  ...projectedResult,
  type: 'toolResult',
  runId: nestedCall.runId,
  toolCallId: nestedCallId,
  parentToolCallId: nestedCall.parentToolCallId,
  details: {
    mcpAppPreview: {
      ...projectedResult.details.mcpAppPreview,
      mcpApp: { ...descriptor, toolCallId: nestedCallId },
    },
  },
};
// prepareChatHistoryRecoveryMessages projects an authenticated nested activity
// as this custom record with its own canonical tool-call/result content pair.
const nestedActivity = {
  role: 'custom',
  customType: 'openclaw.nested-tool.v1',
  display: true,
  excludeFromContext: true,
  runId: nestedCall.runId,
  content: [nestedCall, nestedResult],
};

describe('native MCP App history projection', () => {
  const fallback = {
    type: 'canvas',
    preview: {
      kind: 'canvas',
      surface: 'assistant_message',
      render: 'url',
      viewId: descriptor.viewId,
      title: 'show UI',
      mcpApp: descriptor,
    },
  };
  it('removes the native duplicate preview and shortcode but preserves prose and code examples', () => {
    const timeline = projectPersistedTimeline([
      projectedResult,
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: `Ready. [embed ref="${descriptor.viewId}" /] \`[embed ref="${descriptor.viewId}" /]\``,
          },
          fallback,
        ],
      },
    ]);
    expect(timeline.filter(item => item.kind === 'mcp-app')).toHaveLength(1);
    const messages = timeline.filter(item => item.kind === 'history-message');
    const content = messages.flatMap(item => (item.message as { content: unknown[] }).content);
    expect(content).toEqual([
      { type: 'text', text: `Ready.  \`[embed ref="${descriptor.viewId}" /]\`` },
    ]);
  });

  it.each([
    { ...fallback.preview, url: 'https://example.test/other' },
    { ...fallback.preview, viewId: 'other-view' },
    { ...fallback.preview, render: 'native' },
    { ...fallback.preview, surface: 'node_panel' },
    { ...fallback.preview, mcpApp: { ...descriptor, serverName: 'other' } },
    { ...fallback.preview, mcpApp: { ...descriptor, toolName: 'other' } },
    { ...fallback.preview, mcpApp: { ...descriptor, uiResourceUri: 'ui://demo/other' } },
    { ...fallback.preview, mcpApp: { ...descriptor, toolCallId: 'other' } },
    { ...fallback.preview, mcpApp: { ...descriptor, originSessionKey: 'agent:other:session' } },
  ])('preserves an unrelated or mismatched preview %#', preview => {
    const block = { ...fallback, preview };
    const timeline = projectPersistedTimeline([
      projectedResult,
      { role: 'assistant', content: [block] },
    ]);
    expect(
      timeline
        .filter(item => item.kind === 'history-message')
        .some(item => JSON.stringify(item.message).includes(JSON.stringify(block))),
    ).toBe(true);
  });

  it('removes only the failed native App placeholder and retains the tool failure', () => {
    const timeline = projectPersistedTimeline([
      { ...projectedResult, isError: true },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: `Correcting the input. [embed ref="${descriptor.viewId}" /]` },
          fallback,
        ],
      },
    ]);
    expect(timeline.some(item => item.kind === 'mcp-app')).toBe(false);
    expect(
      timeline
        .filter(item => item.kind === 'history-message')
        .flatMap(item => (item.message as { content: unknown[] }).content),
    ).toEqual([{ type: 'text', text: 'Correcting the input. ' }]);
    expect(
      timeline
        .filter(item => item.kind === 'process-summary')
        .flatMap(item => item.items)
        .some(
          item =>
            item.type === 'tool' &&
            item.toolCallId === descriptor.toolCallId &&
            item.status === 'failed',
        ),
    ).toBe(true);
  });

  it('preserves explicit URL embeds even when they reuse a failed App reference', () => {
    const text = [
      `[embed ref="${descriptor.viewId}" url="https://example.test/preview" /]`,
      `[embed viewId="${descriptor.viewId}" url="https://example.test/other" /]`,
      `[embed ref="${descriptor.viewId}" url="/__openclaw__/canvas/documents/other-view/index.html" /]`,
      `\`[embed ref="${descriptor.viewId}" /]\``,
      `\`\`\`text\n[embed ref="${descriptor.viewId}" /]\n\`\`\``,
    ].join('\n');
    const timeline = projectPersistedTimeline([
      { ...projectedResult, isError: true },
      { role: 'assistant', content: [{ type: 'text', text }] },
    ]);

    expect(
      timeline
        .filter(item => item.kind === 'history-message')
        .flatMap(item => (item.message as { content: unknown[] }).content),
    ).toEqual([{ type: 'text', text }]);
  });

  it('keeps the successful retry after a failed native ToolSearch App result', () => {
    const failedDescriptor = { ...descriptor, viewId: 'failed-view', toolCallId: nestedCallId };
    const failedActivity = {
      ...nestedActivity,
      content: [
        nestedCall,
        {
          ...nestedResult,
          isError: true,
          content: [{ type: 'text', text: 'Invalid XML' }],
          details: {
            mcpAppPreview: {
              ...nestedResult.details.mcpAppPreview,
              view: { id: failedDescriptor.viewId, title: 'show UI' },
              mcpApp: failedDescriptor,
            },
          },
        },
      ],
    };
    const failedFallback = {
      ...fallback,
      preview: { ...fallback.preview, viewId: failedDescriptor.viewId, mcpApp: failedDescriptor },
    };
    const messages = [
      failedActivity,
      { role: 'assistant', content: [failedFallback] },
      projectedResult,
      { role: 'assistant', content: [{ type: 'text', text: 'Ready.' }, fallback] },
    ];
    const before = structuredClone(messages);
    const timeline = projectPersistedTimeline(messages);

    expect(
      timeline.filter(item => item.kind === 'mcp-app').map(item => item.preview.viewId),
    ).toEqual([descriptor.viewId]);
    expect(
      timeline
        .filter(item => item.kind === 'history-message')
        .flatMap(item => (item.message as { content: unknown[] }).content),
    ).toEqual([{ type: 'text', text: 'Ready.' }]);
    expect(messages).toEqual(before);
  });

  it.each([
    { ...fallback.preview, url: 'https://example.test/other' },
    { ...fallback.preview, viewId: 'other-view' },
    { ...fallback.preview, mcpApp: { ...descriptor, serverName: 'other' } },
    { ...fallback.preview, mcpApp: { ...descriptor, toolCallId: 'other' } },
    { ...fallback.preview, mcpApp: { ...descriptor, originSessionKey: 'agent:other:session' } },
    { ...fallback.preview, mcpApp: { ...descriptor, resultMetaState: 'unavailable' } },
    { ...fallback.preview, render: 'native' },
    { ...fallback.preview, surface: 'node_panel' },
    { ...fallback.preview, mcpApp: { ...descriptor, toolName: 'other' } },
    { ...fallback.preview, mcpApp: { ...descriptor, uiResourceUri: 'ui://demo/other' } },
  ])('preserves unrelated previews alongside a failed native App %#', preview => {
    const block = { ...fallback, preview };
    const timeline = projectPersistedTimeline([
      { ...projectedResult, isError: true },
      { role: 'assistant', content: [block] },
    ]);
    expect(timeline.some(item => item.kind === 'mcp-app')).toBe(false);
    expect(
      timeline
        .filter(item => item.kind === 'history-message')
        .some(item => JSON.stringify(item.message).includes(JSON.stringify(block))),
    ).toBe(true);
  });

  it.each([
    { ...projectedResult, role: 'assistant' },
    { ...projectedResult, role: 'user' },
    { ...projectedResult, toolName: 'read' },
    { ...projectedResult, toolCallId: 'different-call' },
    { ...projectedResult, toolCallId: undefined },
    { ...projectedResult, details: { ...projectedResult.details, mcpServer: 'different' } },
    { ...projectedResult, details: { ...projectedResult.details, mcpTool: 'different' } },
    {
      ...projectedResult,
      details: {
        mcpAppPreview: {
          ...projectedResult.details.mcpAppPreview,
          view: { id: 'different-view' },
        },
      },
    },
  ])('does not hide a placeholder using an uncorrelated or non-native failure %#', source => {
    const timeline = projectPersistedTimeline([
      { ...source, isError: true },
      { role: 'assistant', content: [fallback] },
    ]);
    expect(timeline.some(item => item.kind === 'mcp-app')).toBe(false);
    expect(
      timeline
        .filter(item => item.kind === 'history-message')
        .some(item => JSON.stringify(item.message).includes(JSON.stringify(fallback))),
    ).toBe(true);
  });

  it.each([
    { ...nestedCall, id: 'different-call' },
    { ...nestedCall, name: 'demo__different' },
    { ...nestedCall, runId: 'different-run' },
    { ...nestedCall, parentToolCallId: 'different-parent' },
  ])('does not hide a placeholder using a mismatched failed ToolSearch activity %#', call => {
    const child = { ...nestedResult, isError: true };
    const block = {
      ...fallback,
      preview: { ...fallback.preview, mcpApp: child.details.mcpAppPreview.mcpApp },
    };
    const timeline = projectPersistedTimeline([
      { ...nestedActivity, content: [call, child] },
      { role: 'assistant', content: [block] },
    ]);
    expect(timeline.some(item => item.kind === 'mcp-app')).toBe(false);
    expect(
      timeline
        .filter(item => item.kind === 'history-message')
        .some(item => JSON.stringify(item.message).includes(JSON.stringify(block))),
    ).toBe(true);
  });

  it('restores the projected native preview without parsing business text', () => {
    const messages = [
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: descriptor.toolCallId, name: 'demo__show', arguments: {} },
        ],
      },
      projectedResult,
      { role: 'assistant', content: 'Ready.' },
    ];
    const before = structuredClone(messages);

    const timeline = projectPersistedTimeline(messages);
    const apps = timeline.filter(item => item.kind === 'mcp-app');

    expect(apps).toHaveLength(1);
    expect(apps[0].preview.descriptor).toEqual(descriptor);
    expect(isNativeMcpAppPreview(apps[0].preview)).toBe(true);
    expect(messages).toEqual(before);
  });

  it('keeps one presentation when native history repeats the same view', () => {
    const timeline = projectPersistedTimeline([projectedResult, projectedResult]);
    expect(timeline.filter(item => item.kind === 'mcp-app')).toHaveLength(1);
  });

  it('restores the native ToolSearch target activity independently of dispatcher text', () => {
    // tool_call retains only id/name/source in model-visible text, without the
    // full tool.mcp identity. That text must not become the admission authority.
    const dispatcher = {
      role: 'toolResult',
      toolName: 'tool_call',
      toolCallId: 'dispatcher-call',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            tool: { id: 'mcp:demo:show', name: 'demo__show', source: 'mcp' },
            result: { content: projectedResult.content },
          }),
        },
      ],
    };

    const timeline = projectPersistedTimeline([nestedActivity, dispatcher]);
    const apps = timeline.filter(item => item.kind === 'mcp-app');

    expect(apps).toHaveLength(1);
    expect(apps[0].preview.descriptor).toEqual({ ...descriptor, toolCallId: nestedCallId });
    expect(isNativeMcpAppPreview(apps[0].preview)).toBe(true);
    expect(projectPersistedTimeline([dispatcher]).some(item => item.kind === 'mcp-app')).toBe(
      false,
    );
  });

  it('presents the actual nested live MCP event without admitting the outer dispatcher', () => {
    const state = createChatTranscriptState('agent:a:conversation', 'incarnation');
    let id = 0;
    const dependencies = { now: () => 1, createId: (prefix: string) => `${prefix}-${++id}` };
    const nativeResult = {
      content: projectedResult.content,
      details: {
        ...nestedResult.details,
        mcpServer: descriptor.serverName,
        mcpTool: descriptor.toolName,
      },
    };
    const event = (seq: number, data: Record<string, unknown>): NormalizedAgentEvent => ({
      runId: nestedCall.runId,
      sessionKey: state.sessionKey,
      sessionId: state.sessionId,
      lifecycleGeneration: 'generation',
      agentId: 'a',
      spawnedBy: null,
      agentSeq: seq,
      frameSeq: seq,
      deliveryEvent: 'agent',
      stream: 'tool',
      timestamp: seq,
      data: { phase: 'result', isError: false, ...data },
    });

    reduceAgentEvent(
      state,
      event(1, {
        name: nestedCall.name,
        toolCallId: nestedCallId,
        parentToolCallId: nestedCall.parentToolCallId,
        result: nativeResult,
      }),
      dependencies,
    );
    reduceAgentEvent(
      state,
      event(2, {
        name: 'tool_call',
        toolCallId: nestedCall.parentToolCallId,
        result: {
          content: [{ type: 'text', text: 'Externally wrapped dispatcher output' }],
          details: {
            tool: {
              id: 'mcp:demo:demo__show',
              name: nestedCall.name,
              source: 'mcp',
              mcp: { serverName: 'demo', toolName: 'show' },
            },
            result: nativeResult,
          },
        },
      }),
      dependencies,
    );

    const apps = projectTurnItems(state.activeTurn, false).filter(item => item.kind === 'mcp-app');
    expect(apps).toHaveLength(1);
    expect(apps[0].preview.toolCallId).toBe(nestedCallId);
    expect(apps[0].preview.descriptor).toEqual({ ...descriptor, toolCallId: nestedCallId });
    reduceAgentEvent(
      state,
      {
        ...event(3, { text: `Ready. [embed ref="${descriptor.viewId}" /]` }),
        stream: 'assistant',
      },
      dependencies,
    );
    const content = projectTurnItems(state.activeTurn, false).filter(
      item => item.kind === 'content',
    );
    expect(content.map(item => item.item.text).join('')).toBe('Ready. ');
  });

  it.each([
    { ...nestedActivity, role: 'assistant' },
    { ...nestedActivity, customType: 'other' },
    { ...nestedActivity, display: false },
    { ...nestedActivity, excludeFromContext: false },
    { ...nestedActivity, content: [nestedResult] },
    { ...nestedActivity, content: [nestedCall, { ...nestedResult, role: 'assistant' }] },
    { ...nestedActivity, content: [nestedCall, { ...nestedResult, isError: true }] },
    { ...nestedActivity, content: [{ ...nestedCall, id: 'different-call' }, nestedResult] },
    { ...nestedActivity, content: [{ ...nestedCall, name: 'demo__different' }, nestedResult] },
    { ...nestedActivity, content: [{ ...nestedCall, runId: 'different-run' }, nestedResult] },
    {
      ...nestedActivity,
      runId: undefined,
      content: [
        { ...nestedCall, runId: undefined },
        { ...nestedResult, runId: undefined },
      ],
    },
    {
      ...nestedActivity,
      runId: '',
      content: [
        { ...nestedCall, runId: '' },
        { ...nestedResult, runId: '' },
      ],
    },
    {
      ...nestedActivity,
      content: [
        { ...nestedCall, parentToolCallId: undefined },
        { ...nestedResult, parentToolCallId: undefined },
      ],
    },
    {
      ...nestedActivity,
      content: [
        { ...nestedCall, parentToolCallId: '' },
        { ...nestedResult, parentToolCallId: '' },
      ],
    },
    {
      ...nestedActivity,
      content: [{ ...nestedCall, parentToolCallId: 'different-parent' }, nestedResult],
    },
  ])('does not admit an uncorrelated native nested activity %#', message => {
    const timeline = projectPersistedTimeline([message]);
    expect(timeline.some(item => item.kind === 'mcp-app')).toBe(false);
  });

  it.each([
    { ...projectedResult, role: 'assistant' },
    { ...projectedResult, role: 'user' },
    { ...projectedResult, toolName: 'read' },
    { ...projectedResult, toolCallId: 'different-call' },
    { ...projectedResult, toolCallId: undefined },
    { ...projectedResult, isError: true },
    { ...projectedResult, details: { ...projectedResult.details, mcpServer: 'different' } },
    { ...projectedResult, details: { ...projectedResult.details, mcpTool: 'different' } },
    {
      ...projectedResult,
      details: {
        mcpAppPreview: {
          ...projectedResult.details.mcpAppPreview,
          view: { id: 'different-view' },
        },
      },
    },
    {
      role: 'assistant',
      content: [{ ...projectedResult, type: 'tool_result' }],
    },
  ])('does not restore an uncorrelated or non-native result %#', message => {
    const timeline = projectPersistedTimeline([message]);
    expect(timeline.some(item => item.kind === 'mcp-app')).toBe(false);
  });
});
