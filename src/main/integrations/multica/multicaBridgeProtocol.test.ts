import { describe, expect, test } from 'vitest';

import {
  decodeBridgeLines,
  parseMulticaBridgeArgv,
  sanitizeMulticaBridgeEnvironment,
} from './multicaBridgeProtocol';

describe('Multica bridge protocol', () => {
  test('accepts only the OpenClaw command shapes Multica uses', () => {
    expect(parseMulticaBridgeArgv(['JustDo.exe', '--version'], true)).toEqual(['--version']);
    expect(parseMulticaBridgeArgv(['JustDo.exe', 'config', 'file'], true)).toEqual([
      'config',
      'file',
    ]);
    expect(
      parseMulticaBridgeArgv(['JustDo.exe', '--justdo-multica-bridge', 'config', 'file'], true),
    ).toEqual(['config', 'file']);
    expect(
      parseMulticaBridgeArgv(
        [
          'JustDo.exe',
          'agent',
          '--local',
          '--json',
          '--session-id',
          'multica-1',
          '--message',
          'hello',
        ],
        true,
      ),
    ).not.toBeNull();
    expect(
      parseMulticaBridgeArgv(
        [
          'JustDo.exe',
          '--justdo-multica-bridge',
          'agent',
          '--local',
          '--json',
          '--session-id',
          'multica-1',
          '--message',
          'first line\nsecond line',
        ],
        true,
      ),
    ).toEqual([
      'agent',
      '--local',
      '--json',
      '--session-id',
      'multica-1',
      '--message',
      'first line\nsecond line',
    ]);
    expect(parseMulticaBridgeArgv(['JustDo.exe', 'gateway', 'start'], true)).toBeNull();
    expect(parseMulticaBridgeArgv(['electron.exe', '--version'], false)).toBeNull();
    expect(
      parseMulticaBridgeArgv(['electron.exe', '.', '--justdo-multica-bridge', '--version'], false),
    ).toEqual(['--version']);
    expect(
      parseMulticaBridgeArgv(
        ['electron.exe', '.', '--justdo-multica-bridge', 'gateway', 'start'],
        false,
      ),
    ).toBeNull();
  });

  test('rejects line breaks and filters inherited environment variables', () => {
    expect(
      parseMulticaBridgeArgv(['JustDo.exe', 'config', 'get\nunsafe', '--json'], true),
    ).toBeNull();
    expect(
      parseMulticaBridgeArgv(
        [
          'JustDo.exe',
          'agent',
          '--local',
          '--json',
          '--session-id',
          'multica-1\nunsafe',
          '--message',
          'allowed\nmessage',
        ],
        true,
      ),
    ).toBeNull();
    expect(
      sanitizeMulticaBridgeEnvironment({
        OPENCLAW_CONFIG_PATH: 'C:\\配置 目录\\openclaw.json',
        OPENCLAW_INCLUDE_ROOTS: 'C:\\one;C:\\two',
        OPENCLAW_GATEWAY_TOKEN: 'must-not-cross',
      }),
    ).toEqual({
      OPENCLAW_CONFIG_PATH: 'C:\\配置 目录\\openclaw.json',
      OPENCLAW_INCLUDE_ROOTS: 'C:\\one;C:\\two',
    });
  });

  test('decodes split NDJSON frames without changing payload bytes', () => {
    const first = decodeBridgeLines('{"type":"stdout","data":"5Lit5paH"}\n{"type"');
    expect(first.messages).toEqual([{ type: 'stdout', data: '5Lit5paH' }]);
    expect(first.remainder).toBe('{"type"');
  });
});
