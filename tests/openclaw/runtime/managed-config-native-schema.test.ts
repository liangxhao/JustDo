import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

import { OpenClawConfigSync } from '../../../src/main/openclaw/config/openclawConfigSync';
import { OPENCLAW_MANAGED_TOOL_DENY } from '../../../src/main/openclaw/config/policies/executionPolicyProjection';
import type { ManagedSpeechModelSettings } from '../../../src/main/openclaw/config/speech/speechModelConfig';
import { clearActiveBuiltinModelCredential, setActiveBuiltinModelCredential } from '../../../src/main/providers/builtinModelCredential';
import { setStoreGetter } from '../../../src/main/providers/providerApiConfig';
import { BrowserMode } from '../../../src/shared/browser/browser';
import { BuiltinModelSyncReason } from '../../../src/shared/providers/builtinModels';
import { defaultLocalSpeechExtensionSettings } from '../../../src/shared/speech/localSpeechExtensionSettings';
import { defaultLocalSpeechSettings } from '../../../src/shared/speech/localSpeechSettings';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd(),
  getPath: () => path.resolve('build/managed-schema-isolated-user-data'),
} }));
vi.mock('../../../src/main/openclaw/runtime/launch/electronNodeRuntime', () => ({
  getElectronNodeRuntimePath: () => process.execPath,
}));
// Only the product inventory and Electron shell are fixtures. Projection, persisted JSON,
// target OpenClawSchema and native load-time legacy detection execute without replacements.
vi.mock('../../../src/main/plugins/extensions/openclawLocalExtensions', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../src/main/plugins/extensions/openclawLocalExtensions')>();
  const ids = ['browser', 'workboard', 'memory-core', 'code-mode-quickjs', 'openai', 'mxc',
    'document-extract', 'web-readability', 'tts-local-cli'];
  return { ...actual,
    listBundledOpenClawExtensionIds: () => ids,
    inspectBundledOpenClawExtensions: () => ({ complete: true, ids }),
    hasBundledOpenClawExtension: (id: string) => ids.includes(id) || actual.listLocalOpenClawExtensionIds().includes(id),
  };
});

const runtime = path.resolve(process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR ??
  'build/runtimes/openclaw/win-x64');
const targetVersion = `v${JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')).openclaw.version.replace(/^v/u, '')}`;
const executable = path.join(runtime, 'node-runtime', process.platform === 'win32' ? 'node.exe' : 'bin/node');
const nativeAvailable = fs.existsSync(executable) && fs.existsSync(path.join(runtime, 'gateway.asar'));
const required = process.env.OPENCLAW_REQUIRE_MANAGED_CONFIG_CONTRACTS === '1';
if ((required || process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR) && !nativeAvailable)
  throw new Error('The explicitly required immutable config-validation runtime is unavailable.');

