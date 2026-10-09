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
import { SpeechSynthesisIpc } from '../../../shared/speech/speechSynthesis';
import { synthesizeLocalSpeech } from '../../speech/localTtsService';
import { registerSpeechSynthesisHandlers } from './speechSynthesis';

describe('speech synthesis IPC', () => {
  const requestGateway = vi.fn();
  let settings = { ...defaultLocalSpeechSettings, outputEnabled: true };

  beforeEach(() => {
    handlers.clear();
    requestGateway.mockReset();
    settings = { ...defaultLocalSpeechSettings, outputEnabled: true, synthesisMode: 'online' };
    vi.mocked(synthesizeLocalSpeech).mockReset();
    registerSpeechSynthesisHandlers({ requestGateway, getSettings: () => settings });
  });

  it('synthesizes trimmed preview text through the configured Gateway provider', async () => {
    const result = { audioBase64: 'YXVkaW8=', provider: 'tts-local-cli' };
    requestGateway.mockResolvedValue(result);

    await expect(handlers.get(SpeechSynthesisIpc.Speak)?.({}, '  你好，欢迎使用。  ')).resolves.toBe(
      result,
    );
    expect(requestGateway).toHaveBeenCalledWith('tts.speak', { text: '你好，欢迎使用。' });
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

  it('rejects empty and oversized preview text', async () => {
    const speak = handlers.get(SpeechSynthesisIpc.Speak);

    await expect(speak?.({}, '   ')).rejects.toThrow('Invalid speech text.');
    await expect(speak?.({}, 'a'.repeat(10_001))).rejects.toThrow('Invalid speech text.');
    expect(requestGateway).not.toHaveBeenCalled();
  });
});
