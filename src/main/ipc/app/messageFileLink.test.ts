import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { afterEach, expect, test, vi } from 'vitest';

import {
  MessageFileLinkPreparationError,
  MessageFileLinkSourceKind,
  type PrepareMessageFileLinkRequest,
} from '../../../shared/preview/messageFileLink';
import { prepareMessageFileLink } from './messageFileLink';

const temporaryDirectories: string[] = [];

const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'message-file-link-'));
  temporaryDirectories.push(root);
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const file = (name: string) => {
    const filePath = path.join(workspace, name);
    fs.writeFileSync(filePath, 'file contents');
    return fs.realpathSync(filePath);
  };
  return { root, workspace, file };
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('prepares the same regular file from native, file URL and encoded Markdown targets', async () => {
  const { workspace, file } = fixture();
  const filePath = file('季度 My book%20#1.pdf');
  const targets: PrepareMessageFileLinkRequest[] = [
    { sourceKind: MessageFileLinkSourceKind.NativePath, target: filePath },
    { sourceKind: MessageFileLinkSourceKind.FileUrl, target: pathToFileURL(filePath).href },
    {
      sourceKind: MessageFileLinkSourceKind.MarkdownUri,
      target: `./${encodeURIComponent(path.basename(filePath))}`,
      workspaceSessionId: 'source',
      expectedProjectRoot: workspace,
    },
  ];
  for (const request of targets) {
    await expect(
      prepareMessageFileLink(request, { resolveWorkspaceRoot: () => workspace }),
    ).resolves.toEqual({ success: true, filePath });
  }
  expect(fs.readdirSync(workspace)).toEqual(['季度 My book%20#1.pdf']);
});

test.each(['report.xyz', 'picture.png', 'book.docx', 'source.ts', '.env', 'LICENSE'])(
  'prepares %s without depending on preview extension support or reading its content',
  async name => {
    const { file } = fixture();
    const filePath = file(name);
    const read = vi.spyOn(fs.promises, 'readFile');
    await expect(
      prepareMessageFileLink({
        sourceKind: MessageFileLinkSourceKind.NativePath,
        target: filePath,
      }),
    ).resolves.toEqual({ success: true, filePath });
    expect(read).not.toHaveBeenCalled();
  },
);

test('native percent sequences stay literal and file URLs decode exactly once', async () => {
  const { file } = fixture();
  const literal = file('a%20b.md');
  file('a b.md');
  for (const request of [
    { sourceKind: MessageFileLinkSourceKind.NativePath, target: literal },
    { sourceKind: MessageFileLinkSourceKind.FileUrl, target: pathToFileURL(literal).href },
  ]) {
    await expect(prepareMessageFileLink(request)).resolves.toEqual({
      success: true,
      filePath: literal,
    });
  }
});

test('relative paths require the source binding and match the expected directory', async () => {
  const { workspace, file } = fixture();
  const filePath = file('report.pdf');
  const base = { sourceKind: MessageFileLinkSourceKind.MarkdownUri, target: './report.pdf' };
  const resolveWorkspaceRoot = vi.fn(() => workspace);
  await expect(prepareMessageFileLink(base, { resolveWorkspaceRoot })).resolves.toEqual({
    success: false,
    error: MessageFileLinkPreparationError.MissingSource,
  });
  expect(resolveWorkspaceRoot).not.toHaveBeenCalled();
  await expect(
    prepareMessageFileLink(
      { ...base, workspaceSessionId: 'source', expectedProjectRoot: path.dirname(workspace) },
      { resolveWorkspaceRoot },
    ),
  ).resolves.toEqual({ success: false, error: MessageFileLinkPreparationError.SourceChanged });
  await expect(
    prepareMessageFileLink(
      { ...base, workspaceSessionId: 'source', expectedProjectRoot: workspace },
      { resolveWorkspaceRoot },
    ),
  ).resolves.toEqual({ success: true, filePath });
  expect(resolveWorkspaceRoot).toHaveBeenCalledWith('source');
});

