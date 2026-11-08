import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handlers, fetch } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  fetch: vi.fn(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, callback: (...args: unknown[]) => Promise<unknown>) =>
      handlers.set(name, callback),
  },
}));
vi.mock('../../core/network/mainProcessFetch', () => ({ mainProcessFetch: fetch }));

import { defaultLocalSpeechSettings } from '../../../shared/speech/localSpeechSettings';
import { OnlineAsrIpc } from '../../../shared/speech/onlineAsr';
import { advanceSpeechConfigurationRevision } from '../../speech/speechConfigurationRevision';
import { registerRecordedOnlineAsrHandlers } from './recordedOnlineAsr';

class Owner extends EventEmitter {
  mainFrame = {};
  destroyed = false;
  getType() {
    return 'window';
  }
  isDestroyed() {
    return this.destroyed;
  }
}
const audio = () => {
  const bytes = Buffer.alloc(46);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(38, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(2, 40);
  return new Uint8Array(bytes);
};
const category = () => ({
  providers: {
    service: {
      displayName: 'Internal',
      baseUrl: 'http://speech.internal/v1',
      apiKey: '',
      models: [
        {
          id: 'asr',
          name: 'ASR',
          bindings: [{ id: 'recording', protocolId: 'openai-transcription-http' }],
        },
      ],
    },
  },
});
const initialSettings = () => ({
  ...defaultLocalSpeechSettings,
  inputEnabled: true,
  recognitionMode: 'online' as const,
  onlineAsrModelRef: 'service/asr',
  onlineAsrBindingId: 'recording',
});
const request = (requestId: string) => ({ requestId, audioWav: audio(), language: 'auto' });
const event = (owner: Owner) => ({ sender: owner, senderFrame: owner.mainFrame });
const invoke = (channel: string, owner: Owner, value: unknown) =>
  handlers.get(channel)!(event(owner), value);

describe('recorded online ASR IPC ownership and revocation', () => {
  let settings = initialSettings();
  beforeEach(() => {
    handlers.clear();
    fetch.mockReset();
    settings = initialSettings();
    registerRecordedOnlineAsrHandlers({ getSettings: () => settings, getModelCategory: category });
  });

  it('rejects a subframe and invalid request before sending', async () => {
    const owner = new Owner();
    await expect(
      handlers.get(OnlineAsrIpc.Transcribe)!({ sender: owner, senderFrame: {} }, request('a')),
    ).rejects.toThrow('application window frame');
    await expect(
      invoke(OnlineAsrIpc.Transcribe, owner, {
        ...request('a'),
        endpoint: 'http://other.internal',
      }),
    ).rejects.toThrow('Invalid recorded');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects a mismatched configured endpoint before uploading microphone audio', async () => {
    const models = category();
    models.providers.service.baseUrl = 'http://speech.internal/v1/audio/speech';
    registerRecordedOnlineAsrHandlers({ getSettings: () => settings, getModelCategory: () => models });
    await expect(invoke(OnlineAsrIpc.Transcribe, new Owner(), request('invalid-endpoint'))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not deliver an old result after A → B → A and aborts its request immediately', async () => {
    let finish!: (response: Response) => void;
    fetch.mockReturnValue(
      new Promise(resolve => {
        finish = resolve;
      }),
    );
    const owner = new Owner();
    const pending = invoke(OnlineAsrIpc.Transcribe, owner, request('old-a'));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const a = { voice: settings, onlineModelProviders: { 'speech-recognition': category() } };
    const b = { ...a, voice: { ...settings, inputEnabled: false } };
    advanceSpeechConfigurationRevision(b, a);
    advanceSpeechConfigurationRevision(a, b);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    finish(Response.json({ text: 'late result' }));
    await expect(pending).rejects.toThrow('cancelled');
    expect(owner.listenerCount('destroyed')).toBe(0);
  });

  it('serializes replacement requests and an old cancel cannot stop the new request', async () => {
    let finishOld!: (response: Response) => void;
    fetch
      .mockReturnValueOnce(
        new Promise(resolve => {
          finishOld = resolve;
        }),
      )
      .mockResolvedValueOnce(Response.json({ text: 'new result' }));
    const owner = new Owner();
    const old = invoke(OnlineAsrIpc.Transcribe, owner, request('old'));
    const rejected = expect(old).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const next = invoke(OnlineAsrIpc.Transcribe, owner, request('next'));
    await invoke(OnlineAsrIpc.CancelTranscription, owner, 'old');
    expect(fetch).toHaveBeenCalledTimes(1);
    finishOld(Response.json({ text: 'old result' }));
    await rejected;
    await expect(next).resolves.toEqual({ requestId: 'next', text: 'new result' });
    expect(fetch.mock.calls[1][1].signal.aborted).toBe(false);
  });

  it('does not let another window cancel an owned request, but navigation does revoke it', async () => {
    let finish!: (response: Response) => void;
    fetch.mockReturnValue(
      new Promise(resolve => {
        finish = resolve;
      }),
    );
    const owner = new Owner();
    const pending = invoke(OnlineAsrIpc.Transcribe, owner, request('owned'));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    await invoke(OnlineAsrIpc.CancelTranscription, new Owner(), 'owned');
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(false);
    owner.emit('did-navigate');
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
    finish(Response.json({ text: 'discard' }));
    await expect(pending).rejects.toThrow('cancelled');
  });
});
