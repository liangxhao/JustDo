import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const f = vi.hoisted(() => ({
  dispatch: vi.fn(),
  entry: vi.fn(),
  history: vi.fn(),
  admission: vi.fn(),
  createResource: vi.fn(),
  preview: vi.fn(),
}));
vi.mock('node:module', () => ({
  createRequire: () => () => ({ createEditorResource: f.createResource }),
}));
vi.mock('openclaw/plugin-sdk/gateway-method-runtime', () => ({ dispatchGatewayMethod: f.dispatch }));
vi.mock('openclaw/plugin-sdk/session-store-runtime', () => ({ getSessionEntry: f.entry }));
vi.mock('openclaw/plugin-sdk/session-transcript-runtime', () => ({
  readVisibleSessionTranscriptMessageEntries: f.history,
}));
vi.mock('openclaw/plugin-sdk/agent-harness-runtime', () => ({
  prepareHarnessNativeMcpAppPreview: f.preview,
}));
vi.mock('../editing', () => ({
  getDiagramEditingState: () => ({ recovered: new Map() }),
  readAdmittedDiagramSource: f.admission,
}));

import { DRAWIO_CURRENT_METHOD } from '../contracts';
import { registerDiagramRecovery } from '../restore';

const scope = {
  sessionKey: 'agent:main:editor', sessionId: 'physical-editor', agentId: 'main',
  viewId: 'mcp-app-original', diagramId: 'diagram-original',
};
type Handler = (invocation: Record<string, unknown>) => Promise<void>;
let handlers: Map<string, Handler>;
let service: { start: () => void; stop: () => Promise<void> };
let live: boolean;
let editor: { read: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
const shell = {
  html: '<html>immutable editor</html>',
  csp: { resourceDomains: ['http://127.0.0.1:23456'] },
  sandboxUrl: '/mcp-app-sandbox?csp=fixture&v=fixture',
  sandboxPort: 23457,
  sandboxOrigin: 'http://127.0.0.1:23457',
};

async function current(overrides: Record<string, unknown> = {}) {
  const respond = vi.fn();
  await handlers.get(DRAWIO_CURRENT_METHOD)!({
    params: { ...scope, editorResource: true, ...overrides },
    client: { connId: 'editor-connection' },
    hasCurrentClientAuthority: () => live,
    respond,
  });
  const [ok, value, failure] = respond.mock.calls[0];
  if (!ok) throw new Error(failure.message);
  return value;
}

beforeEach(() => {
  handlers = new Map();
  live = true;
  editor = { read: vi.fn().mockResolvedValue({ contents: [] }), close: vi.fn() };
  f.entry.mockReturnValue({ sessionId: scope.sessionId, lifecycleRevision: 'life-one' });
  f.history.mockResolvedValue([]);
  f.admission.mockReturnValue({ diagramId: scope.diagramId });
  f.createResource.mockResolvedValue(editor);
  f.preview.mockResolvedValue({ mcpAppPreview: { mcpApp: { viewId: 'mcp-app-resource' } } });
  f.dispatch.mockImplementation(async method => method === 'chat.history'
    ? { ok: true, payload: scope }
    : { ok: true, payload: { ...shell, messageSupported: true, toolResult: { private: true } } });
  registerDiagramRecovery({
    source: '/plugin/index.cjs',
    runtime: { config: { current: () => ({ mcp: { apps: { enabled: true } } }) } },
    registerService: (value: typeof service) => { service = value; },
    registerGatewayMethod: (name: string, handler: Handler) => handlers.set(name, handler),
  } as never);
  service.start();
});

afterEach(async () => {
  await service.stop();
  vi.resetAllMocks();
});

describe('admitted diagram editor asset lifetime', () => {
  it('serves the matching native sandbox and immutable shell without replacing diagram authority', async () => {
    const result = await current();
    expect(result).toEqual({ diagram: null, readOnly: false, editorResource: shell });
    expect(f.admission).toHaveBeenCalledWith({
      connectionId: 'editor-connection', sessionKey: scope.sessionKey, sessionId: scope.sessionId,
      agentId: scope.agentId, viewId: scope.viewId,
    }, scope.diagramId);
    const preparation = f.preview.mock.calls[0][0];
    expect(preparation.allowedAppToolNames.size).toBe(0);
    expect(preparation.runtime.mcpAppModelContextRevoked).toBe(true);
    await expect(preparation.runtime.callTool()).rejects.toThrow('cannot call tools');
    await preparation.runtime.dispose();
    expect(editor.close).not.toHaveBeenCalled();
    await current();
    expect(f.createResource).toHaveBeenCalledOnce();
  });

  it('rejects an unproven source before starting an asset service', async () => {
    f.admission.mockImplementation(() => { throw new Error('source unavailable'); });
    await expect(current()).rejects.toThrow('could not be restored');
    expect(f.createResource).not.toHaveBeenCalled();
    expect(f.preview).not.toHaveBeenCalled();
  });

  it('does not return a resource after source authority changes during asynchronous native preparation', async () => {
    f.preview.mockImplementation(async () => {
      f.admission.mockImplementation(() => { throw new Error('source retired'); });
      return { mcpAppPreview: { mcpApp: { viewId: 'mcp-app-resource' } } };
    });
    await expect(current()).rejects.toThrow('could not be restored');
    expect(f.dispatch.mock.calls.filter(([method]) => method === 'mcp.app.view')).toHaveLength(0);
  });

  it('closes a late asset creation on service shutdown and never returns it to the renderer', async () => {
    let finish!: (value: typeof editor) => void;
    f.createResource.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const request = current();
    const rejected = expect(request).rejects.toThrow('could not be restored');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const stopping = service.stop();
    finish(editor);
    await Promise.all([rejected, stopping]);
    expect(editor.close).toHaveBeenCalledOnce();
    expect(f.preview).not.toHaveBeenCalled();
  });
});
