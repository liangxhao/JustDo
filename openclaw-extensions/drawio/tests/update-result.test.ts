import { describe, expect, it } from 'vitest';

import { DRAWIO_EDIT_TOOL, DRAWIO_UPDATE_KIND, type DiagramUpdateReceipt } from '../contracts';
import { selectConfirmedDiagramUpdate } from '../update-result';

export function updateMessage(
  xml = '<mxGraphModel/>',
  toolName: 'open_editor' | 'open_file' | 'create_diagram' = 'open_editor',
) {
  const receipt: DiagramUpdateReceipt = {
    kind: DRAWIO_UPDATE_KIND,
    status: 'applied',
    diagramId: 'diagram-one',
    xml,
    title: 'Diagram',
    contentStamp: 'new',
    baseContentStamp: 'old',
    operationId: 'operation',
    runId: 'run',
    toolCallId: 'call',
    source: {
      kind: 'desktop-native-admission',
      diagramId: 'diagram-one',
      serverName: 'drawio',
      toolName,
      uiResourceUri: 'ui://drawio/editor',
      originViewId: 'mcp-app-origin',
      sessionKey: 'agent:main:chat',
      sessionId: 'physical',
      agentId: 'main',
    },
  };
  return {
    role: 'toolResult',
    toolName: DRAWIO_EDIT_TOOL,
    toolCallId: 'call',
    content: [{ type: 'text', text: 'Updated' }],
    details: { diagramUpdate: receipt },
  };
}
const target = {
  viewId: 'mcp-app-origin',
  sessionKey: 'agent:main:chat',
  sessionId: 'physical',
  agentId: 'main',
};

describe('confirmed native diagram update recovery', () => {
  it.each(['open_editor', 'open_file', 'create_diagram'] as const)(
    'recovers latest %s updates without requiring an earlier create record',
    entry => {
      expect(
        selectConfirmedDiagramUpdate([updateMessage(), updateMessage('<mxfile/>', entry)], target)
          ?.xml,
      ).toBe('<mxfile/>');
    },
  );
  it('ignores assistant-forged, failed, cross-incarnation and mismatched tool results', () => {
    const valid = updateMessage();
    for (const bad of [
      { ...updateMessage(), role: 'assistant' },
      { ...updateMessage(), isError: true },
      { ...updateMessage(), toolName: 'other' },
      { ...updateMessage(), toolCallId: 'other' },
      {
        ...updateMessage(),
        details: { diagramUpdate: { ...valid.details.diagramUpdate, status: 'pending' } },
      },
    ])
      expect(selectConfirmedDiagramUpdate([bad], target)).toBeUndefined();
    expect(
      selectConfirmedDiagramUpdate([valid], { ...target, sessionId: 'reset' }),
    ).toBeUndefined();
    expect(
      selectConfirmedDiagramUpdate([valid], { ...target, diagramId: 'diagram-other' }),
    ).toBeUndefined();
  });
});