test('never creates an unavailable source directory or retries a missing file against cwd', async () => {
  const { root, workspace } = fixture();
  const missingRoot = path.join(root, 'not-created');
  const request = {
    sourceKind: MessageFileLinkSourceKind.MarkdownUri,
    target: './missing.pdf',
    workspaceSessionId: 'source',
    expectedProjectRoot: missingRoot,
  };
  await expect(
    prepareMessageFileLink(request, { resolveWorkspaceRoot: () => missingRoot }),
  ).resolves.toEqual({ success: false, error: MessageFileLinkPreparationError.NotFound });
  expect(fs.existsSync(missingRoot)).toBe(false);
  await expect(
    prepareMessageFileLink(
      { ...request, expectedProjectRoot: workspace },
      { resolveWorkspaceRoot: () => workspace },
    ),
  ).resolves.toEqual({ success: false, error: MessageFileLinkPreparationError.NotFound });
});

test('compares an absolute project root with an equivalent trailing separator', async () => {
  const { workspace, file } = fixture();
  const filePath = file('report.pdf');
  await expect(
    prepareMessageFileLink(
      {
        sourceKind: MessageFileLinkSourceKind.MarkdownUri,
        target: './report.pdf',
        workspaceSessionId: 'source',
        expectedProjectRoot: `${workspace}${path.sep}`,
      },
      { resolveWorkspaceRoot: () => workspace },
    ),
  ).resolves.toEqual({ success: true, filePath });
});

test('retains explicit parent-relative lookup without granting any plugin access', async () => {
  const { root, workspace } = fixture();
  const filePath = path.join(root, 'report.pdf');
  fs.writeFileSync(filePath, 'file');
  await expect(
    prepareMessageFileLink(
      {
        sourceKind: MessageFileLinkSourceKind.MarkdownUri,
        target: '../report.pdf',
        workspaceSessionId: 'source',
        expectedProjectRoot: workspace,
      },
      { resolveWorkspaceRoot: () => workspace },
    ),
  ).resolves.toEqual({ success: true, filePath: fs.realpathSync(filePath) });
});

test('preserves only a separately supplied HTML navigation suffix', async () => {
  const { workspace, file } = fixture();
  const filePath = file('report.html');
  const request = {
    sourceKind: MessageFileLinkSourceKind.NativePath,
    target: 'report.html',
    navigationSuffix: '?view=compact#chart',
    workspaceSessionId: 'source',
    expectedProjectRoot: workspace,
  };
  await expect(
    prepareMessageFileLink(request, { resolveWorkspaceRoot: () => workspace }),
  ).resolves.toEqual({ success: true, filePath, navigationSuffix: '?view=compact#chart' });
  await expect(prepareMessageFileLink({ ...request, target: file('report.pdf') })).resolves.toEqual(
    { success: false, error: MessageFileLinkPreparationError.InvalidTarget },
  );
});

test('rejects directories and directory junctions instead of preparing them as files', async () => {
  const { root, workspace } = fixture();
  const junction = path.join(root, 'link.pdf');
  fs.symlinkSync(workspace, junction, process.platform === 'win32' ? 'junction' : 'dir');
  for (const target of [workspace, junction]) {
    await expect(
      prepareMessageFileLink({ sourceKind: MessageFileLinkSourceKind.NativePath, target }),
    ).resolves.toEqual({ success: false, error: MessageFileLinkPreparationError.NotRegularFile });
  }
});

