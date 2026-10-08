import { describe, expect, it } from 'vitest';

import {
  decodeMulticaBridgeLines,
  encodeMulticaBridgeMessage,
  MULTICA_BRIDGE_PROTOCOL_VERSION,
  parseMulticaBridgeArgv,
  sanitizeMulticaBridgeEnvironment,
  validateMulticaCommandArgv,
} from './multicaBridgeProtocol';

describe('Multica bridge protocol', () => {
  it('accepts the Codex stdio and model discovery contract', () => {
    for (const argv of [
      ['--version'],
      ['debug', 'models'],
      ['debug', 'models', '--bundled'],
      ['app-server', '--listen', 'stdio://'],
    ]) {
      expect(validateMulticaCommandArgv(argv)).toEqual(argv);
      expect(parseMulticaBridgeArgv(['app', '--justdo-multica-bridge', ...argv])).toEqual(argv);
    }
    expect(parseMulticaBridgeArgv(['app', '--version'])).toBeNull();
  });
  it('rejects legacy OpenClaw commands and alternative transports', () => {
    for (const argv of [
      ['agent', '--json'],
      ['agents', 'list', '--json'],
      ['config', 'file'],
      ['app-server', '--listen', 'ws://127.0.0.1'],
      ['debug', 'models', '--unknown'],
    ])
      expect(validateMulticaCommandArgv(argv)).toBeNull();
  });

  it('round-trips newline-delimited messages while retaining a partial frame', () => {
    const frame = encodeMulticaBridgeMessage({
      type: 'exit',
      code: 0,
    });
    const decoded = decodeMulticaBridgeLines(`${frame}{"type":"exit"`);
    expect(decoded.messages).toEqual([{ type: 'exit', code: 0 }]);
    expect(decoded.remainder).toBe('{"type":"exit"');
    expect(MULTICA_BRIDGE_PROTOCOL_VERSION).toBe(4);
  });

  it('forwards task custom env while protecting the JustDo runtime bootstrap', () => {
    expect(
      sanitizeMulticaBridgeEnvironment({
        MULTICA_TOKEN: 'mat_task',
        MULTICA_TASK_ID: 'task-1',
        OPENCLAW_CONFIG_PATH: 'C:\\task\\openclaw.json',
        PATH: 'C:\\multica',
        CUSTOM_ACCESS_TOKEN: 'agent-configured',
        NODE_ENV: 'development',
        NODE_OPTIONS: '--require=untrusted.cjs',
        LD_PRELOAD: '/tmp/untrusted.so',
        DYLD_INSERT_LIBRARIES: '/tmp/untrusted.dylib',
        JUSTDO_ELECTRON_PATH: 'untrusted.exe',
        OPENCLAW_STATE_DIR: 'untrusted-state',
        OPENCLAW_GATEWAY_URL: 'wss://untrusted.example',
        OPENCLAW_GATEWAY_TOKEN: 'untrusted-token',
        OPENCLAW_GATEWAY_PASSWORD: 'untrusted-password',
        OPENCLAW_GATEWAY_PORT: '12345',
      }),
    ).toEqual({
      MULTICA_TOKEN: 'mat_task',
      MULTICA_TASK_ID: 'task-1',
      OPENCLAW_CONFIG_PATH: 'C:\\task\\openclaw.json',
      PATH: 'C:\\multica',
      CUSTOM_ACCESS_TOKEN: 'agent-configured',
    });
  });

  it('rejects malformed timeout values', () => {
    expect(
      validateMulticaCommandArgv([
        'agent',
        '--json',
        '--session-id',
        'one',
        '--timeout',
        'forever',
        '--message',
        'task',
      ]),
    ).toBeNull();
  });
});
