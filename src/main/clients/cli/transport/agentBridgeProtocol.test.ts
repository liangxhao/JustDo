import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AGENT_CLI_BRIDGE_SWITCH,
  AGENT_CLI_PROFILE_SWITCH,
} from '../../../../shared/integrations/agentCli';
import {
  AGENT_BRIDGE_PROTOCOL_VERSION,
  decodeAgentBridgeLines,
  encodeAgentBridgeMessage,
  getAgentBridgeEndpoint,
  parseAgentBridgeArgv,
  resolveAgentBridgeProfile,
  selectAgentBridgeEnvironment,
  validateAgentBridgeCommandArgv,
} from './agentBridgeProtocol';

describe('agent bridge protocol', () => {
  it('uses one public parser for CLI, ACP and Codex stdio commands', () => {
    for (const argv of [
      [],
      ['--help'],
      ['--version'],
      ['debug', 'models'],
      ['debug', 'models', '--bundled'],
      ['app-server', '--listen', 'stdio://'],
      ['acp'],
      ['status', '--json'],
      ['models', 'list', '--json'],
      ['exec', '--cwd', '../工程 目录', '--stream-json', '--prompt', 'Inspect\nthen summarize'],
    ]) {
      expect(validateAgentBridgeCommandArgv(argv)).toEqual(argv);
      expect(parseAgentBridgeArgv(['app', AGENT_CLI_BRIDGE_SWITCH, ...argv])).toEqual(argv);
    }
    expect(parseAgentBridgeArgv(['app', '--version'])).toBeNull();
  });

  it('rejects unsupported commands and non-stdio app-server transports', () => {
    for (const argv of [
      ['agent', '--json'],
      ['agents', 'list', '--json'],
      ['config', 'file'],
      ['app-server'],
      ['app-server', '--listen', 'ws://127.0.0.1'],
      ['app-server', '--listen', 'stdio://', '--extra'],
      ['debug', 'models', '--unknown'],
      ['exec', '--json', '--stream-json', 'prompt'],
    ])
      expect(validateAgentBridgeCommandArgv(argv)).toBeNull();
  });

  it('round-trips newline frames while retaining a partial message', () => {
    const frame = encodeAgentBridgeMessage({ type: 'exit', code: 0 });
    const decoded = decodeAgentBridgeLines(`${frame}{"type":"exit"`);
    expect(decoded.messages).toEqual([{ type: 'exit', code: 0 }]);
    expect(decoded.remainder).toBe('{"type":"exit"');
    expect(AGENT_BRIDGE_PROTOCOL_VERSION).toBe(4);
  });

  it('forwards only optional CODEX_HOME for app-server, never ambient credentials', () => {
    const env = {
      CODEX_HOME: path.resolve('client home'),
      MULTICA_TOKEN: 'must-not-forward',
      CUSTOM_ACCESS_TOKEN: 'must-not-forward',
      PATH: 'untrusted',
      NODE_OPTIONS: '--require=untrusted.cjs',
      OPENCLAW_GATEWAY_TOKEN: 'must-not-forward',
    };
    expect(selectAgentBridgeEnvironment(['app-server', '--listen', 'stdio://'], env)).toEqual({
      CODEX_HOME: env.CODEX_HOME,
    });
    for (const argv of [['acp'], ['debug', 'models'], ['exec', 'task'], ['status']])
      expect(selectAgentBridgeEnvironment(argv, env)).toEqual({});
    for (const home of [undefined, '', 'invalid\0directory', 'x'.repeat(32769)])
      expect(selectAgentBridgeEnvironment(['app-server'], { CODEX_HOME: home })).toEqual({});
  });

  it('preserves invalid arguments for local machine-readable errors', () => {
    const argv = ['exec', '--json', '--bad', 'x'];
    expect(parseAgentBridgeArgv(['app', AGENT_CLI_BRIDGE_SWITCH, ...argv])).toEqual(argv);
    expect(validateAgentBridgeCommandArgv(argv)).toBeNull();
  });

  it('binds discovery to launcher bootstrap rather than task arguments', () => {
    const profile = path.resolve('profiles', '独立 目录 $&');
    expect(
      resolveAgentBridgeProfile([
        'app',
        AGENT_CLI_PROFILE_SWITCH,
        profile,
        AGENT_CLI_BRIDGE_SWITCH,
        'acp',
      ]),
    ).toBe(profile);
    expect(
      resolveAgentBridgeProfile([
        'app',
        AGENT_CLI_BRIDGE_SWITCH,
        'exec',
        '--',
        AGENT_CLI_PROFILE_SWITCH,
      ]),
    ).toBeUndefined();
    expect(resolveAgentBridgeProfile(['app', AGENT_CLI_PROFILE_SWITCH, profile])).toBeUndefined();
    expect(resolveAgentBridgeProfile(['app', AGENT_CLI_BRIDGE_SWITCH, 'acp'])).toBeUndefined();
  });

  it('rejects ambiguous or malformed launcher profiles', () => {
    const profile = path.resolve('profiles', 'isolated');
    for (const prefix of [
      [AGENT_CLI_PROFILE_SWITCH],
      [AGENT_CLI_PROFILE_SWITCH, ''],
      [AGENT_CLI_PROFILE_SWITCH, 'relative/profile'],
      [AGENT_CLI_PROFILE_SWITCH, `${profile}\0suffix`],
      [AGENT_CLI_PROFILE_SWITCH, profile, AGENT_CLI_PROFILE_SWITCH, profile],
    ])
      expect(() =>
        resolveAgentBridgeProfile(['app', ...prefix, AGENT_CLI_BRIDGE_SWITCH, 'acp']),
      ).toThrow('Invalid agent bridge profile directory.');
  });

  it('uses a product-neutral endpoint tied to the exact application profile', () => {
    const first = getAgentBridgeEndpoint(path.resolve('profiles', 'one'));
    expect(first).toContain('external-agent-');
    expect(first).toBe(getAgentBridgeEndpoint(path.resolve('profiles', 'one')));
    expect(first).not.toBe(getAgentBridgeEndpoint(path.resolve('profiles', 'two')));
  });
});
