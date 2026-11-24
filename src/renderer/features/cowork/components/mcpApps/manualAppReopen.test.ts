import { McpAppMethod } from '@shared/plugins/mcpApps';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { McpAppSession } from '@/libs/openclaw-chat/gateway/mcp-app/mcp-app-session';
import { registerMcpAppAdapter } from '@/libs/openclaw-chat/pipeline/mcp-app-adapters';
import { decodeMcpAppLaunch } from '@/libs/openclaw-chat/pipeline/native-mcp-app';

import {
  editorAdapter,
  editorSource,
} from '../../../../../../tests/mcp-apps/editor-adapter-fixture';
import { withManualAppReopen } from './manualAppReopen';

const sessionKey = 'agent:main:example';
const pluginId = 'fixture-plugin';
const oldViewId = 'mcp-app-old';
const launch = (viewId: string) => ({
  viewId,
  preview: {
    kind: 'canvas',
    mcpApp: { ...editorSource, viewId, originSessionKey: sessionKey },
    view: { id: viewId, title: 'Editor' },
    presentation: { target: 'assistant_message', sandbox: 'scripts' },
  },
});
const catalog = {
  servers: [
    {
      pluginId,
      serverName: editorSource.serverName,
      label: 'Editor',
      entrypoints: [
        {
          toolName: editorSource.toolName,
          resourceUri: editorSource.uiResourceUri,
          title: 'Blank',
          entrypoint: { type: 'global' as const },
        },
      ],
    },
  ],
};

let removeAdapter: () => void;
beforeEach(() => {
  removeAdapter = registerMcpAppAdapter({
    ...editorAdapter,
    blankLaunch: { pluginId, toolName: editorSource.toolName },
  });
});
afterEach(() => removeAdapter());

function fixture() {
  let physicalId = 'original';
  const request = vi.fn<(method: string, params?: unknown) => Promise<unknown>>(async method =>
    method === McpAppMethod.Discover ? catalog : launch('mcp-app-new'),
  );
  const client = { generation: 1, request };
  const apps = new McpAppSession(() => {
    const sessionId = physicalId;
    return {
      client: client as never,
      generation: 1,
      sessionKey,
      sessionId,
      agentId: 'main',
      isCurrent: () => physicalId === sessionId,
    };
  });
  const base = {
    apps,
    sessionKey,
    isCurrent: () => true,
    canDraft: () => true,
    addDraft: async () => false,
  };
  const context = withManualAppReopen({
    context: { ...base, refresh: async () => base },
    preview: decodeMcpAppLaunch(launch(oldViewId))!,
    input: {
      ...editorSource,
      entrypointType: 'global',
      filePath: '/old/path',
      deepLink: '/old/link',
    },
    catalog,
  });
  return {
    context,
    request,
    replaceSession: () => {
      physicalId = 'replacement';
    },
  };
}

test('a confirmed blank entry opens a new view through fresh native discovery', async () => {
  const f = fixture();
  const reopened = await f.context.reopenBlank!.open(new AbortController().signal);
  expect(reopened).toMatchObject({
    status: 'opened',
    preview: { viewId: 'mcp-app-new' },
    context: { reopenBlank: { viewId: 'mcp-app-new' } },
  });
  expect(f.request.mock.calls.map(([method]) => method)).toEqual([
    McpAppMethod.Discover,
    McpAppMethod.Launch,
  ]);
  expect(f.request.mock.calls[1][1]).toEqual({
    serverName: editorSource.serverName,
    toolName: editorSource.toolName,
    entrypointType: 'global',
    sessionKey,
    agentId: 'main',
  });
});

test.each(['package replacement', 'session replacement'] as const)(
  'does not launch after fresh discovery finds a %s',
  async change => {
    const f = fixture();
    f.request.mockImplementationOnce(async () => {
      if (change === 'session replacement') {
        f.replaceSession();
        return catalog;
      }
      return {
        servers: catalog.servers.map(server => ({ ...server, pluginId: 'another-plugin' })),
      };
    });
    await expect(f.context.reopenBlank!.open(new AbortController().signal)).rejects.toThrow();
    expect(f.request.mock.calls.map(([method]) => method)).toEqual([McpAppMethod.Discover]);
  },
);

test('an unknown fresh launch cannot be repeated through the same view or refreshed context', async () => {
  const f = fixture();
  const open = f.context.reopenBlank!;
  let fail!: (reason: Error) => void;
  f.request
    .mockImplementationOnce(async () => catalog)
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
  const pending = open.open(new AbortController().signal);
  await vi.waitFor(() => expect(fail).toBeTypeOf('function'));
  await expect(open.open(new AbortController().signal)).rejects.toThrow('unavailable');
  fail(new Error('Socket closed before response'));
  await expect(pending).resolves.toEqual({ status: 'unknown' });
  const refreshed = await f.context.refresh!();
  expect(refreshed.reopenBlank?.status()).toBe('unknown');
  await expect(refreshed.reopenBlank?.open(new AbortController().signal)).rejects.toThrow(
    'unavailable',
  );
  expect(f.request.mock.calls.map(([method]) => method)).toEqual([
    McpAppMethod.Discover,
    McpAppMethod.Launch,
  ]);
});
