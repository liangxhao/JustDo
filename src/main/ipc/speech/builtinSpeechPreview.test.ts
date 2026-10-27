import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: unknown, value: unknown) => unknown;
const handlers = new Map<string, Handler>();
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((name: string, handler: Handler) => handlers.set(name, handler)) },
}));
vi.mock('../../speech/localTtsService', () => ({ synthesizeLocalSpeech: vi.fn() }));
vi.mock('../../openclaw/config/speech/localTtsConfig', () => ({ getLocalTtsStatus: vi.fn() }));

import { defaultLocalSpeechSettings } from '../../../shared/speech/localSpeechSettings';
import { LOCAL_TTS_MODEL_IDS, type LocalTtsSpeakResult } from '../../../shared/speech/localTts';
import { SpeechSynthesisIpc } from '../../../shared/speech/speechSynthesis';
import { getLocalTtsStatus } from '../../openclaw/config/speech/localTtsConfig';
import { synthesizeLocalSpeech } from '../../speech/localTtsService';
import { registerBuiltinSpeechPreviewHandlers } from './builtinSpeechPreview';

const audio = { audioBase64: 'YXVkaW8=', provider: 'tts-local-cli' };
const request = {
  requestId: 'preview-1',
  modelId: LOCAL_TTS_MODEL_IDS[0],
  voiceId: 102,
  text: ' hello ',
};
function fixture() {
  const owner = Object.assign(new EventEmitter(), {
    isDestroyed: vi.fn(() => false),
    getType: vi.fn(() => 'window'),
    mainFrame: {},
  });
  const event = { sender: owner, senderFrame: owner.mainFrame };
  return {
    owner,
    event,
    preview: (input: unknown = request) =>
      handlers.get(SpeechSynthesisIpc.PreviewBuiltin)!(event, input),
    cancel: (requestId = request.requestId) =>
      handlers.get(SpeechSynthesisIpc.CancelBuiltinPreview)!(event, requestId),
  };
}
function pendingSynthesis() {
  let resolve!: (value: LocalTtsSpeakResult) => void;
  const promise = new Promise<LocalTtsSpeakResult>(complete => {
    resolve = complete;
  });
  return { promise, resolve: () => resolve(audio) };
}
beforeEach(() => {
  handlers.clear();
  vi.mocked(synthesizeLocalSpeech).mockReset().mockResolvedValue(audio);
  vi.mocked(getLocalTtsStatus)
    .mockReset()
    .mockReturnValue({ available: true, supported: true, modelId: LOCAL_TTS_MODEL_IDS[0] });
  registerBuiltinSpeechPreviewHandlers();
});

