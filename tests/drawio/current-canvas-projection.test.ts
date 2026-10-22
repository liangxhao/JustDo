import { describe, expect, it } from 'vitest';

import { DRAWIO_EDIT_TOOL, DRAWIO_UPDATE_KIND } from '../../plugins/extensions/drawio/contracts';
import { diagramUpdateReference } from '../../plugins/extensions/drawio/update-result';
import type { AssistantTurn } from '../../src/renderer/libs/openclaw-chat/model/chat-transcript-state';
import { projectPersistedTimeline } from '../../src/renderer/libs/openclaw-chat/model/timeline/project-history-timeline';
import { projectTurnItems } from '../../src/renderer/libs/openclaw-chat/model/timeline/project-turn-items';
import {
  decodeNativeAppReference,
  isNativeAppReference,
} from '../../src/renderer/libs/openclaw-chat/pipeline/native-app-reference';

const result = () => ({
  role: 'toolResult',
  toolName: DRAWIO_EDIT_TOOL,
  toolCallId: 'call',
  content: [{ type: 'text', text: 'Updated' }],
  details: {
    diagramUpdate: {
      kind: DRAWIO_UPDATE_KIND,
      status: 'applied',
      diagramId: 'diagram-one',
      xml: '<mxGraphModel/>',
      title: 'Current diagram',
      operationId: 'operation',
      runId: 'run',
      toolCallId: 'call',
      baseContentStamp: 'old',
      contentStamp: 'new',
      source: {
        kind: 'desktop-native-admission',
        diagramId: 'diagram-one',
        serverName: 'drawio',
        toolName: 'open_editor',
        uiResourceUri: 'ui://drawio/editor',
        originViewId: 'mcp-app-original',
        sessionKey: 'agent:main:one',
        sessionId: 'physical',
        agentId: 'main',
      },
    },
  },
});

describe('confirmed current diagram projection', () => {
  it('admits a frozen reference without XML, and refuses copied or mismatched references', () => {
    const reference = decodeNativeAppReference(JSON.stringify(result()), DRAWIO_EDIT_TOOL, 'call')!;
    expect(isNativeAppReference(reference)).toBe(true);
    expect(Object.isFrozen(reference)).toBe(true);
    expect(reference).not.toHaveProperty('xml');
    expect(isNativeAppReference({ ...reference })).toBe(false);
    expect(decodeNativeAppReference(result(), 'other', 'call')).toBeUndefined();
    expect(decodeNativeAppReference(result(), DRAWIO_EDIT_TOOL, 'other')).toBeUndefined();
  });

  it('projects a real tool result as one compact reference in both live and persisted timelines', () => {
    const source = result();
    const persisted = projectPersistedTimeline([source]);
    expect(persisted.filter(item => item.kind === 'app-reference')).toHaveLength(1);
    expect(persisted.some(item => item.kind === 'mcp-app')).toBe(false);
    const turn = {
      runId: 'run',
      id: 'turn',
      status: 'final',
      items: [
        {
          type: 'tool',
          id: 'tool',
          name: DRAWIO_EDIT_TOOL,
          runId: 'run',
          toolCallId: 'call',
          status: 'completed',
          output: JSON.stringify(source),
          startedAt: 1,
          updatedAt: 2,
        },
      ],
    } as AssistantTurn;
    const live = projectTurnItems(turn);
    expect(live.filter(item => item.kind === 'app-reference')).toHaveLength(1);
    expect(live.some(item => item.kind === 'mcp-app')).toBe(false);
  });

  it('never projects failed, unconfirmed, or assistant-nested data as an editable reference', () => {
    const source = result();
    for (const bad of [
      { ...source, isError: true },
      { ...source, role: 'assistant' },
      {
        ...source,
        details: { diagramUpdate: { ...source.details.diagramUpdate, status: 'pending' } },
      },
    ]) {
      expect(projectPersistedTimeline([bad]).some(item => item.kind === 'app-reference')).toBe(
        false,
      );
    }
  });

  it('keeps the same compact reference after the native history drops custom details', () => {
    const source = result();
    const compact = diagramUpdateReference(source.details.diagramUpdate as never);
    const history = {
      ...source,
      details: undefined,
      content: [{ type: 'text', text: JSON.stringify(compact) }],
    };
    const reference = decodeNativeAppReference(history, DRAWIO_EDIT_TOOL, 'call')!;
    expect(reference.content.contentId).toBe('diagram-one');
    expect(JSON.stringify(reference)).not.toContain('<mxGraphModel');
    expect(
      projectPersistedTimeline([history]).filter(item => item.kind === 'app-reference'),
    ).toHaveLength(1);
    for (const bad of [
      { ...history, role: 'assistant' },
      { ...history, toolName: 'another_plugin_tool' },
      { ...history, toolCallId: 'different' },
      { ...history, isError: true },
      { ...history, runId: 'another-run' },
      { ...history, run_id: 'another-run' },
      { ...history, metadata: { runId: 'another-run' } },
      { ...history, __openclaw: { runId: 'another-run' } },
      { runId: 'another-run', message: history },
      { ...history, content: [{ type: 'text', text: `Example: ${JSON.stringify(compact)}` }] },
    ])
      expect(projectPersistedTimeline([bad]).some(item => item.kind === 'app-reference')).toBe(
        false,
      );
    expect(
      decodeNativeAppReference(history, DRAWIO_EDIT_TOOL, 'call', 'other-run'),
    ).toBeUndefined();
  });
});
