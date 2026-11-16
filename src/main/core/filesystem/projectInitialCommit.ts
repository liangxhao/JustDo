import { createInterface } from 'node:readline';

import fs from 'fs/promises';
import path from 'path';

import type { WorktreeInitialCommitFile } from '../../../shared/cowork/worktreeInitialCommit';
import { createProjectGitRunner, startProjectGit } from './projectGit';

type Git = NonNullable<ReturnType<typeof createProjectGitRunner>>;

type CommitErrorCode =
  | 'worktreeInitialCommitAlreadyExists'
  | 'worktreeInitialCommitChanged'
  | 'worktreeInitialCommitIndexRestoreFailed'
  | 'worktreeInitialCommitInvalidSelection'
  | 'worktreeInitialCommitUnconfirmed'
  | 'worktreeInitialCommitUnavailable'
  | 'worktreeInitialCommitFailed';

export class ProjectInitialCommitError extends Error {
  constructor(
    readonly code: CommitErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}

interface RepositoryIdentity {
  cwd: string;
  projectRoot: string;
  gitDirectory: string;
  gitDirectoryIdentity: string;
  indexPath: string;
  branch: string;
}

export interface ProjectInitialCommitPreview extends RepositoryIdentity {
  files: WorktreeInitialCommitFile[];
  entries: ReadonlyMap<string, string | null>;
}

function projectGit(directory: string): Git {
  const git = createProjectGitRunner(directory);
  if (!git) throw new ProjectInitialCommitError('worktreeInitialCommitUnavailable');
  return git;
}

function hasCode(error: unknown, code: number | string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

const gitLine = (output: string) => output.replace(/\r?\n$/, '');
const gitRecords = (output: string) => output.split('\0').slice(0, -1);

async function resolveRepository(cwd: string): Promise<RepositoryIdentity> {
  const directory = await fs.realpath(cwd);
  const git = projectGit(directory);
  const [root, gitDirectory, indexPath, head] = await Promise.all([
    git(['rev-parse', '--show-toplevel']),
    git(['rev-parse', '--absolute-git-dir']),
    git(['rev-parse', '--path-format=absolute', '--git-path', 'index']),
    git(['symbolic-ref', '--quiet', 'HEAD']).catch(error => {
      if (hasCode(error, 1)) throw new ProjectInitialCommitError('worktreeInitialCommitChanged');
      throw error;
    }),
  ]);
  const branch = gitLine(head);
  if (!branch.startsWith('refs/heads/')) {
    throw new ProjectInitialCommitError('worktreeInitialCommitChanged');
  }
  await git(['show-ref', '--verify', '--quiet', branch]).then(
    () => {
      throw new ProjectInitialCommitError('worktreeInitialCommitAlreadyExists');
    },
    error => {
      if (!hasCode(error, 1)) throw error;
    },
  );
  const index = path.resolve(gitLine(indexPath));
  const metadataDirectory = await fs.realpath(gitLine(gitDirectory));
  const metadataStat = await fs.stat(metadataDirectory, { bigint: true });
  return {
    cwd: directory,
    projectRoot: await fs.realpath(gitLine(root)),
    gitDirectory: metadataDirectory,
    gitDirectoryIdentity: `${metadataStat.dev}:${metadataStat.ino}`,
    indexPath: path.join(await fs.realpath(path.dirname(index)), path.basename(index)),
    branch,
  };
}

function indexEntries(output: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const record of gitRecords(output)) {
    const tab = record.indexOf('\t');
    const [mode, object, stage] = record.slice(0, tab).split(' ');
    if (stage === '0') {
      entries.set(record.slice(tab + 1), `${mode} ${object}`);
    }
  }
  return entries;
}

async function readCandidateEntries(git: Git): Promise<Map<string, string | null>> {
  const [cached, staged, untracked] = await Promise.all([
    git(['ls-files', '--stage', '-z']),
    git(['diff', '--cached', '--name-only', '--ita-invisible-in-index', '--no-ext-diff', '-z']),
    git(['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const stagedPaths = new Set(gitRecords(staged));
  const entries = new Map<string, string | null>();
  for (const [file, entry] of indexEntries(cached)) {
    if (entry.startsWith('100644 ') || entry.startsWith('100755 ') || entry.startsWith('120000 ')) {
      entries.set(file, stagedPaths.has(file) ? entry : null);
    }
  }
  for (const file of gitRecords(untracked)) {
    // Git reports an embedded repository as a directory. Such a gitlink is not a file.
    if (!file.endsWith('/')) entries.set(file, null);
  }
  return entries;
}

export async function inspectProjectInitialCommit(
  cwd: string,
): Promise<ProjectInitialCommitPreview> {
  const repository = await resolveRepository(cwd);
  const entries = await readCandidateEntries(projectGit(repository.projectRoot));
  const files = Array.from(entries, ([file, entry]) => ({ path: file, staged: entry !== null }));
  return { ...repository, files, entries };
}

function assertSameRepository(expected: RepositoryIdentity, actual: RepositoryIdentity): void {
  if (
    expected.cwd !== actual.cwd ||
    expected.projectRoot !== actual.projectRoot ||
    expected.gitDirectory !== actual.gitDirectory ||
    expected.gitDirectoryIdentity !== actual.gitDirectoryIdentity ||
    expected.indexPath !== actual.indexPath ||
    expected.branch !== actual.branch
  ) {
    throw new ProjectInitialCommitError('worktreeInitialCommitChanged');
  }
}

function indexInput(entries: Iterable<[string, string]>): string {
  return Array.from(entries, ([file, entry]) => `${entry}\t${file}\0`).join('');
}

async function identityOptions(git: Git): Promise<string[]> {
  const options: string[] = [];
  for (const [key, value] of [
    ['user.name', 'Local User'],
    ['user.email', 'local-user@example.invalid'],
  ]) {
    const configured = await git(['config', '--get', key]).catch(error => {
      if (!hasCode(error, 1)) throw error;
      return '';
    });
    if (!configured.trim()) options.push('-c', `${key}=${value}`);
  }
  return options;
}

async function publishInitialCommit(
  git: Git,
  preview: RepositoryIdentity,
  commit: string,
  assertCurrent: () => void,
): Promise<void> {
  const command = startProjectGit(preview.projectRoot, [
    'update-ref',
    '-m',
    'Initial commit',
    '--stdin',
  ]);
  if (!command) throw new ProjectInitialCommitError('worktreeInitialCommitUnavailable');
  const protocol = createInterface({ input: command.stdout });
  const replies = protocol[Symbol.asyncIterator]();
  const closed = new Promise<void>(resolve => command.once('close', () => resolve()));
  command.on('error', () => {});
  command.stdin.on('error', () => {});
  command.stderr.resume();

  async function expectReply(expected: string): Promise<void> {
    if ((await replies.next()).value !== expected) {
      throw new ProjectInitialCommitError('worktreeInitialCommitFailed');
    }
  }

  let commitRequested = false;
  try {
    try {
      // Dereferencing HEAD during prepare makes Git hold its native HEAD and branch locks.
      // Re-read the exact symbolic target while those locks survive until commit or abort.
      command.stdin.write(`start\ncreate HEAD ${commit}\nprepare\n`);
      await expectReply('start: ok');
      await expectReply('prepare: ok');
      const head = gitLine(await git(['symbolic-ref', '--quiet', 'HEAD']));
      if (head !== preview.branch) {
        throw new ProjectInitialCommitError('worktreeInitialCommitChanged');
      }
      assertCurrent();
      commitRequested = true;
      command.stdin.end('commit\n');
      await expectReply('commit: ok');
    } finally {
      if (!commitRequested) command.stdin.end('abort\n');
      await closed;
      protocol.close();
    }
  } catch (error) {
    // A lost CLI response cannot prove that Git failed before publishing the ref.
    const actual = await git(['rev-parse', '--verify', '--quiet', preview.branch]).then(
      gitLine,
      (failure: unknown): null | undefined =>
        hasCode(failure, 1) &&
        'stderr' in (failure as object) &&
        (failure as { stderr: string }).stderr.trim() === ''
          ? null
          : undefined,
    );
    if (actual === commit) return;
    if (actual) {
      throw new ProjectInitialCommitError('worktreeInitialCommitAlreadyExists', { cause: error });
    }
    if (actual === undefined && commitRequested) {
      throw new ProjectInitialCommitError('worktreeInitialCommitUnconfirmed', { cause: error });
    }
    throw error;
  }
}

function reportCleanupError(error: unknown): void {
  const code = error instanceof Error && 'code' in error ? error.code : 'unknown';
  console.warn(`[ProjectInitialCommit] Temporary cleanup failed ${JSON.stringify({ code })}`);
}

export async function createProjectInitialCommit(
  preview: ProjectInitialCommitPreview,
  selectedPaths: readonly string[],
  assertCurrent: () => void,
): Promise<void> {
  if (
    new Set(selectedPaths).size !== selectedPaths.length ||
    selectedPaths.some(file => !preview.entries.has(file))
  ) {
    throw new ProjectInitialCommitError('worktreeInitialCommitInvalidSelection');
  }
  assertCurrent();
  assertSameRepository(preview, await resolveRepository(preview.cwd));
  const git = projectGit(preview.projectRoot);
  const lockPath = `${preview.indexPath}.lock`;
  const indexLock = await fs.open(lockPath, 'wx').catch(error => {
    throw new ProjectInitialCommitError('worktreeInitialCommitChanged', { cause: error });
  });
  let scratch: string | undefined;
  let restoreIndex: (() => Promise<void>) | undefined;
  let preserveBackup = false;
  try {
    const current = await readCandidateEntries(git);
    if (selectedPaths.some(file => current.get(file) !== preview.entries.get(file))) {
      throw new ProjectInitialCommitError('worktreeInitialCommitChanged');
    }
    scratch = await fs.mkdtemp(path.join(path.dirname(preview.indexPath), 'initial-commit-'));
    const commitIndex = { GIT_INDEX_FILE: path.join(scratch, 'commit-index') };
    const selectedStaged = new Map<string, string>();
    const selectedNew: string[] = [];
    for (const file of selectedPaths) {
      const entry = current.get(file);
      if (entry) selectedStaged.set(file, entry);
      else selectedNew.push(file);
    }
    await git(['read-tree', '--empty'], { env: commitIndex });
    if (selectedStaged.size) {
      await git(['update-index', '-z', '--index-info'], {
        env: commitIndex,
        input: indexInput(selectedStaged),
      });
    }
    if (selectedNew.length) {
      for (const file of selectedNew) {
        const stat = await fs.lstat(path.join(preview.projectRoot, file));
        if (!stat.isFile() && !stat.isSymbolicLink()) {
          throw new ProjectInitialCommitError('worktreeInitialCommitChanged');
        }
      }
      // update-index reads literal filenames and cannot expand a changed path into a directory.
      await git(['update-index', '--add', '-z', '--stdin'], {
        env: commitIndex,
        input: `${selectedNew.join('\0')}\0`,
        timeout: 60_000,
      });
    }
    const entries = indexEntries(await git(['ls-files', '--stage', '-z'], { env: commitIndex }));
    if (
      entries.size !== selectedPaths.length ||
      selectedPaths.some(file => !entries.has(file)) ||
      [...selectedStaged].some(([file, entry]) => entries.get(file) !== entry)
    ) {
      throw new ProjectInitialCommitError('worktreeInitialCommitChanged');
    }

    let updatedIndex: string | undefined;
    let originalIndex: string | undefined;
    // Keep the user's index entries, adding only the newly tracked files in this commit.
    if (selectedNew.length) {
      updatedIndex = path.join(scratch, 'updated-index');
      originalIndex = path.join(scratch, 'original-index');
      await fs.copyFile(preview.indexPath, originalIndex).catch(error => {
        if (!hasCode(error, 'ENOENT')) throw error;
        originalIndex = undefined;
      });
      if (originalIndex) await fs.copyFile(originalIndex, updatedIndex);
      await git(['update-index', '-z', '--index-info'], {
        env: { GIT_INDEX_FILE: updatedIndex },
        input: indexInput(selectedNew.map(file => [file, entries.get(file)!])),
      });
    }
    const tree = gitLine(await git(['write-tree'], { env: commitIndex }));
    const commit = gitLine(
      await git([...(await identityOptions(git)), 'commit-tree', tree, '-m', 'Initial commit']),
    );
    assertSameRepository(preview, await resolveRepository(preview.cwd));
    assertCurrent();
    if (updatedIndex) {
      await fs.rename(updatedIndex, preview.indexPath);
      restoreIndex = async () => {
        if (originalIndex) await fs.rename(originalIndex, preview.indexPath);
        else await fs.rm(preview.indexPath, { force: true });
      };
    }
    assertCurrent();
    await publishInitialCommit(git, preview, commit, assertCurrent);
  } catch (error) {
    if (
      error instanceof ProjectInitialCommitError &&
      error.code === 'worktreeInitialCommitUnconfirmed'
    ) {
      // Preserve the prepared index because the branch can already refer to its files.
      throw error;
    }
    try {
      await restoreIndex?.();
    } catch (restoreError) {
      preserveBackup = true;
      throw new ProjectInitialCommitError('worktreeInitialCommitIndexRestoreFailed', {
        cause: restoreError,
      });
    }
    throw error;
  } finally {
    await indexLock
      .close()
      .then(() => fs.rm(lockPath, { force: true }))
      .catch(reportCleanupError);
    if (scratch && !preserveBackup) {
      await fs.rm(scratch, { recursive: true, force: true }).catch(reportCleanupError);
    }
  }
}
