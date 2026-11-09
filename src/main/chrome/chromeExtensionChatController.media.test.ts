import { describe, expect, it, vi } from 'vitest';

import { CoworkSessionSource } from '../../shared/cowork/sessionSource';
import type { CoworkStartOptions } from '../engine/types';
import { ChromeExtensionChatController } from './chromeExtensionChatController';

const image = { name: 'image.png', mimeType: 'image/png', base64Data: 'aGVsbG8=' };
const vision = 'provider/vision';
const plain = 'provider/plain';
function fixture(modelRef: string | undefined = vision) {
  const session = { id: 'thread', source: CoworkSessionSource.ChromeExtension as string,
    title: 'Browser', agentId: 'main', cwd: '/task', permissionMode: 'ask', modelRef };
  const catalog = [{ id: 'vision', provider: 'provider', name: 'Vision', input: ['text', 'image'] },
    { id: 'plain', provider: 'provider', name: 'Text', input: ['text'] }];
  const request = vi.fn(async () => ({ models: catalog }));
  const client = { request };
  const runtime = { getGatewayClient: () => client, getGatewayClientGeneration: () => 1 };
  const store = { getSession: () => session, getSessionRunByClientTurnId: vi.fn(),
    beginSessionRun: vi.fn(() => ({ id: 'timing' })), updateSession: vi.fn((_id: string, patch: object) => Object.assign(session, patch)) };
  const router = {
    isSessionActive: () => false,
    prepareSession: vi.fn(async (_id: string, options: { modelRef?: string }) => {
      if (options.modelRef) session.modelRef = options.modelRef;
      return { sessionKey: 'native-key', gatewaySessionId: 'physical' };
    }),
    patchSessionModel: vi.fn(async (_id: string, selected: string) => ({ ok: true, modelRef: selected })),
    startSession: vi.fn(async (_id: string, _message: string, options: CoworkStartOptions) => {
      options.finalSyncAdmission?.({ sessionKey: 'native-key', nativeSessionId: 'physical', lifecycleRevision: 'revision', clientGeneration: 1 });
      options.onAccepted?.();
    }),
  };
  const controller = new ChromeExtensionChatController({
    getStore: () => store as never, getRouter: () => router as never, getRuntime: () => runtime as never,
    getDefaultModelRef: () => vision, ensureEngineRunning: async () => ({ phase: 'running' }) as never,
  });
  vi.spyOn(controller, 'getComposerOptions').mockResolvedValue({ models: [
    { id: vision, name: 'Vision' }, { id: plain, name: 'Text' },
  ], permissionMode: 'ask' });
  return { controller, session, request, store, router, catalog };
}

describe('browser image model admission', () => {
  it.each(['session', 'requested', 'default'] as const)('pins a real vision-capable %s model for image-only input', async selected => {
    const h = fixture(selected === 'requested' ? plain : selected === 'default' ? undefined : vision);
    if (selected === 'default') h.session.modelRef = undefined;
    await h.controller.sendMessage({ sessionId: 'thread', message: '', attachments: [image],
      ...(selected === 'requested' ? { modelRef: vision } : {}) });
    expect(h.router.startSession).toHaveBeenCalledWith('thread', '', expect.objectContaining({ initialModelRef: vision, attachments: [image] }));
    expect(h.store.beginSessionRun).toHaveBeenCalledOnce();
  });

  it('rejects legacy image attachments for a text-only model before permission, model or timing mutations', async () => {
    const h = fixture(plain);
    await expect(h.controller.sendMessage({ sessionId: 'thread', message: 'Input', attachments: [image], permissionMode: 'full' }))
      .rejects.toMatchObject({ requestSent: false });
    expect(h.router.prepareSession).not.toHaveBeenCalled();
    expect(h.router.patchSessionModel).not.toHaveBeenCalled();
    expect(h.router.startSession).not.toHaveBeenCalled();
    expect(h.store.updateSession).not.toHaveBeenCalled();
    expect(h.store.beginSessionRun).not.toHaveBeenCalled();
  });

  it('keeps ordinary document attachments usable with text-only models', async () => {
    const h = fixture(plain);
    const document = { name: 'note.txt', mimeType: 'text/plain', base64Data: 'aGVsbG8=' };
    await h.controller.sendMessage({ sessionId: 'thread', message: 'Read this', attachments: [document] });
    expect(h.request).not.toHaveBeenCalled();
    expect(h.router.startSession).toHaveBeenCalledWith('thread', 'Read this', expect.objectContaining({ attachments: [document] }));
  });

  it.each(['model', 'source'] as const)('rejects a stale catalog result after the original %s changes', async changed => {
    const h = fixture();
    let catalogReady!: (value: { models: typeof h.catalog }) => void;
    h.request.mockImplementationOnce(() => new Promise(resolve => { catalogReady = resolve; }));
    const sending = h.controller.sendMessage({ sessionId: 'thread', message: 'Input', attachments: [image] });
    const rejected = expect(sending).rejects.toMatchObject({ requestSent: false });
    await vi.waitFor(() => expect(h.request).toHaveBeenCalledOnce());
    if (changed === 'model') h.session.modelRef = plain;
    else h.session.source = 'desktop';
    catalogReady({ models: h.catalog });
    await rejected;
    expect(h.router.startSession).not.toHaveBeenCalled();
    expect(h.store.beginSessionRun).not.toHaveBeenCalled();
  });

  it('rechecks the selected model after asynchronous native preparation', async () => {
    const h = fixture();
    h.router.prepareSession.mockImplementationOnce(async () => {
      h.session.modelRef = plain;
      return { sessionKey: 'native-key', gatewaySessionId: 'physical' };
    });
    await expect(h.controller.sendMessage({ sessionId: 'thread', message: 'Input', attachments: [image] }))
      .rejects.toMatchObject({ requestSent: false });
    expect(h.store.beginSessionRun).not.toHaveBeenCalled();
    expect(h.router.startSession).not.toHaveBeenCalled();
  });
});

describe('browser workspace send admission', () => {
  it('rejects a directory change during text-only native preparation before recording or sending a run', async () => {
    const h = fixture(plain);
    h.router.prepareSession.mockImplementationOnce(async () => {
      h.session.cwd = '/replacement';
      return { sessionKey: 'native-key', gatewaySessionId: 'physical' };
    });
    await expect(h.controller.sendMessage({ sessionId: 'thread', message: 'Input' }))
      .rejects.toMatchObject({ requestSent: false });
    expect(h.store.beginSessionRun).not.toHaveBeenCalled();
    expect(h.router.startSession).not.toHaveBeenCalled();
  });

  it('rejects the workspace captured by the binding if it changed while preparing input or history', async () => {
    const h = fixture(plain);
    await expect(h.controller.sendMessage({
      sessionId: 'thread', message: 'Input', expectedWorkspaceRoot: '/previous',
    })).rejects.toMatchObject({ requestSent: false });
    expect(h.router.prepareSession).not.toHaveBeenCalled();
    expect(h.store.beginSessionRun).not.toHaveBeenCalled();
  });
});
