import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, shell: { openPath: vi.fn() } }));

vi.mock('../app/shell', () => ({
  openPathWithSystemChooser: vi.fn().mockResolvedValue({ success: true }),
}));

import { createSessionReviewService, resolveReviewFile } from './sessionReview';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const query = { sessionId: 'product', scope: 'all' as const };
function setup() {
  const request = vi.fn(async (method: string) =>
    method === 'sessions.describe'
      ? { session: { sessionId: 'instance' } }
      : { sessionKey: 'owned', files: [], additions: 0, deletions: 0 },
  );
  const client = { request, start: vi.fn(), stop: vi.fn() };
  const runtime = { getGatewayClient: () => client, getSessionKeysForSession: () => ['owned'] };
  const getSession = vi.fn(() => ({ cwd: 'C:/workspace', agentId: 'main' }));
  const deps = { getRuntime: () => runtime, getSession };
  return { request, deps, service: createSessionReviewService(deps) };
}
test('derives native identity in Main and validates the product session before calling Gateway', async () => {
  const { request, service, getSession } = (() => {
    const s = setup();
    return { ...s, getSession: s.deps.getSession };
  })();
  expect(await service.load(query)).toMatchObject({ success: true });
  expect(request).toHaveBeenCalledWith(
    'sessions.diff',
    { sessionKey: 'owned', scope: 'all' },
  );
  getSession.mockReturnValue(null as never);
  request.mockClear();
  expect(await service.load(query)).toEqual({ success: false, reason: 'identity' });
  expect(request).not.toHaveBeenCalled();
});
test('rejects reset instances, mismatched response identity and malformed query scopes', async () => {
  const { request, service } = setup();
  request
    .mockResolvedValueOnce({ session: { sessionId: 'old' } } as never)
    .mockResolvedValueOnce({ sessionKey: 'owned', files: [] } as never)
    .mockResolvedValueOnce({ session: { sessionId: 'new' } } as never);
  expect(await service.load(query)).toEqual({ success: false, reason: 'identity' });
  expect(await service.load({ ...query, commit: 'HEAD' })).toEqual({
    success: false,
    reason: 'invalid',
  });
  expect(await service.load({ ...query, scope: 'commit' })).toEqual({
    success: false,
    reason: 'invalid',
  });
});
test('only treats explicit unsupported methods as capability failures', async () => {
  const { request, service } = setup();
  request.mockRejectedValueOnce(new Error('network disconnected'));
  expect(await service.load(query)).toEqual({ success: false, reason: 'unavailable' });
  request.mockRejectedValueOnce(new Error('unknown method: sessions.diff'));
  expect(await service.load(query)).toEqual({ success: false, reason: 'unsupported' });
});
test('authorizes real local paths, rejects traversal, remote paths and junction escapes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-paths-'));
  roots.push(root);
  const workspace = path.join(root, '项目 空格');
  const outside = path.join(root, 'outside');
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(workspace, '文件.ts'), 'text');
  await fs.writeFile(path.join(outside, 'secret'), 'text');
  await fs.symlink(
    outside,
    path.join(workspace, 'link'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  expect(await resolveReviewFile(workspace, workspace, '文件.ts')).toMatchObject({
    relativePath: '文件.ts',
  });
  for (const relative of ['../outside/secret', 'link/secret', 'C:\\outside\\secret', '.git/config'])
    await expect(resolveReviewFile(workspace, workspace, relative)).rejects.toThrow();
  await expect(resolveReviewFile(undefined, workspace, '文件.ts')).rejects.toThrow();
});
test('rejects a response from another native key and a replaced Gateway client', async () => {
  const { request, deps, service } = setup();
  request
    .mockResolvedValueOnce({ session: { sessionId: 'instance' } } as never)
    .mockResolvedValueOnce({ sessionKey: 'other', files: [] } as never);
  expect(await service.load(query)).toEqual({ success: false, reason: 'identity' });
  const runtime = deps.getRuntime();
  request.mockImplementationOnce(async () => {
    runtime.getGatewayClient = () => ({ request: vi.fn(), start: vi.fn(), stop: vi.fn() }) as never;
    return { session: { sessionId: 'instance' } } as never;
  });
  expect(await service.load(query)).toEqual({ success: false, reason: 'identity' });
});

