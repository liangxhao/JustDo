// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import {
  EDITOR_RESTORE,
  editorAdapter,
  editorSource,
} from '../../../../../../tests/mcp-apps/editor-adapter-fixture';
import { McpAppSession } from '../../gateway/mcp-app/mcp-app-session';
import { registerMcpAppAdapter } from '../../pipeline/mcp-app-adapters';
import {
  decodeNativeAppReference,
  isNativeAppReference,
} from '../../pipeline/native-app-reference';
import { decodeMcpAppLaunch } from '../../pipeline/native-mcp-app';
import {
  readRecoveredAppContent,
  restoreAppReference,
  restrictRecoveredAppPayload,
} from './plugin-content';
import { getMcpAppPresentations, type McpAppPresentationAnchor } from './presentations';
import type { McpAppViewContext } from './view';

let release: () => void;
let releaseAdapter: () => void;
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  release = getMcpAppPresentations().retainWorkspace();
  releaseAdapter = registerMcpAppAdapter(editorAdapter);
});
afterEach(async () => {
  releaseAdapter();
  release();
  document.body.replaceChildren();
  await new Promise(resolve => setTimeout(resolve, 20));
  vi.unstubAllGlobals();
});

function fixture() {
  const source = {
    ...editorSource,
    contentId: 'document-one',
    originViewId: 'mcp-app-original',
    sessionKey: 'agent:a:chat',
    sessionId: 'incarnation',
    agentId: 'a',
  };
  const reference = (operationId: string) =>
    decodeNativeAppReference(
      {
        ...source,
        title: 'Workflow',
        operationId,
        toolCallId: operationId,
        runId: 'run',
      },
      editorAdapter.referenceTool,
      operationId,
    )!;
  const launch = (viewId: string) => ({
    viewId,
    preview: {
      kind: 'canvas',
      mcpApp: {
        viewId,
        serverName: source.serverName,
        toolName: source.toolName,
        uiResourceUri: source.uiResourceUri,
        originSessionKey: source.sessionKey,
      },
      view: { id: viewId, title: 'Workflow' },
      presentation: { target: 'assistant_message', sandbox: 'scripts' },
    },
    payload: {
      messageSupported: false,
      toolResult: { structuredContent: { id: source.contentId } },
    },
  });
  const request = vi.fn(async (method: string) => {
    if (method === EDITOR_RESTORE) return launch('mcp-app-recovered');
    return new Promise<never>(() => {});
  });
  const client = { generation: 1, gatewayUrl: 'ws://127.0.0.1', request };
  const apps = new McpAppSession(() => ({
    client: client as never,
    generation: client.generation,
    sessionKey: source.sessionKey,
    sessionId: source.sessionId,
    agentId: source.agentId,
    isCurrent: () => true,
  }));
  const context = (): McpAppViewContext => ({
    apps,
    sessionKey: source.sessionKey,
    presentationScope: 'conversation',
    isCurrent: () => true,
    canDraft: () => true,
    addDraft: async () => false,
  });
  const anchor = () => {
    const element = document.createElement('div') as unknown as McpAppPresentationAnchor;
    element.presentationChanged = vi.fn();
    document.body.append(element);
    return element;
  };
  return {
    source,
    reference,
    request,
    client,
    apps,
    context,
    anchor,
    launch,
    manager: getMcpAppPresentations(),
  };
}

test('two historical operations share one authenticated recovery and keep the original content source', async () => {
  const f = fixture(),
    first = f.reference('first'),
    second = f.reference('second');
  const [a, b] = await Promise.all([
    restoreAppReference(first, f.context()),
    restoreAppReference(second, f.context()),
  ]);
  expect(a).toBe(b);
  expect(f.request.mock.calls.filter(([method]) => method === EDITOR_RESTORE)).toHaveLength(1);
  expect(readRecoveredAppContent(a, f.apps.bind())).toEqual(first.content);
  const entry = f.manager.acquire(f.anchor(), a, f.context())!;
  expect(f.manager.findReference(second, f.context())).toBe(entry);
  const original = decodeMcpAppLaunch(f.launch(f.source.originViewId))!;
  expect(f.manager.acquire(f.anchor(), original, f.context())).toBe(entry);
  expect(f.manager.entries).toHaveLength(1);
  expect(entry.preview).toBe(a);
  expect(isNativeAppReference({ ...first })).toBe(false);
});

test('recovery aliases never restore old message/file/context capabilities or cross connection generations', async () => {
  const f = fixture(),
    reference = f.reference('first');
  const preview = await restoreAppReference(reference, f.context());
  const payload = restrictRecoveredAppPayload(preview, f.apps.bind(), {
    html: '',
    sandboxUrl: '',
    sandboxPort: 1,
    messageSupported: true,
    fileResourcesSupported: true,
    openFilesSupported: true,
    richModelContextSupported: true,
    updateModelContextSupported: true,
  });
  for (const key of [
    'messageSupported',
    'fileResourcesSupported',
    'openFilesSupported',
    'richModelContextSupported',
    'updateModelContextSupported',
  ] as const)
    expect(payload[key]).toBe(false);
  f.client.generation++;
  expect(readRecoveredAppContent(preview, f.apps.bind())).toBeUndefined();
});
