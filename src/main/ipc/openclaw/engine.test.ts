import { describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

import { getOpenClawTerminalEnvKeys } from './engine';

describe('OpenClaw terminal environment', () => {
  test('passes the managed Python user base but excludes unrelated host values', () => {
    const keys = getOpenClawTerminalEnvKeys({
      PATH: 'C:\\Windows',
      PYTHONUSERBASE: 'C:\\Users\\test\\AppData\\Roaming\\JustDo\\runtimes\\python-user',
      JUSTDO_MANAGED_PYTHON_USER_BASE:
        'C:\\Users\\test\\AppData\\Roaming\\JustDo\\runtimes\\python-user',
      UNRELATED_HOST_VALUE: 'blocked',
    });

    expect(keys).toContain('PYTHONUSERBASE');
    expect(keys).not.toContain('JUSTDO_MANAGED_PYTHON_USER_BASE');
    expect(keys).not.toContain('UNRELATED_HOST_VALUE');
  });

  test.each([
    ['missing provenance', undefined],
    ['mismatched provenance', 'C:\\untrusted\\python-user'],
    ['empty provenance', ''],
  ])('excludes a host Python user base with %s', (_label, provenance) => {
    const keys = getOpenClawTerminalEnvKeys({
      PATH: 'C:\\Windows',
      PYTHONUSERBASE: 'C:\\host\\python-user',
      ...(provenance === undefined
        ? {}
        : { JUSTDO_MANAGED_PYTHON_USER_BASE: provenance }),
    });

    expect(keys).not.toContain('PYTHONUSERBASE');
    expect(keys).not.toContain('JUSTDO_MANAGED_PYTHON_USER_BASE');
  });

  test('excludes a lowercase provenance lookalike', () => {
    const keys = getOpenClawTerminalEnvKeys({
      PATH: 'C:\\Windows',
      PYTHONUSERBASE: 'C:\\host\\python-user',
      justdo_managed_python_user_base: 'C:\\host\\python-user',
    });

    expect(keys).not.toContain('PYTHONUSERBASE');
    expect(keys).not.toContain('justdo_managed_python_user_base');
  });
});
