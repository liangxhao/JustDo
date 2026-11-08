import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: never[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: never[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../../speech/localTtsService', () => ({ synthesizeLocalSpeech: vi.fn() }));
import { defaultLocalSpeechSettings } from '../../../shared/speech/localSpeechSettings';
import {
  SpeechSynthesisIpc,
  type SpeechSynthesisResult,
} from '../../../shared/speech/speechSynthesis';
import { synthesizeLocalSpeech } from '../../speech/localTtsService';
import { advanceSpeechConfigurationRevision } from '../../speech/speechConfigurationRevision';
import { registerSpeechSynthesisHandlers } from './speechSynthesis';

describe('speech synthesis IPC', () => {
  const requestGateway = vi.fn();
  let settings = { ...defaultLocalSpeechSettings, outputEnabled: true };
  const category = {
    providers: {
      internal: {
        displayName: 'Internal',
        baseUrl: 'http://voice.internal/v1',
        apiKey: '',
        models: [{ id: 'reader', name: 'Reader', voices: [{ id: 'voice', name: 'Voice' }] }],
      },
    },
  };

  beforeEach(() => {
    handlers.clear();
    requestGateway.mockReset();
    settings = {
      ...defaultLocalSpeechSettings,
      outputEnabled: true,
      synthesisMode: 'online',
      onlineTtsModelRef: 'internal/reader',
      onlineTtsVoiceSelection: { kind: 'preset', voiceId: 'voice' },
    };
    vi.mocked(synthesizeLocalSpeech).mockReset();
    registerSpeechSynthesisHandlers({
      requestGateway,
      getSettings: () => settings,
      getModelCategory: () => category,
    });
  });

  it('synthesizes trimmed preview text through the configured Gateway provider', async () => {
    const result = { audioBase64: 'YXVkaW8=', provider: 'tts-local-cli' };
    requestGateway.mockResolvedValue(result);

    await expect(
      handlers.get(SpeechSynthesisIpc.Speak)?.({}, '  你好，欢迎使用。  '),
    ).resolves.toBe(result);
    expect(requestGateway).toHaveBeenCalledWith(
      'runtimeServices.speech.synthesize',
      {
        text: '你好，欢迎使用。',
        configurationId: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      { assertBeforeSend: expect.any(Function) },
    );
  });

  it('uses the local module without calling Gateway', async () => {
    settings.synthesisMode = 'local';
    const result = { audioBase64: 'audio', provider: 'tts-local-cli' };
    vi.mocked(synthesizeLocalSpeech).mockResolvedValue(result);
    await expect(handlers.get(SpeechSynthesisIpc.Speak)?.({}, 'hello')).resolves.toBe(result);
    expect(synthesizeLocalSpeech).toHaveBeenCalledWith('hello', settings);
    expect(requestGateway).not.toHaveBeenCalled();
  });

  it('honors the application output switch', async () => {
    settings.outputEnabled = false;
    await expect(handlers.get(SpeechSynthesisIpc.Speak)?.({}, 'hello')).rejects.toThrow('disabled');
    expect(requestGateway).not.toHaveBeenCalled();
    expect(synthesizeLocalSpeech).not.toHaveBeenCalled();
  });

  it.each([
    { mode: 'online' as const, change: { outputEnabled: false } },
    {
      mode: 'online' as const,
      change: {
        onlineTtsVoice: 'changed-voice',
        onlineTtsVoiceSelection: { kind: 'preset' as const, voiceId: 'changed-voice' },
      },
    },
    { mode: 'local' as const, change: { voiceId: 1 } },
  ])(
    'discards late $mode audio after relevant output settings change: $change',
    async ({ mode, change }) => {
      settings.synthesisMode = mode;
      let finish!: (result: SpeechSynthesisResult) => void;
      const pendingResult = new Promise<SpeechSynthesisResult>(resolve => {
        finish = resolve;
      });
      if (mode === 'online') requestGateway.mockReturnValue(pendingResult);
      else vi.mocked(synthesizeLocalSpeech).mockReturnValue(pendingResult);
      const pending = handlers.get(SpeechSynthesisIpc.Speak)?.({}, 'hello');
      Object.assign(settings, change);
      finish({
        audioBase64: 'YXVkaW8=',
        provider: 'tts-local-cli',
        outputFormat: 'wav',
        fileExtension: '.wav',
        mimeType: 'audio/wav',
      });
      await expect(pending).rejects.toThrow('Speech settings changed');
    },
  );

  it('keeps an online result when only recognition or inactive local settings change', async () => {
    let finish!: (result: SpeechSynthesisResult) => void;
    requestGateway.mockReturnValue(
      new Promise<SpeechSynthesisResult>(resolve => {
        finish = resolve;
      }),
    );
    const pending = handlers.get(SpeechSynthesisIpc.Speak)?.({}, 'hello');
    settings.inputEnabled = true;
    settings.voiceId = 1;
    const result: SpeechSynthesisResult = {
      audioBase64: 'YXVkaW8=',
      provider: 'openai',
      outputFormat: 'wav',
      fileExtension: '.wav',
      mimeType: 'audio/wav',
    };
    finish(result);
    await expect(pending).resolves.toBe(result);
  });

  it('rejects empty and oversized preview text', async () => {
    const speak = handlers.get(SpeechSynthesisIpc.Speak);

    await expect(speak?.({}, '   ')).rejects.toThrow('Invalid speech text.');
    await expect(speak?.({}, 'a'.repeat(10_001))).rejects.toThrow('Invalid speech text.');
    expect(requestGateway).not.toHaveBeenCalled();
  });

  it('discards old A audio after a failed change rolls B back to A', async () => {
    const a = { voice: { ...settings, onlineTtsModelRef: 'a' } };
    const b = { voice: { ...settings, onlineTtsModelRef: 'b' } };
    let finish!: (value: SpeechSynthesisResult) => void;
    const audio = { audioBase64: 'YXVkaW8=', provider: 'openai' } as SpeechSynthesisResult;
    requestGateway.mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve;
      }),
    );
    const old = handlers.get(SpeechSynthesisIpc.Speak)?.({}, 'old A');
    advanceSpeechConfigurationRevision(b, a);
    advanceSpeechConfigurationRevision(a, b);
    finish(audio);
    await expect(old).rejects.toThrow('Speech settings changed');
    requestGateway.mockResolvedValue(audio);
    await expect(handlers.get(SpeechSynthesisIpc.Speak)?.({}, 'new A')).resolves.toBe(audio);
  });

  it('does not dispatch text after settings change while Gateway readiness is pending', async () => {
    let ready!: () => void;
    const readiness = new Promise<void>(resolve => {
      ready = resolve;
    });
    const dispatch = vi.fn();
    requestGateway.mockImplementation(async (_method, _params, options) => {
      await readiness;
      options.assertBeforeSend();
      return dispatch();
    });
    const pending = handlers.get(SpeechSynthesisIpc.Speak)?.({}, 'private text');
    settings.onlineTtsModelRef = 'changed';
    ready();
    await expect(pending).rejects.toThrow('Speech settings changed');
    expect(dispatch).not.toHaveBeenCalled();
  });
});
