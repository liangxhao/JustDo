import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import * as portableGitRuntime from '../runtime/portableGitRuntime';
import { ensureProjectGitRepository } from './projectGit';

let fixtureRoot: string;
let gitEnv: NodeJS.ProcessEnv;

function createDirectory(name: string): string {
  const directory = path.join(fixtureRoot, name);
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function git(args: string[], cwd = fixtureRoot): string {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', windowsHide: true });
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-project-git-'));
  const globalConfig = path.join(fixtureRoot, 'empty.gitconfig');
  fs.writeFileSync(globalConfig, '');
  gitEnv = { ...process.env };
  for (const key of Object.keys(gitEnv)) {
    if (/^GIT_/i.test(key)) delete gitEnv[key];
  }
  gitEnv.GIT_CONFIG_NOSYSTEM = '1';
  gitEnv.GIT_CONFIG_GLOBAL = globalConfig;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  const resolvedRoot = path.resolve(fixtureRoot);
  if (
    path.dirname(resolvedRoot) !== path.resolve(os.tmpdir()) ||
    !path.basename(resolvedRoot).startsWith('justdo-project-git-')
  ) {
    throw new Error('Unexpected Git test fixture path.');
  }
  // Git objects are read-only; Electron's Windows fs cleanup leaves that bit intact.
  const directories = [resolvedRoot];
  while (directories.length) {
    const directory = directories.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) directories.push(entryPath);
      else if (entry.isFile()) fs.chmodSync(entryPath, 0o600);
    }
  }
  fs.rmSync(resolvedRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('initializes only Git metadata without role files, templates or an initial commit', async () => {
  const project = createDirectory('工程 with spaces');
  const template = createDirectory('templates');
  fs.writeFileSync(path.join(template, 'template-marker'), 'custom Git template');
  vi.stubEnv('GIT_TEMPLATE_DIR', template);

  await Promise.all(Array.from({ length: 4 }, () => ensureProjectGitRepository(project)));

  expect(fs.readdirSync(project)).toEqual(['.git']);
  expect(fs.existsSync(path.join(project, '.git', 'template-marker'))).toBe(false);
  expect(git(['rev-parse', '--is-inside-work-tree'], project).trim()).toBe('true');
  expect(git(['rev-list', '--all'], project)).toBe('');
});

test('preserves project files and does not reinitialize an existing repository', async () => {
  const project = createDirectory('existing');
  git(['init', '--quiet', '--template=', project]);
  const configFile = path.join(project, '.git', 'config');
  const config = fs.readFileSync(configFile, 'utf8');
  fs.writeFileSync(path.join(project, 'AGENTS.md'), 'project-specific rules');

  await ensureProjectGitRepository(project);

  expect(fs.readdirSync(project).sort()).toEqual(['.git', 'AGENTS.md']);
  expect(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8')).toBe('project-specific rules');
  expect(fs.readFileSync(configFile, 'utf8')).toBe(config);
});

test('does not create a nested repository inside an existing parent repository', async () => {
  const parent = createDirectory('parent');
  git(['init', '--quiet', '--template=', parent]);
  const project = createDirectory('parent/packages/project');

  await ensureProjectGitRepository(project);

  expect(fs.readdirSync(project)).toEqual([]);
  expect(git(['rev-parse', '--show-toplevel'], project).trim().replaceAll('\\', '/')).toBe(
    parent.replaceAll('\\', '/'),
  );
});

test('preserves a linked worktree and its repository reference file', async () => {
  const parent = createDirectory('worktree-parent');
  git(['init', '--quiet', '--template=', parent]);
  git(
    [
      '-c',
      'user.name=Git Test',
      '-c',
      'user.email=git-test@example.invalid',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'test fixture',
    ],
    parent,
  );
  const worktree = path.join(fixtureRoot, 'linked-worktree');
  git(['worktree', 'add', '--quiet', '--detach', worktree], parent);
  const marker = fs.readFileSync(path.join(worktree, '.git'), 'utf8');

  await ensureProjectGitRepository(worktree);

  expect(fs.readdirSync(worktree)).toEqual(['.git']);
  expect(fs.readFileSync(path.join(worktree, '.git'), 'utf8')).toBe(marker);
  expect(git(['rev-parse', 'HEAD'], worktree)).toBe(git(['rev-parse', 'HEAD'], parent));
});

test('preserves a bare repository without creating a nested .git directory', async () => {
  const project = createDirectory('bare');
  git(['init', '--quiet', '--bare', '--template=', project]);
  const existing = fs.readdirSync(project);

  await ensureProjectGitRepository(project);

  expect(fs.readdirSync(project)).toEqual(existing);
  expect(fs.existsSync(path.join(project, '.git'))).toBe(false);
});

test('does not redirect initialization through inherited Git directory settings', async () => {
  const project = createDirectory('project');
  const unrelated = createDirectory('unrelated');
  vi.stubEnv('GIT_DIR', path.join(unrelated, 'redirected.git'));
  vi.stubEnv('GIT_WORK_TREE', unrelated);

  await ensureProjectGitRepository(project);

  expect(fs.readdirSync(project)).toEqual(['.git']);
  expect(fs.readdirSync(unrelated)).toEqual([]);
});

test('does not overwrite an invalid existing repository marker', async () => {
  const project = createDirectory('invalid-marker');
  fs.writeFileSync(path.join(project, '.git'), 'user-managed marker');

  await ensureProjectGitRepository(project);

  expect(fs.readFileSync(path.join(project, '.git'), 'utf8')).toBe('user-managed marker');
  expect(fs.readdirSync(project)).toEqual(['.git']);
});

test('continues without creating files when Git is unavailable', async () => {
  const project = createDirectory('missing-git');
  vi.spyOn(portableGitRuntime, 'applyPortableGitRuntimeEnv').mockImplementation(env => ({
    ...env,
    PATH: '',
    Path: '',
  }));

  await expect(ensureProjectGitRepository(project)).resolves.toBeUndefined();

  expect(fs.readdirSync(project)).toEqual([]);
});

test('reports a missing directory without blocking session preparation', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  await expect(
    ensureProjectGitRepository(path.join(fixtureRoot, 'missing')),
  ).resolves.toBeUndefined();

  expect(warn).toHaveBeenCalledWith('[ProjectGit] Repository initialization skipped', {
    code: 'ENOENT',
  });
});
