import { afterEach, describe, expect, test, vi } from 'vitest';

// The default application suite exercises command parsing without a prepared SDK alias.
vi.mock('openclaw/plugin-sdk/string-coerce-runtime', () => ({
  normalizeOptionalLowercaseString: (value: unknown) =>
    typeof value === 'string' ? value.trim().toLowerCase() || undefined : undefined,
}));

import {
  commandContainsPathUnderRoot,
  isOpenClawBridgeCommand,
  splitCommandParts,
} from '../../../openclaw-extensions/acpx/src/command-line';

afterEach(() => vi.restoreAllMocks());

describe('ACPX process lease command detection', () => {
  test.each(['node.exe', 'bun.exe', process.execPath])(
    'recognizes the Windows %s OpenClaw bridge',
    executable => {
      expect(
        isOpenClawBridgeCommand([executable, 'C:\\Program Files\\OpenClaw\\openclaw.mjs', 'acp']),
      ).toBe(true);
      expect(isOpenClawBridgeCommand([executable, 'C:\\unrelated.mjs', 'acp'])).toBe(false);
      expect(isOpenClawBridgeCommand([executable, 'C:\\openclaw.mjs', 'gateway'])).toBe(false);
    },
  );

  test('preserves raw Windows separators, empty arguments and structured argv', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const argv = [String.raw`C:\Program Files\node.exe`, '', '  keep spaces  '];
    expect(splitCommandParts(argv)).toBe(argv);
    expect(
      splitCommandParts(String.raw`"C:\Program Files\node.exe" "C:\Adapters\peer.mjs" ""`),
    ).toEqual([String.raw`C:\Program Files\node.exe`, String.raw`C:\Adapters\peer.mjs`, '']);
    expect(() => splitCommandParts('node "unterminated')).toThrow('unterminated quote');
  });

  test.each(['codex-acp-wrapper.mjs.evil', '../outside/codex-acp-wrapper.mjs'])(
    'rejects an unverifiable wrapper path %s',
    suffix => {
      expect(
        commandContainsPathUnderRoot({
          command: ['node', `/managed/acpx/${suffix}`],
          root: '/managed/acpx',
          basenames: new Set(['codex-acp-wrapper.mjs']),
        }),
      ).toBe(false);
    },
  );
  test('recognizes a JSON-quoted Windows wrapper argv under the managed root', () => {
    expect(
      commandContainsPathUnderRoot({
        command:
          '"C:\\\\Program Files\\\\nodejs\\\\node.exe" "C:\\\\Users\\\\tester\\\\state\\\\acpx\\\\claude-agent-acp-wrapper.mjs"',
        root: 'C:\\Users\\tester\\state\\acpx',
        basenames: new Set(['claude-agent-acp-wrapper.mjs', 'codex-acp-wrapper.mjs']),
      }),
    ).toBe(true);
  });

  test('rejects a generated wrapper outside the managed root', () => {
    expect(
      commandContainsPathUnderRoot({
        command:
          '"C:\\\\Program Files\\\\nodejs\\\\node.exe" "D:\\\\other\\\\acpx\\\\codex-acp-wrapper.mjs"',
        root: 'C:\\Users\\tester\\state\\acpx',
        basenames: new Set(['claude-agent-acp-wrapper.mjs', 'codex-acp-wrapper.mjs']),
      }),
    ).toBe(false);
  });
});
