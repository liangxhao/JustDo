import { describe, expect, it } from 'vitest';

import { formatAgentCliHelp, parseAgentCliArguments, usesAgentCliMachineOutput } from './agentCli';

describe('agent CLI syntax', () => {
  it('supports offline help and version aliases and the stdio ACP entry', () => {
    for (const argv of [[], ['help'], ['--help'], ['-h']]) {
      expect(parseAgentCliArguments(argv)).toEqual({ kind: 'help' });
    }
    expect(parseAgentCliArguments(['--version'])).toEqual({ kind: 'version' });
    expect(parseAgentCliArguments(['-V'])).toEqual({ kind: 'version' });
    expect(parseAgentCliArguments(['acp'])).toEqual({ kind: 'acp' });
    expect(parseAgentCliArguments(['app-server', '--listen', 'stdio://'])).toEqual({
      kind: 'app-server',
    });
    expect(parseAgentCliArguments(['debug', 'models'])).toEqual({ kind: 'codex-models' });
    expect(parseAgentCliArguments(['debug', 'models', '--bundled'])).toEqual({
      kind: 'codex-models',
    });
    expect(parseAgentCliArguments(['status'])).toEqual({ kind: 'status', format: 'text' });
    expect(parseAgentCliArguments(['models', 'list', '--json'])).toEqual({
      kind: 'models',
      format: 'json',
    });
  });

  it('preserves multiline prompts and directories for Main to resolve and authorize', () => {
    expect(
      parseAgentCliArguments([
        'exec',
        '--cwd',
        '../工程 目录',
        '--session',
        'session-1',
        '--model',
        'provider/model',
        '--stream-json',
        '--prompt',
        'Inspect the project.\nThen summarize.',
      ]),
    ).toEqual({
      kind: 'exec',
      cwd: '../工程 目录',
      sessionId: 'session-1',
      modelRef: 'provider/model',
      format: 'stream-json',
      prompt: 'Inspect the project.\nThen summarize.',
    });
    expect(parseAgentCliArguments(['exec', 'Review this'])).toEqual({
      kind: 'exec',
      format: 'text',
      prompt: 'Review this',
    });
    expect(parseAgentCliArguments(['exec', '--json', '--', '--a literal prompt'])).toEqual({
      kind: 'exec',
      format: 'json',
      prompt: '--a literal prompt',
    });
  });

  it.each([
    ['acp', '--json'],
    ['app-server'],
    ['app-server', '--listen', 'ws://localhost'],
    ['app-server', '--listen', 'stdio://', '--json'],
    ['debug', 'models', '--unknown'],
    ['status', '--stream-json'],
    ['models'],
    ['models', 'list', '--unknown'],
    ['exec'],
    ['exec', '--prompt', ''],
    ['exec', '--cwd', '  ', 'prompt'],
    ['exec', '--json', '--stream-json', 'prompt'],
    ['exec', '--json', '--json', 'prompt'],
    ['exec', '--prompt', 'one', 'two'],
    ['exec', 'one', 'two'],
    ['exec', '--model', 'a', '--model', 'b', 'prompt'],
    ['exec', '--unknown', 'prompt'],
    ['exec', 'prompt\0secret'],
    ['exec', '--prompt'],
    ['exec', '--', 'one', 'two'],
  ])('rejects ambiguous or unsupported input: %j', (...argv) => {
    expect(parseAgentCliArguments(argv)).toBeNull();
  });

  it('does not mistake option values or literal prompt contents for JSON output flags', () => {
    expect(usesAgentCliMachineOutput(['exec', '--prompt', '--json'])).toBe(false);
    expect(usesAgentCliMachineOutput(['exec', '--', '--json'])).toBe(false);
    expect(usesAgentCliMachineOutput(['exec', '--json', '--', '--prompt'])).toBe(true);
    expect(usesAgentCliMachineOutput(['status', '--json'])).toBe(true);
    expect(usesAgentCliMachineOutput(['exec', '--unknown', '--stream-json'])).toBe(true);
  });

  it('formats help from external branding in both supported languages', () => {
    for (const language of ['en', 'zh'] as const) {
      const help = formatAgentCliHelp('Acme', language);
      expect(help).toContain('acme-cli');
      expect(help).toContain('models list [--json]');
      expect(help).toContain('--session <id>');
      expect(help).toContain('acp');
      expect(help).toContain('app-server --listen stdio://');
      expect(help).toContain('debug models [--bundled]');
      expect(help).not.toContain('Multica');
    }
    expect(formatAgentCliHelp('Acme', 'zh')).toContain('桌面后台服务');
  });
});
