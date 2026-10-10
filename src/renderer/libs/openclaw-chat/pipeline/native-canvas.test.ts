import { describe, expect, it } from 'vitest';

import { reduceAgentEvent } from '../model/agent-event-reducer';
import type { AssistantTurn } from '../model/chat-transcript-state';
import { createChatTranscriptState } from '../model/chat-transcript-state';
import { projectPersistedTimeline } from '../model/project-history-timeline';
import { projectTurnItems } from '../model/project-turn-items';
import { normalizeMessage } from './message-normalizer';
import {
  decodeNativeCanvasResult,
  isNativeCanvasPreview,
  stripNativeWidgetFallbacks,
} from './native-canvas';
import { extractToolCards } from './tool-cards';

const output = JSON.stringify({
  kind: 'canvas',
  presentation: { target: 'assistant_message', sandbox: 'scripts', title: 'Delivery' },
  view: { id: 'widget-123', url: '/untrusted-relative-url' },
});
const wrappedResult = {
  tool: { id: 'openclaw:core:show_widget', name: 'show_widget', source: 'openclaw' },
  result: {
    content: [{ type: 'text', text: output }],
    details: JSON.parse(output),
  },
};
const wrappedOutput = JSON.stringify(wrappedResult);

describe('native show_widget descriptors', () => {
  it('admits the exact successful native core tool_call envelope using its actual outer call id', () => {
    const preview = decodeNativeCanvasResult(wrappedOutput, 'tool_call', 'outer-call');
    expect(preview).toMatchObject({
      docId: 'widget-123',
      toolCallId: 'outer-call',
      render: 'native',
    });
    expect(preview).not.toHaveProperty('url');
    expect(isNativeCanvasPreview(preview)).toBe(true);
  });

  it('rejects mismatched, unrelated and recursively nested dispatch envelopes', () => {
    for (const payload of [
      { ...wrappedResult, tool: { ...wrappedResult.tool, id: 'openclaw:plugin:show_widget' } },
      { ...wrappedResult, tool: { ...wrappedResult.tool, source: 'mcp' } },
      { ...wrappedResult, tool: { ...wrappedResult.tool, source: 'client' } },
      { ...wrappedResult, tool: { ...wrappedResult.tool, name: 'read' } },
      { ...wrappedResult, result: { ...wrappedResult.result, content: output } },
      { ...wrappedResult, result: { content: wrappedResult.result.content } },
      { ...wrappedResult, result: { ...wrappedResult.result, details: wrappedResult } },
      { unrelated: wrappedResult },
    ]) {
      expect(
        decodeNativeCanvasResult(JSON.stringify(payload), 'tool_call', 'outer'),
      ).toBeUndefined();
    }
    expect(decodeNativeCanvasResult(wrappedOutput, 'exec', 'outer')).toBeUndefined();
    expect(decodeNativeCanvasResult(wrappedOutput, 'tool_describe', 'outer')).toBeUndefined();
    expect(decodeNativeCanvasResult(wrappedOutput, 'tool_call', undefined)).toBeUndefined();
    expect(
      decodeNativeCanvasResult(wrappedOutput + ' '.repeat(32_768), 'tool_call', 'outer'),
    ).toBeUndefined();
  });

  it.each([
    { isError: true },
    { ok: false },
    { success: false },
    { status: 'failed' },
    { status: 'timeout' },
    { status: 'denied' },
    { status: 'forbidden' },
    { status: 'approval-unavailable' },
    { status: 'disabled' },
    { status: 'aborted' },
    { status: 'killed' },
    { status: 'invalid' },
    { status: ' DENIED ' },
    { status: 'cancelled' },
    { timedOut: true },
    { error: 'Synthetic failure' },
    { exitCode: 1 },
  ])('rejects failed inner dispatcher results even when they include a descriptor: %j', failure => {
    for (const result of [
      { ...wrappedResult.result, ...failure },
      { ...wrappedResult.result, details: { ...wrappedResult.result.details, ...failure } },
    ]) {
      expect(
        decodeNativeCanvasResult(
          JSON.stringify({ ...wrappedResult, result }),
          'tool_call',
          'outer',
        ),
      ).toBeUndefined();
    }
  });

  it('restores a real outer dispatcher result and removes only its matching structured fallback', () => {
    const fallback = {
      type: 'canvas',
      preview: {
        kind: 'canvas',
        surface: 'assistant_message',
        render: 'url',
        viewId: 'widget-123',
        url: '/__openclaw__/canvas/documents/widget-123/index.html',
      },
    };
    const real = {
      role: 'toolResult',
      toolName: 'tool_call',
      toolCallId: 'outer-call',
      isError: false,
      content: [{ type: 'text', text: wrappedOutput }],
    };
    const nativeProcess = {
      role: 'custom',
      customType: 'openclaw.nested-tool.v1',
      display: true,
      excludeFromContext: true,
      content: [
        { type: 'toolCall', id: 'inner-call', name: 'show_widget', parentToolCallId: 'outer-call' },
        {
          type: 'toolResult',
          role: 'toolResult',
          toolName: 'show_widget',
          toolCallId: 'inner-call',
          parentToolCallId: 'outer-call',
          isError: false,
          content: [{ type: 'text', text: output }],
        },
      ],
    };
    const projected = projectPersistedTimeline([
      nativeProcess,
      real,
      { role: 'assistant', content: [{ type: 'text', text: 'Synthetic answer' }, fallback] },
    ]);
    expect(projected.filter(item => item.kind === 'native-widget')).toHaveLength(1);
    expect(projected.find(item => item.kind === 'native-widget')).toMatchObject({
      preview: { docId: 'widget-123', toolCallId: 'outer-call' },
    });
    expect(projected.find(item => item.kind === 'history-message')).toMatchObject({
      message: { content: [{ type: 'text', text: 'Synthetic answer' }] },
    });
    expect(extractToolCards(real)[0].preview?.render).toBe('native');
    expect(
      projectPersistedTimeline([nativeProcess]).some(item => item.kind === 'native-widget'),
    ).toBe(false);
    for (const fake of [
      { ...real, role: 'assistant' },
      { ...real, role: 'user' },
      { ...real, isError: true },
    ]) {
      expect(projectPersistedTimeline([fake]).some(item => item.kind === 'native-widget')).toBe(
        false,
      );
      expect(extractToolCards(fake)[0]?.preview?.render).not.toBe('native');
    }
  });

  it('presents direct inner and wrapped outer results once, preserving both execution records', () => {
    const state = createChatTranscriptState('session-1', 'session-id');
    let nextId = 0;
    const records = [
      { name: 'show_widget', toolCallId: 'inner-call', result: output },
      { name: 'tool_call', toolCallId: 'outer-call', result: wrappedOutput },
    ];
    for (const [index, data] of records.entries()) {
      reduceAgentEvent(
        state,
        {
          runId: 'run-1',
          sessionKey: 'session-1',
          sessionId: 'session-id',
          lifecycleGeneration: null,
          agentId: 'main',
          spawnedBy: null,
          agentSeq: index + 1,
          frameSeq: index + 1,
          deliveryEvent: 'agent',
          timestamp: 1_000 + index,
          stream: 'tool',
          data: { phase: 'result', ...data },
        },
        { now: () => 1_000, createId: prefix => `${prefix}-${++nextId}` },
      );
    }
    const history = records.map(record => ({
      role: 'toolResult',
      toolName: record.name,
      toolCallId: record.toolCallId,
      content: [{ type: 'text', text: record.result }],
    }));
    for (const projected of [
      projectTurnItems(state.activeTurn),
      projectPersistedTimeline(history),
    ]) {
      expect(projected.filter(item => item.kind === 'native-widget')).toHaveLength(1);
      expect(
        projected
          .flatMap(item => (item.kind === 'process-summary' ? item.items : []))
          .filter(item => item.type === 'tool'),
      ).toHaveLength(2);
    }
    expect(
      projectTurnItems(state.activeTurn).find(item => item.kind === 'native-widget'),
    ).toMatchObject({ preview: { toolCallId: 'inner-call' } });
    const outerOnly = createChatTranscriptState('session-1', 'session-id');
    reduceAgentEvent(
      outerOnly,
      {
        runId: 'run-2',
        sessionKey: 'session-1',
        sessionId: 'session-id',
        lifecycleGeneration: null,
        agentId: 'main',
        spawnedBy: null,
        agentSeq: 1,
        frameSeq: 1,
        deliveryEvent: 'agent',
        timestamp: 1_000,
        stream: 'tool',
        data: { phase: 'result', ...records[1] },
      },
      { now: () => 1_000, createId: prefix => `${prefix}-${++nextId}` },
    );
    expect(
      projectTurnItems(outerOnly.activeTurn).filter(item => item.kind === 'native-widget'),
    ).toHaveLength(1);
  });

  it('uses a native tool result document id without navigating to its informational URL', () => {
    const preview = decodeNativeCanvasResult(output, 'show_widget', 'call-1');
    expect(preview).toMatchObject({ render: 'native', docId: 'widget-123', toolCallId: 'call-1' });
    expect(preview).not.toHaveProperty('url');
    expect(isNativeCanvasPreview(preview)).toBe(true);
  });

  it('rejects ordinary output, shortcode view ids, missing tool identity and invalid document ids', () => {
    expect(decodeNativeCanvasResult(output, 'write', 'call-1')).toBeUndefined();
    expect(decodeNativeCanvasResult(output, 'show_widget', undefined)).toBeUndefined();
    expect(
      decodeNativeCanvasResult(
        '[embed url="https://example.test" viewId="widget-123" /]',
        'show_widget',
        'call-1',
      ),
    ).toBeUndefined();
    expect(
      decodeNativeCanvasResult(output.replace('widget-123', '../escape'), 'show_widget', 'call-1'),
    ).toBeUndefined();
  });

  it('admits native history but rejects assistant-authored canvas lookalikes and tool names', () => {
    const real = extractToolCards({
      role: 'toolResult',
      toolName: 'show_widget',
      toolCallId: 'call-1',
      content: [{ type: 'text', text: output }],
    });
    expect(real[0].preview?.render).toBe('native');
    const fake = extractToolCards({
      role: 'assistant',
      toolName: 'show_widget',
      toolCallId: 'call-1',
      content: output,
    });
    expect(fake[0].preview).toBeUndefined();
    const preview = decodeNativeCanvasResult(output, 'show_widget', 'call-1')!;
    expect(
      normalizeMessage({ role: 'assistant', content: [{ type: 'canvas', preview }] }).content[0],
    ).toMatchObject({ type: 'canvas', preview: { render: 'native' } });
    expect(
      normalizeMessage({
        role: 'assistant',
        content: [{ type: 'canvas', preview: JSON.parse(JSON.stringify(preview)) }],
      }).content.some(item => item.type === 'canvas'),
    ).toBe(false);
  });

  it('presents a completed real tool result in both live and persisted timelines', () => {
    const state = createChatTranscriptState('session-1', 'session-id');
    let nextId = 0;
    for (const [index, data] of [
      { phase: 'start', name: 'show_widget', toolCallId: 'call-1', args: {} },
      { phase: 'result', name: 'show_widget', toolCallId: 'call-1', result: output },
    ].entries()) {
      reduceAgentEvent(
        state,
        {
          runId: 'run-1',
          sessionKey: 'session-1',
          sessionId: 'session-id',
          lifecycleGeneration: null,
          agentId: 'main',
          spawnedBy: null,
          agentSeq: index + 1,
          frameSeq: index + 1,
          deliveryEvent: 'agent',
          timestamp: 1_000 + index,
          stream: 'tool',
          data,
        },
        { now: () => 1_000, createId: prefix => `${prefix}-${++nextId}` },
      );
    }
    const persisted = projectPersistedTimeline([
      {
        role: 'assistant',
        runId: 'run-1',
        content: [{ type: 'toolCall', id: 'call-1', name: 'show_widget', arguments: {} }],
      },
      {
        role: 'toolResult',
        runId: 'run-1',
        toolName: 'show_widget',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: output }],
      },
    ]);
    for (const timeline of [projectTurnItems(state.activeTurn), persisted]) {
      expect(timeline.map(item => item.kind)).toEqual(['process-summary', 'native-widget']);
      const widget = timeline.find(item => item.kind === 'native-widget');
      expect(widget).toMatchObject({ preview: { docId: 'widget-123', toolCallId: 'call-1' } });
      expect(widget?.kind === 'native-widget' && isNativeCanvasPreview(widget.preview)).toBe(true);
    }
  });

  it('does not open a document from failed tools or assistant-authored nested result text', () => {
    for (const message of [
      {
        role: 'toolResult',
        toolName: 'show_widget',
        toolCallId: 'call-1',
        isError: true,
        content: [{ type: 'text', text: output }],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_result', toolName: 'show_widget', toolCallId: 'call-1', output }],
      },
    ]) {
      expect(projectPersistedTimeline([message]).some(item => item.kind === 'native-widget')).toBe(
        false,
      );
    }
  });

  it('removes only same-document fallback shortcodes once a canonical widget exists', () => {
    const duplicate = '[embed url="/__openclaw__/canvas/documents/widget-123/index.html" /]';
    const unrelated = '[embed url="https://example.test" viewId="other-document" /]';
    const text = `Summary\n${duplicate}\n${unrelated}`;
    expect(stripNativeWidgetFallbacks(text, new Set(['widget-123']))).toBe(
      `Summary\n\n${unrelated}`,
    );
    expect(stripNativeWidgetFallbacks(text, new Set())).toBe(text);
    expect(
      stripNativeWidgetFallbacks('`[embed ref="widget-123" /]`', new Set(['widget-123'])),
    ).toBe('`[embed ref="widget-123" /]`');
    const timeline = projectPersistedTimeline([
      {
        role: 'toolResult',
        toolName: 'show_widget',
        toolCallId: 'call-1',
        content: [{ type: 'text', text: output }],
      },
      { role: 'assistant', content: [{ type: 'text', text }] },
    ]);
    const final = timeline.find(item => item.kind === 'history-message');
    expect(final).toMatchObject({
      message: { content: [{ type: 'text', text: `Summary\n\n${unrelated}` }] },
    });
    expect(timeline.filter(item => item.kind === 'native-widget')).toHaveLength(1);
    const turn: AssistantTurn = {
      id: 'turn',
      runId: 'run',
      sessionId: 'session',
      lifecycleGeneration: null,
      sessionKey: 'key',
      status: 'final',
      lastAgentSeq: 3,
      startedAt: 1,
      toolById: new Map(),
      items: [
        {
          id: 'tool',
          type: 'tool',
          status: 'completed',
          name: 'show_widget',
          toolCallId: 'call-1',
          output,
          runId: 'run',
          firstSeq: 1,
          lastSeq: 2,
          startedAt: 1,
          updatedAt: 2,
        },
        {
          id: 'content',
          type: 'content',
          status: 'completed',
          text,
          sourceMode: 'snapshot',
          runId: 'run',
          firstSeq: 3,
          lastSeq: 3,
          startedAt: 3,
          updatedAt: 3,
        },
      ],
    };
    expect(projectTurnItems(turn).find(item => item.kind === 'content')).toMatchObject({
      item: { text: `Summary\n\n${unrelated}` },
    });
    expect(turn.items[1]).toMatchObject({ text });
  });

  it('deduplicates the actual locked Gateway structured history fallback without admitting it', () => {
    const docId = 'cv_d8ab8a193ffd4495948dedacb9223921';
    const descriptor = {
      kind: 'canvas',
      presentation: {
        target: 'assistant_message',
        title: 'Synthetic scenario',
        sandbox: 'scripts',
      },
      view: { id: docId, url: `/__openclaw__/canvas/documents/${docId}/index.html` },
      text: `Widget hosted at /__openclaw__/canvas/documents/${docId}/index.html`,
    };
    const structured = {
      type: 'canvas',
      preview: {
        kind: 'canvas',
        surface: 'assistant_message',
        render: 'url',
        title: 'Synthetic scenario',
        sandbox: 'scripts',
        url: descriptor.view.url,
        viewId: docId,
      },
      rawText: JSON.stringify(descriptor, null, 2),
    };
    const final = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Synthetic fixture complete.' }, structured],
    };
    const projected = projectPersistedTimeline([
      {
        role: 'toolResult',
        toolCallId: 'fixture-widget-2',
        toolName: 'show_widget',
        isError: false,
        content: [{ type: 'text', text: JSON.stringify(descriptor, null, 2) }],
      },
      final,
    ]);
    expect(projected.filter(item => item.kind === 'native-widget')).toHaveLength(1);
    expect(projected.find(item => item.kind === 'history-message')).toMatchObject({
      message: { content: [{ type: 'text', text: 'Synthetic fixture complete.' }] },
    });
    expect(final.content).toHaveLength(2);
    const alone = projectPersistedTimeline([final]);
    expect(alone.some(item => item.kind === 'native-widget')).toBe(false);
    expect(alone[0]).toMatchObject({ message: { content: final.content } });
    const other = {
      ...final,
      content: [
        { ...structured, preview: { ...structured.preview, url: 'https://example.test/other' } },
      ],
    };
    expect(
      projectPersistedTimeline([
        {
          role: 'toolResult',
          toolCallId: 'fixture-widget-2',
          toolName: 'show_widget',
          content: [{ type: 'text', text: JSON.stringify(descriptor) }],
        },
        other,
      ]).find(item => item.kind === 'history-message'),
    ).toMatchObject({ message: { content: other.content } });
  });
});