const directories: string[] = [];
const temporary = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-config-schema-'));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  clearActiveBuiltinModelCredential();
  setStoreGetter(() => null);
  for (const directory of directories.splice(0)) {
    expect(path.dirname(directory)).toBe(os.tmpdir());
    expect(path.basename(directory)).toMatch(/^managed-config-schema-/);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
type Assessment = {
  label: string; schemaSuccess: boolean; schemaIssues: { path: string; keys?: string[] }[];
  legacyIssues: { path: string; message: string }[];
};
function assess(cases: { label: string; config: unknown }[]): Assessment[] {
  const directory = temporary();
  const input = path.join(directory, 'cases.json');
  fs.writeFileSync(input, JSON.stringify(cases));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^OPENCLAW_/i.test(name) && !/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE)$/i.test(name)));
  const output = execFileSync(executable, [
    path.resolve('tests/openclaw/runtime/managed-config-validation.native-probe.mjs'), runtime, input,
  ], { encoding: 'utf8', windowsHide: true, timeout: 60_000,
    env: { ...env, OPENCLAW_HOME: directory, OPENCLAW_STATE_DIR: directory,
      OPENCLAW_CONFIG_PATH: path.join(directory, 'openclaw.json') } });
  const line = output.split(/\r?\n/).find(value => value.startsWith('NATIVE_MANAGED_CONFIG='));
  expect(line).toBeDefined();
  const parsed = JSON.parse(line!.slice('NATIVE_MANAGED_CONFIG='.length));
  expect(parsed.identity.version).toBe(targetVersion);
  expect(parsed.identity.nodeVersion).toBe('v24.22.1');
  return parsed.results;
}
function retainedConfig(canonicalVoice: boolean) {
  return {
    agents: { ownership: 'explicit', entries: { main: {} } },
    tools: { deny: ['web_search', 'tts', 'skill_workshop'], fs: { workspaceOnly: true }, exec: { mode: 'ask' } },
    transcripts: { enabled: true, autoStart: [
      { providerId: 'discord-voice', guildId: 'guild', channelId: 'voice' },
    ] },
    skills: { entries: { 'private-skill': { enabled: false } },
      workshop: { approvalPolicy: 'manual', maxPending: 12, autonomous: { mode: 'auto' }, maxSkillBytes: 60_000 } },
    plugins: { entries: { 'agent-team': { enabled: false }, 'swarm-workflow': { enabled: false },
      'stt-local-cli': { enabled: false }, 'tts-local-cli': { enabled: false } } },
    cron: { skipMissedJobs: false },
    tts: { auto: 'off', enabled: true, provider: 'openai',
      maxTextLength: 1400, timeoutMs: 25_000,
      providers: { openai: { baseUrl: 'http://speech.example.test/v1', model: 'internal-speech',
        voice: 'obsolete-voice', voiceName: 'obsolete-name', voiceId: 'obsolete-id',
        ...(canonicalVoice ? { speakerVoice: 'chosen-current', speakerVoiceId: 'current-id' } : {}) } },
      personas: { narrator: { label: 'Retained narrator', providers: { openai: {
        voice: 'obsolete-persona', ...(canonicalVoice ? { speakerVoice: 'current-narrator' } : {}),
      } } } },
    },
  };
}
const nativeTest = test.skipIf(!nativeAvailable);
nativeTest('real schema alone accepts TTS legacy keys, while the actual load-time detector refuses every retired input', () => {
  const base = { agents: { ownership: 'explicit', entries: { main: {} } } };
  const cases = [
    { label: 'current canonical', config: { ...base, tts: { auto: 'off', provider: 'openai',
      providers: { openai: { speakerVoice: 'current' } } } } },
    { label: 'approvalPolicy', config: { ...base, skills: { workshop: { approvalPolicy: 'manual' } } } },
    { label: 'maxPending', config: { ...base, skills: { workshop: { maxPending: 12 } } } },
    { label: 'tts.enabled', config: { ...base, tts: { enabled: true } } },
    ...['voice', 'voiceName', 'voiceId'].map(key => ({ label: 'provider.' + key,
      config: { ...base, tts: { providers: { openai: { [key]: 'obsolete' } } } } })),
    ...['voice', 'voiceName', 'voiceId'].map(key => ({ label: 'persona.' + key,
      config: { ...base, tts: { personas: { narrator: { providers: { openai: { [key]: 'obsolete' } } } } } } })),
  ];
  const results = assess(cases);
  expect(results[0]).toMatchObject({ schemaSuccess: true, legacyIssues: [] });
  for (const result of results.slice(1, 3)) {
    expect(result.schemaSuccess).toBe(false);
    expect(result.schemaIssues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'skills.workshop', keys: expect.arrayContaining([result.label]) }),
    ]));
  }
  for (const result of results.slice(3)) {
    expect(result.schemaSuccess, result.label).toBe(true);
    expect(result.legacyIssues, result.label).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'tts', message: expect.stringMatching(/legacy/) }),
    ]));
  }
}, 90_000);

