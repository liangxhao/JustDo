import { describe, expect, it } from 'vitest';

import { DRAWIO_EDIT_TOOL, DRAWIO_UPDATE_KIND } from '../../openclaw-extensions/drawio/contracts';
import type { AssistantTurn } from '../../src/renderer/libs/openclaw-chat/model/chat-transcript-state';
import { projectPersistedTimeline } from '../../src/renderer/libs/openclaw-chat/model/timeline/project-history-timeline';
import { projectTurnItems } from '../../src/renderer/libs/openclaw-chat/model/timeline/project-turn-items';
import {
  decodeNativeDiagramReference,
  isNativeDiagramReference,
} from '../../src/renderer/libs/openclaw-chat/pipeline/native-diagram';

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
    const reference = decodeNativeDiagramReference(
      JSON.stringify(result()),
      DRAWIO_EDIT_TOOL,
      'call',
    )!;
    expect(isNativeDiagramReference(reference)).toBe(true);
    expect(Object.isFrozen(reference)).toBe(true);
    expect(reference).not.toHaveProperty('xml');
    expect(isNativeDiagramReference({ ...reference })).toBe(false);
    expect(decodeNativeDiagramReference(result(), 'other', 'call')).toBeUndefined();
    expect(decodeNativeDiagramReference(result(), DRAWIO_EDIT_TOOL, 'other')).toBeUndefined();
  });

  it('projects a real tool result as one compact reference in both live and persisted timelines', () => {
    const source = result();
    const persisted = projectPersistedTimeline([source]);
    expect(persisted.filter(item => item.kind === 'diagram-reference')).toHaveLength(1);
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
    expect(live.filter(item => item.kind === 'diagram-reference')).toHaveLength(1);
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
      expect(projectPersistedTimeline([bad]).some(item => item.kind === 'diagram-reference')).toBe(
        false,
      );
    }
  });
});
