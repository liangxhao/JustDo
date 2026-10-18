import { describe, expect, it } from 'vitest';

import {
  decodeMcpAppLaunch,
  decodeMcpAppQuestionPreview,
  decodeNativeMcpAppResult,
  isNativeMcpAppPreview,
} from './native-mcp-app';

const descriptor = {
  viewId: 'mcp-app-view',
  serverName: 'demo',
  toolName: 'show',
  uiResourceUri: 'ui://demo/app',
  toolCallId: 'call-1',
};
const preview = {
  kind: 'canvas',
  mcpApp: descriptor,
  view: { id: descriptor.viewId, title: 'Demo' },
  presentation: { target: 'assistant_message', sandbox: 'scripts' },
};
const result = { details: { mcpServer: 'demo', mcpTool: 'show', mcpAppPreview: preview } };

describe('native MCP App admission', () => {
  it('admits authenticated question view references without fabricating tool descriptors', () => {
    const app = decodeMcpAppQuestionPreview({
      preview: { viewId: 'question-preview' },
      title: 'Preview',
    });
    expect(isNativeMcpAppPreview(app)).toBe(true);
    expect(app?.descriptor).toBeNull();
    expect(isNativeMcpAppPreview({ ...app })).toBe(false);
    expect(
      decodeMcpAppQuestionPreview({ preview: { viewId: '../foreign' }, title: 'Preview' }),
    ).toBeUndefined();
    expect(
      decodeMcpAppQuestionPreview({ preview: { viewId: 'question-preview' } }),
    ).toBeUndefined();
  });
  it('admits a canonical MCP result with its exact native tool call identity', () => {
    const app = decodeNativeMcpAppResult(JSON.stringify(result), 'demo__show', 'call-1');
    expect(app?.viewId).toBe(descriptor.viewId);
    expect(isNativeMcpAppPreview(app)).toBe(true);
    expect(isNativeMcpAppPreview({ ...app })).toBe(false);
  });

  it('rejects forged tool identities, failures and embedded prose', () => {
    expect(
      decodeNativeMcpAppResult(JSON.stringify(result), 'show_widget', 'call-1'),
    ).toBeUndefined();
    expect(decodeNativeMcpAppResult(JSON.stringify(result), 'demo__show', 'other')).toBeUndefined();
    expect(
      decodeNativeMcpAppResult(
        JSON.stringify({ ...result, isError: true }),
        'demo__show',
        'call-1',
      ),
    ).toBeUndefined();
    expect(
      decodeNativeMcpAppResult(
        JSON.stringify({ text: JSON.stringify(result) }),
        'demo__show',
        'call-1',
      ),
    ).toBeUndefined();
    expect(
      decodeNativeMcpAppResult(
        JSON.stringify({ details: { ...result.details, mcpServer: 'forged' } }),
        'demo__show',
        'call-1',
      ),
    ).toBeUndefined();
  });

  it('admits only a matching authenticated manual launch response', () => {
    expect(decodeMcpAppLaunch({ viewId: descriptor.viewId, preview })?.descriptor).toEqual(
      descriptor,
    );
    expect(decodeMcpAppLaunch({ viewId: 'other', preview })).toBeUndefined();
    expect(decodeMcpAppLaunch({ preview })).toBeUndefined();
  });

  it('checks the resolved MCP identity of native tool search results', () => {
    const envelope = {
      tool: { source: 'mcp', mcp: { serverName: 'demo', toolName: 'show' } },
      result,
    };
    expect(
      decodeNativeMcpAppResult(JSON.stringify(envelope), 'tool_call', 'dispatcher-call')?.viewId,
    ).toBe(descriptor.viewId);
    expect(
      decodeNativeMcpAppResult(
        JSON.stringify({
          ...envelope,
          tool: { ...envelope.tool, mcp: { serverName: 'other', toolName: 'show' } },
        }),
        'tool_call',
        'dispatcher-call',
      ),
    ).toBeUndefined();
  });
});
