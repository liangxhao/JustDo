import { beforeEach, describe, expect, it, vi } from 'vitest';

import plugin from '../index';

const execution = vi.hoisted(() => ({ local: vi.fn(), online: vi.fn() }));
vi.mock('../transcribe', () => ({
  readConfig: (value: { mode?: string } | undefined) => (value?.mode === 'local' ? value : null),
  transcribeFile: execution.local,
}));
vi.mock('../online', () => ({
  readOnlineConfig: (value: { baseUrl?: string }) => {
    if (!value.baseUrl) throw new Error('online model unavailable');
    return value;
  },
  transcribeOnlineFile: execution.online,
}));

beforeEach(() => vi.clearAllMocks());
function fixture() {
  let config: object | undefined = { mode: 'online', baseUrl: 'http://asr/v1', model: 'selected' };
  const registerTool = vi.fn();
  plugin.register({ pluginConfig: { mode: 'local' }, config: {}, registerTool } as never);
  const assertInvocationCurrent = vi.fn();
  const context = {
    getRuntimeConfig: () => ({
      plugins: { entries: config ? { 'stt-local-cli': { config } } : {} },
    }),
    fsPolicy: { root: '/permitted', workspaceOnly: true },
    assertInvocationCurrent,
  };
  return {
    factory: registerTool.mock.calls[0][0],
    context,
    setConfig: (next: object | undefined) => {
      config = next;
    },
  };
}
describe('one configured transcription tool', () => {
  it('uses current online settings and fs policy while preserving sandbox exclusion', async () => {
    const f = fixture();
    expect(f.factory({ ...f.context, sandboxed: true })).toBeNull();
    const tool = f.factory(f.context);
    const signal = new AbortController().signal;
    execution.online.mockResolvedValue({ text: 'result' });
    expect(
      (await tool.execute('call', { audio_path: '/permitted/audio.wav' }, signal)).content[0].text,
    ).toBe('result');
    expect(execution.online.mock.calls[0][2]).toMatchObject({
      signal,
      workspaceDir: '/permitted',
      workspaceOnly: true,
    });
    expect(execution.local).not.toHaveBeenCalled();
    expect(f.context.assertInvocationCurrent).toHaveBeenCalled();
  });
  it('keeps invalid online selection a visible error without using a previous local config', async () => {
    const f = fixture();
    f.setConfig({ mode: 'online' });
    const tool = f.factory(f.context);
    await expect(tool.execute('call', { audio_path: '/permitted/audio.wav' })).rejects.toThrow(
      'online model unavailable',
    );
    expect(execution.local).not.toHaveBeenCalled();
    expect(execution.online).not.toHaveBeenCalled();
    f.setConfig(undefined);
    expect(f.factory(f.context)).toBeNull();
  });
  it('blocks concurrent runs and rejects a retained selection before upload, then releases busy state', async () => {
    const f = fixture();
    const tool = f.factory(f.context);
    let complete!: () => void;
    execution.online.mockImplementationOnce(async (_path, _config, options) => {
      await new Promise<void>(resolve => {
        complete = resolve;
      });
      options.assertCurrent();
      return { text: 'old' };
    });
    const running = tool.execute('first', { audio_path: '/permitted/audio.wav' });
    await expect(tool.execute('second', { audio_path: '/permitted/audio.wav' })).rejects.toThrow(
      'Another transcription',
    );
    f.setConfig({ mode: 'online', baseUrl: 'http://other/v1' });
    complete();
    await expect(running).rejects.toThrow('settings changed');
    execution.online.mockResolvedValueOnce({ text: 'new' });
    await expect(
      tool.execute('third', { audio_path: '/permitted/audio.wav' }),
    ).resolves.toBeDefined();
  });
});