describe('builtin speech preview IPC', () => {
  it('uses only the requested installed model and voice with temporary defaults, independent of saved output and plugins', async () => {
    const f = fixture();
    expect(defaultLocalSpeechSettings.outputEnabled).toBe(false);
    expect(await f.preview()).toEqual({ ...audio, requestId: request.requestId });
    expect(synthesizeLocalSpeech).toHaveBeenCalledWith(
      'hello',
      {
        ...defaultLocalSpeechSettings,
        outputEnabled: true,
        synthesisMode: 'local',
        ttsModelId: request.modelId,
        voiceId: 102,
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(defaultLocalSpeechSettings.outputEnabled).toBe(false);
    expect(f.owner.listenerCount('destroyed')).toBe(0);
    expect(f.owner.listenerCount('did-navigate')).toBe(0);
  });
  it('rejects missing assets, arbitrary paths and non-window/non-main-frame callers before execution', async () => {
    const f = fixture();
    vi.mocked(getLocalTtsStatus).mockReturnValueOnce({
      available: false,
      supported: true,
      modelId: request.modelId,
    });
    await expect(f.preview()).rejects.toThrow('not installed');
    await expect(f.preview({ ...request, command: 'custom.exe' })).rejects.toThrow('Invalid');
    f.owner.getType.mockReturnValueOnce('webview');
    await expect(f.preview()).rejects.toThrow('window frame');
    await expect(
      handlers.get(SpeechSynthesisIpc.PreviewBuiltin)!({ ...f.event, senderFrame: {} }, request),
    ).rejects.toThrow('window frame');
    expect(synthesizeLocalSpeech).not.toHaveBeenCalled();
  });
  it('waits for cancelled CLI cleanup before starting the replacement and old finally cannot clear the new owner slot', async () => {
    const f = fixture();
    const old = pendingSynthesis();
    const current = pendingSynthesis();
    vi.mocked(synthesizeLocalSpeech)
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(current.promise);
    const first = f.preview();
    const firstSignal = vi.mocked(synthesizeLocalSpeech).mock.calls[0][2]!.signal!;
    const firstRejected = expect(first).rejects.toThrow('cancelled');
    const second = f.preview({ ...request, requestId: 'preview-2', voiceId: 3 });
    expect(firstSignal.aborted).toBe(true);
    expect(synthesizeLocalSpeech).toHaveBeenCalledOnce();
    old.resolve();
    await firstRejected;
    await vi.waitFor(() => expect(synthesizeLocalSpeech).toHaveBeenCalledTimes(2));
    const secondSignal = vi.mocked(synthesizeLocalSpeech).mock.calls[1][2]!.signal!;
    f.cancel('preview-1');
    expect(secondSignal.aborted).toBe(false);
    f.cancel('preview-2');
    expect(secondSignal.aborted).toBe(true);
    const secondRejected = expect(second).rejects.toThrow('cancelled');
    current.resolve();
    await secondRejected;
    expect(f.owner.listenerCount('destroyed')).toBe(0);
  });
  it('keeps cancelled cleanup in the serial chain during a rapid cancel and restart', async () => {
    const f = fixture();
    const old = pendingSynthesis();
    vi.mocked(synthesizeLocalSpeech).mockReturnValueOnce(old.promise);
    const first = f.preview();
    const rejected = expect(first).rejects.toThrow('cancelled');
    f.cancel();
    const second = f.preview({ ...request, requestId: 'preview-2' });
    expect(synthesizeLocalSpeech).toHaveBeenCalledOnce();
    old.resolve();
    await rejected;
    await expect(second).resolves.toMatchObject({ requestId: 'preview-2' });
  });
  it('isolates cancellation to the requesting owner and exact request ID', async () => {
    const f = fixture();
    const other = fixture();
    const pending = pendingSynthesis();
    vi.mocked(synthesizeLocalSpeech).mockReturnValueOnce(pending.promise);
    const running = f.preview();
    const signal = vi.mocked(synthesizeLocalSpeech).mock.calls[0][2]!.signal!;
    other.cancel();
    f.cancel('wrong-request');
    expect(signal.aborted).toBe(false);
    f.cancel();
    expect(signal.aborted).toBe(true);
    const rejected = expect(running).rejects.toThrow('cancelled');
    pending.resolve();
    await rejected;
  });
  it.each(['destroyed', 'did-navigate', 'render-process-gone'])(
    'revokes %s and discards a late result while removing listeners',
    async eventName => {
      const f = fixture();
      const pending = pendingSynthesis();
      vi.mocked(synthesizeLocalSpeech).mockReturnValueOnce(pending.promise);
      const running = f.preview();
      const signal = vi.mocked(synthesizeLocalSpeech).mock.calls[0][2]!.signal!;
      f.owner.emit(eventName);
      expect(signal.aborted).toBe(true);
      const rejected = expect(running).rejects.toThrow('cancelled');
      pending.resolve();
      await rejected;
      expect(f.owner.eventNames()).toEqual([]);
    },
  );
  it('rechecks model readiness after synthesis and rejects audio after removal', async () => {
    const f = fixture();
    vi.mocked(getLocalTtsStatus)
      .mockReturnValueOnce({ available: true, supported: true, modelId: request.modelId })
      .mockReturnValueOnce({ available: true, supported: true, modelId: request.modelId })
      .mockReturnValueOnce({ available: false, supported: true, modelId: request.modelId });
    await expect(f.preview()).rejects.toThrow('no longer installed');
  });
});