nativeTest('persisted login, logout and minimal startup projections prune obsolete keys without migrating their values or changing unrelated state', () => {
  const cases: { label: string; config: unknown }[] = [];
  for (const mode of ['full-login', 'full-logout', 'minimal-logout', 'minimal-startup'] as const) {
    for (const canonicalVoice of [false, true]) {
      clearActiveBuiltinModelCredential();
      const directory = temporary();
      const configPath = path.join(directory, 'openclaw.json');
      const existing = retainedConfig(canonicalVoice);
      fs.writeFileSync(configPath, JSON.stringify(existing));
      if (mode === 'full-login') {
        const now = Math.floor(Date.now() / 1000);
        const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
        setActiveBuiltinModelCredential({
          accessToken: [encode({ alg: 'RS256', kid: 'fixture' }), encode({
            iss: 'https://login.example.test', aud: 'justdo-litellm', sub: 'schema@example.test',
            iat: now, exp: now + 300, jti: 'schema-fixture',
          }), 'fixture-signature'].join('.'),
          userAccount: 'schema@example.test', expiresAt: now + 300,
        });
      }
      const providerId = mode === 'full-login' ? 'builtin_models' : 'custom-provider';
      const appConfig = mode.startsWith('full') ? {
        model: { defaultModel: 'chat-fixture', defaultModelProvider: providerId },
        providers: { [providerId]: { enabled: true, apiKey: mode === 'full-login' ? '' : 'synthetic-custom-key',
          baseUrl: 'http://models.example.test/v1', apiFormat: 'openai',
          models: [{ id: 'chat-fixture' }] } },
      } : {};
      setStoreGetter(() => ({ get: () => appConfig }) as never);
      const sync = new OpenClawConfigSync({
        engineManager: { getConfigPath: () => configPath, getStateDir: () => directory,
          getDesiredVersion: () => targetVersion.slice(1) },
        getCoworkConfig: () => ({ workingDirectory: path.join(directory, '工作目录 with spaces'),
          executionMode: 'local', agentEngine: 'openclaw' }),
        getAgents: () => [], getBrowserMode: () => BrowserMode.User,
        getSpeechOutputState: () => ({ enabled: true, mode: 'online' }),
      } as never);
      const reason = mode === 'full-login' ? BuiltinModelSyncReason.AuthLogin
        : mode === 'minimal-startup' ? 'startup' : BuiltinModelSyncReason.AuthLogout;
      expect(sync.sync(reason), mode).toMatchObject({ ok: true });
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      expect(config.skills.workshop, mode).toEqual({ autonomous: { mode: 'auto' }, maxSkillBytes: 60_000 });
      expect(config.skills.entries['private-skill']).toEqual({ enabled: false });
      expect(config.plugins.entries['agent-team'].enabled).toBe(false);
      expect(config.plugins.entries['swarm-workflow'].enabled).toBe(false);
      expect(config.plugins.entries['stt-local-cli'].enabled).toBe(false);
      expect(config.plugins.entries['tts-local-cli'].enabled).toBe(false);
      expect(config.tools.deny).toContain('web_search');
      expect(config.tools.deny).toEqual([...OPENCLAW_MANAGED_TOOL_DENY, 'computer']);
      expect(config.transcripts).toEqual({ enabled: false });
      expect(config.tools.fs.workspaceOnly).toBe(true);
      expect(config.tools.exec.mode).toBe('ask');
      expect(config.cron.skipMissedJobs).toBe(false);
      expect(config.agents.defaults.embeddedAgent.cyberFailover.mode).toBe('off');
      expect(config.tts).toMatchObject({ auto: 'off', provider: 'openai',
        maxTextLength: 1400, timeoutMs: 25_000 });
      expect(config.tts).not.toHaveProperty('enabled');
      const selected = config.tts.providers.openai;
      expect(selected).toMatchObject({ baseUrl: 'http://speech.example.test/v1', model: 'internal-speech' });
      for (const key of ['voice', 'voiceName', 'voiceId']) {
        expect(selected).not.toHaveProperty(key);
        expect(config.tts.personas.narrator.providers.openai).not.toHaveProperty(key);
      }
      expect(selected.speakerVoice).toBe(canonicalVoice ? 'chosen-current' : undefined);
      expect(selected.speakerVoiceId).toBe(canonicalVoice ? 'current-id' : undefined);
      expect(config.tts.personas.narrator.label).toBe('Retained narrator');
      expect(config.tts.personas.narrator.providers.openai.speakerVoice).toBe(canonicalVoice ? 'current-narrator' : undefined);
      if (mode === 'full-login') {
        expect(config.models.providers.builtin_models.apiKey).toEqual({ source: 'exec', provider: 'justdo_login', id: 'X-ACCESS-JWT' });
        expect(config.agents.defaults.model.primary).toBe('builtin_models/chat-fixture');
      } else {
        expect(config.models.providers?.builtin_models).toBeUndefined();
        if (mode === 'full-logout') {
          expect(config.models.providers['custom-provider']).toBeDefined();
          expect(config.agents.defaults.model.primary).toBe('custom-provider/chat-fixture');
        }
      }
      // Replaying configuration synchronization is observation/projection, not a model or file mutation RPC.
      expect(sync.sync(reason).ok).toBe(true);
      expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual(config);
      cases.push({ label: mode + (canonicalVoice ? ' canonical voice retained' : ' obsolete voice not promoted'), config });
    }
  }
  for (const result of assess(cases)) {
    expect(result.schemaSuccess, result.label + ': ' + JSON.stringify(result.schemaIssues)).toBe(true);
    expect(result.legacyIssues, result.label).toEqual([]);
  }
}, 120_000);

