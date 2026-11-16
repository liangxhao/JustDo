import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, expect, test } from 'vitest';

import { createProjectInitialCommit, inspectProjectInitialCommit } from './projectInitialCommit';

let project: string;

const git = (args: string[], input?: string) =>
  execFileSync('git', args, {
    cwd: project,
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

const write = (file: string, contents: string) => {
  const target = path.join(project, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
};

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'project-initial-commit-test-'));
  git(['init', '--quiet', '--template=']);
  git(['config', 'user.name', 'Project Test Author']);
  git(['config', 'user.email', 'project-author@example.invalid']);
  git(['config', 'core.autocrlf', 'false']);
});

afterEach(() => {
  const root = path.resolve(project);
  if (
    path.dirname(root) !== path.resolve(os.tmpdir()) ||
    !path.basename(root).startsWith('project-initial-commit-test-')
  ) {
    throw new Error('Unexpected Git fixture path.');
  }
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) fs.chmodSync(path.join(entry.parentPath, entry.name), 0o600);
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('commits only selected literal paths, preserving staged versions, other staged files and Git config', async () => {
  const selectedNew = '文件 with spaces/[literal].txt';
  write('selected.txt', 'staged contents\n');
  write('other.txt', 'do not commit\n');
  git(['add', '--', 'selected.txt', 'other.txt']);
  write('selected.txt', 'uncommitted contents\n');
  write(selectedNew, 'selected new contents\n');
  write('not-selected.txt', 'unselected contents\n');
  write('.gitignore', 'ignored.txt\n');
  write('ignored.txt', 'ignored contents\n');
  const config = fs.readFileSync(path.join(project, '.git', 'config'));

  const preview = await inspectProjectInitialCommit(path.join(project, '文件 with spaces'));
  expect(preview.files).toEqual(
    expect.arrayContaining([
      { path: 'selected.txt', staged: true },
      { path: 'other.txt', staged: true },
      { path: selectedNew, staged: false },
    ]),
  );
  expect(preview.files.some(file => file.path === 'ignored.txt')).toBe(false);
  await createProjectInitialCommit(preview, ['selected.txt', selectedNew], () => {});

  expect(git(['ls-tree', '-rz', '--name-only', 'HEAD']).split('\0').filter(Boolean).sort()).toEqual(
    ['selected.txt', selectedNew].sort(),
  );
  expect(git(['show', 'HEAD:selected.txt'])).toBe('staged contents\n');
  expect(git(['show', `HEAD:${selectedNew}`])).toBe('selected new contents\n');
  expect(fs.readFileSync(path.join(project, 'selected.txt'), 'utf8')).toBe(
    'uncommitted contents\n',
  );
  expect(git(['diff', '--cached', '--name-only']).trim()).toBe('other.txt');
  expect(git(['show', '-s', '--format=%an <%ae>']).trim()).toBe(
    'Project Test Author <project-author@example.invalid>',
  );
  expect(fs.readFileSync(path.join(project, '.git', 'config'))).toEqual(config);
});

test('creates an empty initial commit without consuming staged files', async () => {
  write('saved.txt', 'keep staged\n');
  git(['add', '--', 'saved.txt']);
  const indexPath = path.join(project, '.git', 'index');
  const index = fs.readFileSync(indexPath);

  await createProjectInitialCommit(await inspectProjectInitialCommit(project), [], () => {});

  expect(git(['ls-tree', '-r', '--name-only', 'HEAD'])).toBe('');
  expect(fs.readFileSync(indexPath)).toEqual(index);
  expect(git(['diff', '--cached', '--name-only']).trim()).toBe('saved.txt');
});

test('keeps a concurrent external first commit and restores the pre-confirmation index', async () => {
  write('selected.txt', 'selected\n');
  const preview = await inspectProjectInitialCommit(project);
  const tree = git(['mktree'], '').trim();
  const external = git(['commit-tree', tree, '-m', 'External initial commit']).trim();
  let checks = 0;

  await expect(
    createProjectInitialCommit(preview, ['selected.txt'], () => {
      if (++checks === 3) git(['update-ref', preview.branch, external, '']);
    }),
  ).rejects.toMatchObject({ code: 'worktreeInitialCommitAlreadyExists' });

  expect(git(['rev-parse', 'HEAD']).trim()).toBe(external);
  expect(git(['status', '--porcelain']).trim()).toBe('?? selected.txt');
  expect(fs.existsSync(path.join(project, '.git', 'index.lock'))).toBe(false);
});

test('does not publish to either branch after HEAD changes just before publication', async () => {
  write('selected.txt', 'selected\n');
  const preview = await inspectProjectInitialCommit(project);
  let checks = 0;

  await expect(
    createProjectInitialCommit(preview, ['selected.txt'], () => {
      if (++checks === 3) git(['symbolic-ref', 'HEAD', 'refs/heads/other']);
    }),
  ).rejects.toMatchObject({ code: 'worktreeInitialCommitChanged' });

  expect(git(['symbolic-ref', 'HEAD']).trim()).toBe('refs/heads/other');
  expect(git(['for-each-ref', 'refs/heads'])).toBe('');
  expect(git(['status', '--porcelain']).trim()).toBe('?? selected.txt');
});
