import { describe, expect, it, vi } from 'vitest';

import { defaultLocalSpeechSettings } from '../../../shared/speech/localSpeechSettings';
import { getLocalAsrStatus } from '../../speech/localAsrService';
import { buildManagedLocalSpeechPluginEntries } from './localSpeechPluginConfig';
import { buildManagedLocalSttConfig } from './localSttConfig';
import { mergeOpenClawPluginConfig } from './openclawConfigSync';
vi.mock('../../speech/localAsrService', async importOriginal => ({
  ...await importOriginal<typeof import('../../speech/localAsrService')>(),
  getLocalAsrStatus: vi.fn().mockReturnValue({ available: true }),
}));
const paths = { executablePath: 'C:\\runtime\\sherpa.exe', modelDir: 'C:\\models\\中文', modelId: defaultLocalSpeechSettings.asrModelId };
describe('local STT configuration', () => {
  it('reuses local models and language even when microphone input is disabled', () => {
    const config = buildManagedLocalSttConfig(defaultLocalSpeechSettings, 'zh', paths);
    expect(config).toMatchObject({ command: paths.executablePath, modelId: paths.modelId, language: 'zh' });
    expect(config?.args).toContain('--sense-voice-language=zh');
    expect(config?.args).toContain('--num-threads=2');
  });
  it('does not advertise a missing model', () => {
    vi.mocked(getLocalAsrStatus).mockReturnValueOnce({ available: false, supported: true, modelId: paths.modelId });
    expect(buildManagedLocalSttConfig(defaultLocalSpeechSettings, 'en', paths)).toBeNull();
  });
  it.each([undefined, false, true])('refreshes speech parameters without choosing enablement (%s)', enabled => {
    const ids = ['stt-local-cli', 'tts-local-cli'];
    const existing = {
      entries: Object.fromEntries(ids.map(id => [id, {
        ...(enabled === undefined ? {} : { enabled }),
        config: { command: 'old' },
      }])),
    };
    const projected = buildManagedLocalSpeechPluginEntries({ command: 'new' }, () => true);
    const merged = mergeOpenClawPluginConfig(existing, projected);
    expect(merged.entries).toMatchObject({
      'stt-local-cli': { config: { command: 'new' } },
      'tts-local-cli': { config: { command: 'old' } },
    });
    for (const id of ids) {
      expect(projected[id] ?? {}).not.toHaveProperty('enabled');
      expect((merged.entries as Record<string, Record<string, unknown>>)[id].enabled).toBe(enabled);
    }
    expect(existing.entries['stt-local-cli'].config.command).toBe('old');
  });

  it('does not admit speech extensions that are not installed', () => {
    expect(buildManagedLocalSpeechPluginEntries(null, () => false)).toEqual({});
  });

  it.each([false, true])('preserves existing speech allowlist admission (%s)', admitted => {
    const allow = ['openai', ...(admitted ? ['stt-local-cli', 'tts-local-cli'] : [])];
    const existing = { allow, deny: ['other-plugin'] };
    const projected = buildManagedLocalSpeechPluginEntries({ command: 'sherpa.exe' }, () => true);

    const merged = mergeOpenClawPluginConfig(existing, projected, ['stt-local-cli', 'tts-local-cli']);

    expect(merged.allow).toEqual(allow);
    expect(merged.deny).toEqual(['other-plugin']);
    expect(merged.entries).toEqual({
      'stt-local-cli': { config: { command: 'sherpa.exe' } },
      'tts-local-cli': {},
    });
  });

  it.each([undefined, []])('preserves enabled TTS when pinning an unrestricted allowlist (%j)', allow => {
    const existing = {
      ...(allow ? { allow } : {}),
      entries: { 'tts-local-cli': { enabled: true } },
    };
    const projected = buildManagedLocalSpeechPluginEntries(null, () => true);

    const merged = mergeOpenClawPluginConfig(existing, projected, ['openai']);

    expect(merged.allow).toEqual(expect.arrayContaining(['tts-local-cli', 'stt-local-cli']));
    expect(merged.entries).toMatchObject({ 'tts-local-cli': { enabled: true } });
  });
});