nativeTest('production speech projections remove the invalid preferences key before full or minimal startup admission', () => {
  const cases: { label: string; config: unknown }[] = [];
  for (const mode of ['full-login', 'full-logout', 'minimal-logout', 'minimal-startup'] as const) {
    clearActiveBuiltinModelCredential();
    const directory = temporary();
    const configPath = path.join(directory, 'openclaw.json');
    const existing = retainedConfig(true);
    Object.assign(existing.tts, { prefsPath: path.join(directory, 'previous-invalid-preferences.json') });
    fs.writeFileSync(configPath, JSON.stringify(existing));
    if (mode === 'full-login') {
      const now = Math.floor(Date.now() / 1000);
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      setActiveBuiltinModelCredential({
        accessToken: [encode({ alg: 'RS256', kid: 'fixture' }), encode({
          iss: 'https://login.example.test', aud: 'justdo-litellm', sub: 'schema@example.test',
          iat: now, exp: now + 300, jti: 'speech-schema-fixture',
        }), 'fixture-signature'].join('.'),
        userAccount: 'schema@example.test', expiresAt: now + 300,
      });
    }
    const providerId = mode === 'full-login' ? 'builtin_models' : 'custom-provider';
    const appConfig = mode.startsWith('full') ? {
      model: { defaultModel: 'chat-fixture', defaultModelProvider: providerId },
      providers: { [providerId]: { enabled: true, apiKey: mode === 'full-login' ? '' : 'synthetic-key',
        baseUrl: 'http://models.example.test/v1', apiFormat: 'openai', models: [{ id: 'chat-fixture' }] } },
    } : {};
    setStoreGetter(() => ({ get: () => appConfig }) as never);
    const online = mode !== 'minimal-startup';
    const missing = mode === 'minimal-logout';
    const speech: ManagedSpeechModelSettings = {
      language: 'zh',
      extensions: { ...defaultLocalSpeechExtensionSettings,
        sttMode: online ? 'online' : 'local', onlineSttModelRef: 'internal/asr',
        ttsMode: online ? 'online' : 'local', onlineTtsModelRef: 'internal/tool', onlineTtsVoice: 'tool-voice' },
      voice: { ...defaultLocalSpeechSettings, synthesisMode: online ? 'online' : 'local',
        onlineTtsModelRef: 'internal/tool', onlineTtsVoice: 'tool-voice' },
      recognitionModels: { providers: missing ? {} : { internal: { displayName: 'Internal ASR',
        baseUrl: 'http://asr.example.test/v1', apiKey: '', models: [{ id: 'asr', name: 'ASR' }] } } },
      synthesisModels: { providers: missing ? {} : { internal: { displayName: 'Internal speech',
        baseUrl: 'http://tts.example.test/v1', apiKey: mode === 'full-login' ? 'synthetic-speech-key' : '',
        models: [{ id: 'tool', name: 'Speech', voices: [{ id: 'tool-voice', name: 'Voice' }] }] } } },
    };
    const sync = new OpenClawConfigSync({
      engineManager: { getConfigPath: () => configPath, getStateDir: () => directory,
        getDesiredVersion: () => targetVersion.slice(1) },
      getCoworkConfig: () => ({ workingDirectory: path.join(directory, 'project'), executionMode: 'local', agentEngine: 'openclaw' }),
      getAgents: () => [], getBrowserMode: () => BrowserMode.User,
      getSpeechOutputState: () => ({ enabled: false, mode: 'local' }),
      getSpeechModelSettings: () => speech,
    } as never);
    const reason = mode === 'full-login' ? BuiltinModelSyncReason.AuthLogin
      : mode === 'minimal-startup' ? 'startup' : BuiltinModelSyncReason.AuthLogout;
    expect(sync.sync(reason), mode).toMatchObject({ ok: true });
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.tts, mode).not.toHaveProperty('prefsPath');
    expect(config.tts).toMatchObject({ auto: 'off', provider: 'tts-local-cli', persona: 'assistant-speech',
      personas: { 'assistant-speech': { provider: 'tts-local-cli', fallbackPolicy: 'fail' } } });
    expect(config.plugins.entries['stt-local-cli'].enabled).toBe(false);
    expect(config.plugins.entries['tts-local-cli'].enabled).toBe(false);
    cases.push({ label: mode + ' actual speech projection', config });
  }
  for (const result of assess(cases)) {
    expect(result.schemaSuccess, result.label + ': ' + JSON.stringify(result.schemaIssues)).toBe(true);
    expect(result.legacyIssues, result.label).toEqual([]);
  }
}, 120_000);