test.each([
  { sourceKind: 'unknown', target: 'C:/report.pdf' },
  { sourceKind: MessageFileLinkSourceKind.NativePath, target: 'C:report.pdf' },
  { sourceKind: MessageFileLinkSourceKind.NativePath, target: '\\\\server\\share\\report.pdf' },
  { sourceKind: MessageFileLinkSourceKind.NativePath, target: '\\\\?\\C:\\report.pdf' },
  { sourceKind: MessageFileLinkSourceKind.NativePath, target: 'report.pdf' },
  { sourceKind: MessageFileLinkSourceKind.NativePath, target: 'a\0b.pdf' },
  { sourceKind: MessageFileLinkSourceKind.FileUrl, target: 'file://server/share/report.pdf' },
  { sourceKind: MessageFileLinkSourceKind.FileUrl, target: 'file://localhost/C:/report.pdf' },
  { sourceKind: MessageFileLinkSourceKind.FileUrl, target: 'file:///C:/My book.pdf' },
  { sourceKind: MessageFileLinkSourceKind.FileUrl, target: 'file:///C:/report.pdf#page=2' },
  { sourceKind: MessageFileLinkSourceKind.FileUrl, target: 'file:///C:/report%ZZ.pdf' },
  { sourceKind: MessageFileLinkSourceKind.FileUrl, target: 'file:///C:/report%00.pdf' },
  { sourceKind: MessageFileLinkSourceKind.MarkdownUri, target: 'docs/report.pdf' },
  { sourceKind: MessageFileLinkSourceKind.MarkdownUri, target: './a%ZZ.pdf' },
  { sourceKind: MessageFileLinkSourceKind.MarkdownUri, target: './a%00.pdf' },
  { sourceKind: MessageFileLinkSourceKind.MarkdownUri, target: './a%E2%80%A8.pdf' },
  { sourceKind: MessageFileLinkSourceKind.MarkdownUri, target: './a%5Cb.pdf' },
  { sourceKind: MessageFileLinkSourceKind.MarkdownUri, target: './a%2Fb.pdf' },
  { sourceKind: MessageFileLinkSourceKind.MarkdownUri, target: './a.pdf?view=1' },
  { sourceKind: MessageFileLinkSourceKind.MarkdownUri, target: './a\\b.pdf' },
])(
  'rejects malformed, remote or ambiguous target $target before filesystem reads',
  async request => {
    const lstat = vi.spyOn(fs.promises, 'lstat');
    const realpath = vi.spyOn(fs.promises, 'realpath');
    await expect(prepareMessageFileLink(request)).resolves.toEqual({
      success: false,
      error: MessageFileLinkPreparationError.InvalidTarget,
    });
    expect(lstat).not.toHaveBeenCalled();
    expect(realpath).not.toHaveBeenCalled();
  },
);

test('drops a source binding changed while filesystem preparation is pending', async () => {
  const { workspace, file } = fixture();
  file('report.pdf');
  let currentRoot = workspace;
  const original = fs.promises.lstat.bind(fs.promises);
  vi.spyOn(fs.promises, 'lstat').mockImplementation(async (...args) => {
    const stats = await original(...args);
    currentRoot = path.dirname(workspace);
    return stats;
  });
  await expect(
    prepareMessageFileLink(
      {
        sourceKind: MessageFileLinkSourceKind.MarkdownUri,
        target: './report.pdf',
        workspaceSessionId: 'source',
        expectedProjectRoot: workspace,
      },
      { resolveWorkspaceRoot: () => currentRoot },
    ),
  ).resolves.toEqual({ success: false, error: MessageFileLinkPreparationError.SourceChanged });
});

test('does not publish a prepared path to a frame that becomes unavailable', async () => {
  const { file } = fixture();
  const filePath = file('report.pdf');
  let current = true;
  const original = fs.promises.realpath.bind(fs.promises);
  vi.spyOn(fs.promises, 'realpath').mockImplementation(async (...args) => {
    const result = await original(...args);
    current = false;
    return result;
  });
  await expect(
    prepareMessageFileLink(
      { sourceKind: MessageFileLinkSourceKind.NativePath, target: filePath },
      { isCurrent: () => current },
    ),
  ).resolves.toEqual({ success: false, error: MessageFileLinkPreparationError.Unavailable });
});

test('fails with a bounded result when the authoritative source owner becomes unavailable', async () => {
  const { workspace, file } = fixture();
  file('report.pdf');
  const resolveWorkspaceRoot = vi
    .fn<() => string>()
    .mockReturnValueOnce(workspace)
    .mockImplementation(() => {
      throw new Error('Source owner closed');
    });
  await expect(
    prepareMessageFileLink(
      {
        sourceKind: MessageFileLinkSourceKind.MarkdownUri,
        target: './report.pdf',
        workspaceSessionId: 'source',
        expectedProjectRoot: workspace,
      },
      { resolveWorkspaceRoot },
    ),
  ).resolves.toEqual({ success: false, error: MessageFileLinkPreparationError.SourceChanged });
});