test('rejects a file reached through an alias into Git metadata', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-metadata-'));
  roots.push(root);
  const metadata = path.join(root, '.git');
  await fs.mkdir(metadata);
  await fs.writeFile(path.join(metadata, 'config'), 'metadata');
  await fs.symlink(
    metadata,
    path.join(root, 'metadata-alias'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  await expect(resolveReviewFile(root, root, 'metadata-alias/config')).rejects.toThrow('file');
});

test('only offers an editor chooser for a verified current local file', async () => {
  const { openPathWithSystemChooser } = await import('../app/shell');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-action-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'code.js'), 'fixture');
  const { request, deps, service } = setup();
  deps.getSession.mockReturnValue({ cwd: root, agentId: 'main' });
  request.mockImplementation(async method =>
    method === 'sessions.describe'
      ? ({ session: { sessionId: 'instance' } } as never)
      : ({ sessionKey: 'owned', root, files: [{ path: 'code.js', status: 'modified' }] } as never),
  );
  expect(await service.file(query, 'code.js', 'editor')).toMatchObject({
    success: true,
    relativePath: 'code.js',
  });
  expect(openPathWithSystemChooser).toHaveBeenCalledWith(path.join(root, 'code.js'));
  vi.mocked(openPathWithSystemChooser).mockClear();
  expect(await service.file(query, 'other.js', 'editor')).toEqual({
    success: false,
    reason: 'file',
  });
  expect(openPathWithSystemChooser).not.toHaveBeenCalled();
  request.mockImplementation(async method =>
    method === 'sessions.describe'
      ? ({ session: { sessionId: 'instance' } } as never)
      : ({ sessionKey: 'owned', files: [{ path: 'code.js', status: 'modified' }] } as never),
  );
  expect(await service.file(query, 'code.js', 'editor')).toMatchObject({ success: false });
  expect(openPathWithSystemChooser).not.toHaveBeenCalled();
});

test('rejects an editor action when the native session resets after resolving its file', async () => {
  const { openPathWithSystemChooser } = await import('../app/shell');
  vi.mocked(openPathWithSystemChooser).mockClear();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-reset-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'code.js'), 'fixture');
  const { request, deps, service } = setup();
  deps.getSession.mockReturnValue({ cwd: root, agentId: 'main' });
  let descriptions = 0;
  request.mockImplementation(async method => {
    if (method === 'sessions.describe') {
      descriptions += 1;
      return { session: { sessionId: descriptions < 3 ? 'instance' : 'replacement' } } as never;
    }
    return { sessionKey: 'owned', root, files: [{ path: 'code.js', status: 'modified' }] } as never;
  });

  expect(await service.file(query, 'code.js', 'editor')).toEqual({
    success: false,
    reason: 'identity',
  });
  expect(descriptions).toBe(3);
  expect(openPathWithSystemChooser).not.toHaveBeenCalled();
});

test('confines file actions to the product cwd when it is below the repository root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-nested-'));
  roots.push(root);
  const cwd = path.join(root, 'project');
  await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, 'code.ts'), 'fixture');
  await fs.writeFile(path.join(root, 'sibling.ts'), 'fixture');

  expect(await resolveReviewFile(root, cwd, 'project/code.ts')).toMatchObject({
    relativePath: 'code.ts',
  });
  await expect(resolveReviewFile(root, cwd, 'sibling.ts')).rejects.toThrow('file');
});

test('does not open a hardlinked file whose content native diff refuses to disclose', async () => {
  const { openPathWithSystemChooser } = await import('../app/shell');
  vi.mocked(openPathWithSystemChooser).mockClear();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-hardlink-'));
  roots.push(root);
  const cwd = path.join(root, 'checkout');
  await fs.mkdir(cwd);
  await fs.writeFile(path.join(root, 'outside.txt'), 'private fixture');
  await fs.link(path.join(root, 'outside.txt'), path.join(cwd, 'alias.txt'));
  const { request, deps, service } = setup();
  deps.getSession.mockReturnValue({ cwd, agentId: 'main' });
  request.mockImplementation(async method =>
    method === 'sessions.describe'
      ? ({ session: { sessionId: 'instance' } } as never)
      : ({
          sessionKey: 'owned',
          root: cwd,
          files: [{ path: 'alias.txt', status: 'added', truncated: true }],
        } as never),
  );

  for (const action of ['preview', 'files', 'editor'] as const) {
    expect(await service.file(query, 'alias.txt', action)).toEqual({
      success: false,
      reason: 'file',
    });
  }
  expect(openPathWithSystemChooser).not.toHaveBeenCalled();
});
