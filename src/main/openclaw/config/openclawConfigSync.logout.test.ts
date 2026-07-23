import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';

import { BuiltinModelSyncReason } from '../../../shared/builtinModels';
import {
  OpenClawConfigSync,
  type OpenClawConfigSyncResult,
} from './openclawConfigSync';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const writeExistingBuiltinConfig = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-auth-logout-config-'));
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, 'openclaw.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      gateway: { mode: 'local' },
      models: {
        providers: {
          builtin_models: {
            apiKey: '${JUSTDO_APIKEY_BUILTIN_MODELS}',
            baseUrl: 'http://127.0.0.1:4000/v1',
          },
        },
      },
      agents: {
        defaults: {
          model: { primary: 'builtin_models/chat-model' },
          timeoutSeconds: 120,
        },
        list: [
          {
            id: 'main',
            default: true,
            model: { primary: 'builtin_models/chat-model' },
            reasoningDefault: 'stream',
          },
        ],
      },
      plugins: {
        entries: {
          custom_plugin: {
            enabled: true,
            config: { mode: 'keep-me' },
          },
        },
      },
      skills: {
        entries: {
          docx: { enabled: false },
        },
      },
    }),
    'utf8',
  );
  return configPath;
};

const writeMinimalConfig = (configPath: string, reason: string): OpenClawConfigSyncResult => {
  const sync = new OpenClawConfigSync({
    engineManager: {
      getDesiredVersion: () => '2026.6.11',
    },
    getCoworkConfig: () => ({}),
  } as never);
  return (
    sync as unknown as {
      writeMinimalConfig: (path: string, syncReason: string) => OpenClawConfigSyncResult;
    }
  ).writeMinimalConfig(configPath, reason);
};

describe('OpenClaw auth logout config sync', () => {
  test('removes the built-in provider placeholder before its environment variable is revoked', () => {
    const configPath = writeExistingBuiltinConfig();

    const result = writeMinimalConfig(configPath, BuiltinModelSyncReason.AuthLogout);

    expect(result.ok).toBe(true);
    const content = fs.readFileSync(configPath, 'utf8');
    expect(content).not.toContain('JUSTDO_APIKEY_BUILTIN_MODELS');
    const config = JSON.parse(content);
    expect(config.models.providers).toBeUndefined();
    expect(config.agents.defaults.model).toBeUndefined();
    expect(config.agents.defaults.memorySearch).toEqual({ enabled: false });
    expect(config.agents.defaults.timeoutSeconds).toBe(120);
    expect(config.agents.list).toEqual([
      {
        id: 'main',
        default: true,
        reasoningDefault: 'stream',
      },
    ]);
    expect(config.plugins.entries.custom_plugin).toEqual({
      enabled: true,
      config: { mode: 'keep-me' },
    });
    expect(config.skills.entries.docx).toEqual({ enabled: false });
  });

  test('keeps the existing preservation behavior for non-logout minimal syncs', () => {
    const configPath = writeExistingBuiltinConfig();

    const result = writeMinimalConfig(configPath, BuiltinModelSyncReason.ManualRefresh);

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(configPath, 'utf8')).toContain('JUSTDO_APIKEY_BUILTIN_MODELS');
  });
});
