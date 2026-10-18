import { describe, expect, it } from 'vitest';

import { selectDiagramResult } from '../restore-result';

const sessionKey = 'agent:main:conversation';
const viewId = 'mcp-app-original';
function activity() {
  return {
    role: 'custom',
    customType: 'openclaw.nested-tool.v1',
    display: true,
    excludeFromContext: true,
    content: '',
    details: {
      runId: 'run',
      parentToolCallId: 'parent',
      toolCallId: 'child',
      toolName: 'drawio__create_diagram',
      isError: false,
      input: {},
      result: {
        content: [],
        details: {
          mcpServer: 'drawio',
          mcpTool: 'create_diagram',
          structuredContent: { xml: '<mxfile/>', title: 'Original' },
          mcpAppPreview: {
            mcpApp: {
              viewId,
              serverName: 'drawio',
              toolName: 'create_diagram',
              toolCallId: 'child',
              uiResourceUri: 'ui://drawio/editor',
              originSessionKey: sessionKey,
            },
          },
        },
      },
    },
  };
}

describe('native diagram recovery evidence', () => {
  it('recovers the original structured result even when the bounded tool input was omitted', () => {
    expect(selectDiagramResult([activity()], viewId, sessionKey)).toEqual({
      toolCallId: 'child',
      diagram: { xml: '<mxfile/>', title: 'Original' },
    });
  });
  it.each([
    'view',
    'session',
    'tool',
    'call',
    'server',
    'failed',
    'meta',
    'omitted',
    'assistant',
    'parent',
  ])('rejects missing or mismatched %s evidence', kind => {
    const message = activity();
    const details = message.details.result.details;
    const descriptor = details.mcpAppPreview.mcpApp;
    if (kind === 'view') descriptor.viewId = 'mcp-app-other';
    if (kind === 'session') descriptor.originSessionKey = 'agent:other:conversation';
    if (kind === 'tool') message.details.toolName = 'tool_call';
    if (kind === 'call') descriptor.toolCallId = 'other';
    if (kind === 'server') details.mcpServer = 'other';
    if (kind === 'failed') message.details.isError = true;
    if (kind === 'meta') Object.assign(descriptor, { resultMetaState: 'unavailable' });
    if (kind === 'omitted') Object.assign(details, { structuredContent: undefined });
    if (kind === 'assistant') message.role = 'assistant';
    if (kind === 'parent') message.details.parentToolCallId = '';
    expect(selectDiagramResult([message], viewId, sessionKey)).toBeUndefined();
  });
  it('does not skip a newer invalid matching result to recover older authority', () => {
    const invalid = activity();
    invalid.details.isError = true;
    expect(selectDiagramResult([activity(), invalid], viewId, sessionKey)).toBeUndefined();
  });
});
