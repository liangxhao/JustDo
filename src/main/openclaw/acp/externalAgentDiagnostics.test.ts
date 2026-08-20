import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildBundledAdapterCommand,
  buildExternalAgentConnectionTestArgs,
  resolveAcpxCliPath,
  resolveInstalledClaudeExecutable,
  sanitizeExternalAgentDiagnostic,
} from './externalAgentDiagnostics';

describe('external agent diagnostics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds a session bootstrap test without prompting the model', () => {
    const args = buildExternalAgentConnectionTestArgs(
      'C:\\runtime\\acpx\\cli.js',
      'codex',
      'C:\\projects\\demo',
      'justdo-test-session',
      '"C:/runtime/codex-acp.exe" -c "service_tier=fast"',
    );

    expect(args).toEqual(
      expect.arrayContaining([
        '--auth-policy',
        'skip',
        '--deny-all',
        '--non-interactive-permissions',
        'deny',
        '--no-terminal',
        '--agent',
        '"C:/runtime/codex-acp.exe" -c "service_tier=fast"',
        'sessions',
        'new',
      ]),
    );
    expect(args[0]).toBe('C:\\runtime\\acpx\\cli.js');
    expect(args).toContain('C:\\projects\\demo');
    expect(args).not.toContain('exec');
    expect(args).not.toContain('--max-turns');
    expect(args.at(-1)).toBe('justdo-test-session');
  });

  it('uses the bundled Codex adapter with a compatible service tier override', () => {
    const runtimeRoot = path.join('C:', 'runtime', 'openclaw');
    const adapterBin = path.join(
      runtimeRoot,
      'dist',
      'extensions',
      'acpx',
      'node_modules',
      '@zed-industries',
      'codex-acp',
      'bin',
      'codex-acp.js',
    );
    vi.spyOn(fs, 'existsSync').mockImplementation(value => value === adapterBin);

    const command = buildBundledAdapterCommand(
      {
        openclawEntry: path.join(runtimeRoot, 'openclaw.mjs'),
        env: { JUSTDO_ELECTRON_PATH: 'C:\\Program Files\\App\\electron.exe' },
        runtimeRoot,
        port: 18789,
        token: 'test-token',
      },
      'codex',
    );

    expect(command).toContain('C:/Program Files/App/electron.exe');
    expect(command).toContain('codex-acp.js');
    expect(command).toContain('service_tier=\\\"fast\\\"');
  });

  it('prefers a native Claude executable from PATH', () => {
    const claudeExecutable = path.join('C:', 'Users', 'person', '.local', 'bin', 'claude.exe');
    vi.spyOn(fs, 'existsSync').mockImplementation(value => value === claudeExecutable);

    expect(
      resolveInstalledClaudeExecutable(
        { PATH: `${path.join('C:', 'tools')};${path.dirname(claudeExecutable)}` },
        'win32',
      ),
    ).toBe(claudeExecutable);
  });

  it('resolves acpx beside the prepared runtime entry', () => {
    const openclawEntry = path.join('C:', 'runtime', 'openclaw', 'openclaw.mjs');

    expect(
      resolveAcpxCliPath({
        openclawEntry,
        env: {},
        runtimeRoot: path.dirname(openclawEntry),
        port: 18789,
        token: 'test-token',
      }),
    ).toBe(
      path.join(
        path.dirname(openclawEntry),
        'dist',
        'extensions',
        'acpx',
        'node_modules',
        'acpx',
        'dist',
        'cli.js',
      ),
    );
  });

  it('redacts workspace paths and common credentials from diagnostics', () => {
    const workspace = 'C:\\Users\\person\\project';
    const sanitized = sanitizeExternalAgentDiagnostic(
      `failed in ${workspace}; token=secret-value; https://name:password@example.com`,
      workspace,
    );

    expect(sanitized).toContain('<workspace>');
    expect(sanitized).toContain('token=***');
    expect(sanitized).toContain('https://***:***@example.com');
    expect(sanitized).not.toContain('secret-value');
    expect(sanitized).not.toContain('person');
    expect(sanitized).not.toContain('password');
  });
});
