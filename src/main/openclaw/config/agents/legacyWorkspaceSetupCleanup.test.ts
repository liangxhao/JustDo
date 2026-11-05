import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LegacyWorkspaceSetupCleanupError,
  removeLegacyWorkspaceSetupFile,
} from './legacyWorkspaceSetupCleanup';

vi.mock('../../../core/i18n', () => ({
  t: (key: string, params: { path: string }) => `${key}: ${params.path}`,
}));

const LEGACY_FILE = 'openclaw-workspace-state.json';
let temporaryRoot: string;

function withinTemporaryRoot(...parts: string[]): string {
  const target = path.resolve(temporaryRoot, ...parts);
  const relative = path.relative(temporaryRoot, target);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error('Test path is outside its temporary root.');
  }
  return target;
}

function writeWorkspaceFile(workspace: string, filename = LEGACY_FILE): string {
  const file = withinTemporaryRoot(workspace, filename);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `Preserved contents: ${filename}`);
  return file;
}

beforeEach(() => {
  temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-setup-cleanup-test-'));
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  const resolvedRoot = path.resolve(temporaryRoot);
  const relative = path.relative(path.resolve(os.tmpdir()), resolvedRoot);
  if (path.isAbsolute(relative) || !relative || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error('Refusing to remove a test root outside the temporary directory.');
  }
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
});

describe('legacy workspace setup cleanup', () => {
  it('removes only the exact marker in the selected project, including Chinese and spaces', () => {
    const main = writeWorkspaceFile('角色 home');
    const unrelated = writeWorkspaceFile('unrelated');
    const role = path.dirname(main);
    const retainedNames = [
      `${LEGACY_FILE}.doctor-importing`,
      `${LEGACY_FILE}.migrated.backup`,
      `${LEGACY_FILE}.bak`,
      'workspace-state.json',
      'workspace.attested',
      'openclaw.sqlite',
      'AGENTS.md',
      'SOUL.md',
      'BOOTSTRAP.md',
    ];
    const retained = retainedNames.map(name => writeWorkspaceFile('角色 home', name));
    const siblingAttestation = writeWorkspaceFile('', '角色 home.attested');
    const stateAttestation = writeWorkspaceFile('state/workspace-attestations', 'abc.attested');

    removeLegacyWorkspaceSetupFile(role);

    expect(fs.existsSync(main)).toBe(false);
    for (const file of [...retained, siblingAttestation, stateAttestation, unrelated]) {
      expect(fs.readFileSync(file, 'utf8')).toBe(`Preserved contents: ${path.basename(file)}`);
    }
  });

  it('remains idempotent when the marker or project directory is absent', () => {
    const marker = writeWorkspaceFile('project');
    const workspace = path.dirname(marker);
    const unlink = vi.spyOn(fs, 'unlinkSync');
    removeLegacyWorkspaceSetupFile(workspace);
    removeLegacyWorkspaceSetupFile(workspace);
    removeLegacyWorkspaceSetupFile(withinTemporaryRoot('missing'));

    expect(unlink).toHaveBeenCalledTimes(1);
    expect(unlink).toHaveBeenCalledWith(marker);
    expect(console.info).toHaveBeenCalledOnce();
    expect(console.info).toHaveBeenCalledWith(`[OpenClaw] Removed legacy workspace setup file: ${marker}`);
  });

  it('preserves the exact selected directory instead of trimming its path', () => {
    const selectedDirectory = withinTemporaryRoot('project ');
    if (process.platform === 'win32') {
      const inspect = vi.spyOn(fs, 'lstatSync').mockImplementation(() => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      });

      removeLegacyWorkspaceSetupFile(selectedDirectory);

      expect(inspect).toHaveBeenCalledExactlyOnceWith(path.join(selectedDirectory, LEGACY_FILE));
      return;
    }
    const selected = writeWorkspaceFile('project ');
    const neighboring = writeWorkspaceFile('project');

    removeLegacyWorkspaceSetupFile(selectedDirectory);

    expect(fs.existsSync(selected)).toBe(false);
    expect(fs.readFileSync(neighboring, 'utf8')).toBe(`Preserved contents: ${LEGACY_FILE}`);
  });

  it('skips empty paths and rejects relative paths without inspecting the process directory', () => {
    const inspect = vi.spyOn(fs, 'lstatSync');

    removeLegacyWorkspaceSetupFile('');
    removeLegacyWorkspaceSetupFile('  ');
    expect(() => removeLegacyWorkspaceSetupFile('relative-project'))
      .toThrow(LegacyWorkspaceSetupCleanupError);
    expect(() => removeLegacyWorkspaceSetupFile('~/project'))
      .toThrow(LegacyWorkspaceSetupCleanupError);

    expect(inspect).not.toHaveBeenCalled();
  });

  it('preserves a directory with the marker name and reports the exact blocked path', () => {
    const target = withinTemporaryRoot('project', LEGACY_FILE);
    fs.mkdirSync(target, { recursive: true });
    const child = writeWorkspaceFile(path.join('project', LEGACY_FILE), 'retained.txt');

    expect(() => removeLegacyWorkspaceSetupFile(path.dirname(target)))
      .toThrow(`legacyWorkspaceSetupCleanupFailed: ${target}`);

    expect(fs.statSync(target).isDirectory()).toBe(true);
    expect(fs.readFileSync(child, 'utf8')).toBe('Preserved contents: retained.txt');
  });

  it('rejects a symbolic link without following or deleting it', () => {
    const workspace = withinTemporaryRoot('project');
    const outside = withinTemporaryRoot('outside');
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    const preserved = writeWorkspaceFile('outside', 'retained.txt');
    const target = path.join(workspace, LEGACY_FILE);
    fs.symlinkSync(outside, target, process.platform === 'win32' ? 'junction' : 'dir');
    const unlink = vi.spyOn(fs, 'unlinkSync');

    expect(() => removeLegacyWorkspaceSetupFile(workspace))
      .toThrow(LegacyWorkspaceSetupCleanupError);

    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(preserved, 'utf8')).toBe('Preserved contents: retained.txt');
    expect(unlink).not.toHaveBeenCalled();
  });

  it('preserves the marker and original cause when removal is denied', () => {
    const marker = writeWorkspaceFile('project');
    const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => { throw failure; });
    let caught: unknown;

    try {
      removeLegacyWorkspaceSetupFile(path.dirname(marker));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(LegacyWorkspaceSetupCleanupError);
    expect(caught).toMatchObject({
      name: 'LegacyWorkspaceSetupCleanupError',
      message: `legacyWorkspaceSetupCleanupFailed: ${marker}`,
      cause: failure,
    });
    expect(fs.readFileSync(marker, 'utf8')).toBe(`Preserved contents: ${LEGACY_FILE}`);
    expect(console.info).not.toHaveBeenCalled();
  });
});
