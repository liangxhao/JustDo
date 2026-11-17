import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CoworkSessionSource } from '../../shared/cowork/sessionSource';
import { MessageFileLinkSourceKind } from '../../shared/preview/messageFileLink';
import { readManagedAssistantDelivery } from '../openclaw/media/readManagedAssistantDelivery';
import { ChromeExtensionChatController } from './chromeExtensionChatController';

const sessionKey = 'agent:main:fixture';
const managedSource =
  '/api/chat/media/outgoing/' + encodeURIComponent(sessionKey) +
  '/e17ee19d-f929-4c85-9991-53c953fe61bd/full';

let sandbox: string;
let workspace: string;

beforeEach(async () => {
  sandbox = await realpath(await mkdtemp(path.join(os.tmpdir(), 'chrome-delivery-test-')));
  workspace = path.join(sandbox, 'workspace');
  await mkdir(workspace);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(sandbox, { recursive: true, force: true });
});

function setup(messages: unknown[]) {
  const session = { id: 'one', cwd: workspace, source: CoworkSessionSource.ChromeExtension };
  const client = {
    request: vi.fn(async () => ({
      session: { key: sessionKey, sessionId: 'physical-1', lifecycleRevision: 'revision-1' },
    })),
  };
  const runtime = {
    ensureReady: vi.fn(async () => {}),
    getGatewayClient: () => client,
    getGatewayClientGeneration: () => 1,
    getSessionKeysForSession: () => [sessionKey],
    fetchSessionHistoryByKey: vi.fn(async () => ({ messages })),
  };
  const manager = {
    getGatewayLifecycleGeneration: () => 15,
    getStatus: () => ({ phase: 'running' }),
    getGatewayConnectionInfo: () => ({ port: 5678, token: 'fixture-token' }),
  };
  const stage = path.join(sandbox, 'opened-deliveries');
  const openPath = vi.fn(async (_filePath: string) => '');
  const controller = new ChromeExtensionChatController({
    ensureEngineRunning: vi.fn(),
    getRouter: vi.fn(),
    getRuntime: () => runtime as never,
    getStore: () => ({ getSession: (id: string) => id === session.id ? session : undefined }) as never,
    readManagedDelivery: request => readManagedAssistantDelivery(manager as never, request),
    managedDeliveryDirectory: stage,
    openDeliveryPath: openPath,
  });
  const open = (source: string, threadId = 'one') => controller.openDelivery(threadId, source, () => {});
  return { controller, open, openPath, stage, runtime, manager, client };
}

describe('Chrome message file links', () => {
  it('opens desktop-style file targets with the default app even before native history is available', async () => {
    const filename = '季度 报表%20#1.xls';
    const target = path.join(sandbox, filename);
    await writeFile(target, 'workbook');
    const { controller, openPath, runtime } = setup([]);
    const assertCurrent = () => {};

    await controller.openMessageFile('one', {
      sourceKind: MessageFileLinkSourceKind.NativePath,
      target,
    }, assertCurrent);
    await controller.openMessageFile('one', {
      sourceKind: MessageFileLinkSourceKind.FileUrl,
      target: pathToFileURL(target).href,
    }, assertCurrent);
    await controller.openMessageFile('one', {
      sourceKind: MessageFileLinkSourceKind.MarkdownUri,
      target: '../' + encodeURIComponent(filename),
    }, assertCurrent);

    expect(openPath.mock.calls).toEqual([[target], [target], [target]]);
    expect(runtime.ensureReady).not.toHaveBeenCalled();
    expect(runtime.fetchSessionHistoryByKey).not.toHaveBeenCalled();
  });

  it('does not pass executable, directory, or remote aliases to the default app', async () => {
    const executable = path.join(workspace, 'launch.exe');
    const directory = path.join(workspace, 'subdirectory.pdf');
    await writeFile(executable, 'executable');
    await mkdir(directory);
    const { controller, openPath } = setup([]);
    const disallowed = [
      { sourceKind: MessageFileLinkSourceKind.NativePath, target: executable },
      { sourceKind: MessageFileLinkSourceKind.NativePath, target: directory },
      { sourceKind: MessageFileLinkSourceKind.FileUrl, target: 'file://server/share/report.pdf' },
    ];
    for (const target of disallowed) {
      await expect(controller.openMessageFile('one', target, () => {})).rejects.toThrow();
    }
    expect(openPath).not.toHaveBeenCalled();
  });
});

describe('Chrome delivery opening', () => {
  it('opens only an exact assistant reference to a passive workspace file', async () => {
    const source = 'Quarterly report.pdf';
    const target = path.join(workspace, source);
    await writeFile(target, '%PDF report');
    await writeFile(path.join(workspace, 'plain-link.pdf'), '%PDF linked only');
    const { open, openPath, runtime } = setup([
      { role: 'assistant', content: [{ type: 'file', path: source }] },
      { role: 'user', openclawDelivery: { mediaUrls: ['user-file.pdf'] } },
      { role: 'assistant', content: '[plain](plain-link.pdf)' },
    ]);

    await expect(open(source, 'another-thread')).rejects.toThrow();
    expect(runtime.fetchSessionHistoryByKey).not.toHaveBeenCalled();
    await expect(open('./' + source)).rejects.toThrow();
    await expect(open('user-file.pdf')).rejects.toThrow();
    await expect(open('plain-link.pdf')).rejects.toThrow();
    expect(openPath).not.toHaveBeenCalled();

    await expect(open(source)).resolves.toBeUndefined();
    expect(openPath).toHaveBeenCalledExactlyOnceWith(target);
    expect(runtime.fetchSessionHistoryByKey).toHaveBeenLastCalledWith(
      sessionKey, undefined, { forceFullSnapshot: true, includePendingInputs: true },
    );
  });

  it('blocks explicitly delivered executables and workspace escapes including directory junctions', async () => {
    const outside = path.join(sandbox, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'other.pdf'), '%PDF not in workspace');
    await writeFile(path.join(workspace, 'launch.exe'), 'not a passive document');
    await symlink(outside, path.join(workspace, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    const references = ['launch.exe', '../outside/other.pdf', 'alias/other.pdf', '//server/share/data.pdf'];
    const { open, openPath } = setup([
      { role: 'assistant', openclawDelivery: { mediaUrls: references } },
    ]);

    for (const source of references) await expect(open(source)).rejects.toThrow();
    expect(openPath).not.toHaveBeenCalled();
  });

  it('fetches an exact managed delivery in its own session and opens the staged native filename', async () => {
    const filename = '交付 文件.pdf';
    const bytes = '%PDF fixture';
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(bytes, {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(filename),
      },
    }));
    const otherSource = managedSource.replace(encodeURIComponent(sessionKey), 'other');
    const { open, openPath, stage } = setup([
      { role: 'assistant', openclawDelivery: { mediaUrls: [managedSource, otherSource] } },
    ]);
    await expect(open(otherSource)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();

    await expect(open(managedSource)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledExactlyOnceWith(new URL('http://127.0.0.1:5678' + managedSource),
      expect.objectContaining({
        redirect: 'error',
        headers: expect.objectContaining({
          Authorization: 'Bearer fixture-token',
          'x-openclaw-requester-session-key': sessionKey,
        }),
      }),
    );
    const [target] = openPath.mock.calls[0];
    expect(path.basename(target)).toBe(filename);
    expect(path.dirname(path.dirname(target))).toBe(stage);
    await expect(readFile(target, 'utf8')).resolves.toBe(bytes);
  });

  it('does not place managed delivery bytes through a substituted staging directory junction', async () => {
    const outside = path.join(sandbox, 'target');
    await mkdir(outside);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('%PDF fixture', {
      headers: { 'content-type': 'application/pdf' },
    }));
    const { open, openPath, stage } = setup([
      { role: 'assistant', openclawDelivery: { mediaUrls: [managedSource] } },
    ]);
    await symlink(outside, stage, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(open(managedSource)).rejects.toThrow();
    expect(openPath).not.toHaveBeenCalled();
    await expect(readdir(outside)).resolves.toEqual([]);
  });

  it('does not open a local delivery if the native conversation resets before shell dispatch', async () => {
    const source = 'earlier.pdf';
    await writeFile(path.join(workspace, source), '%PDF fixture');
    const { open, openPath, client } = setup([
      { role: 'assistant', openclawDelivery: { mediaUrls: [source] } },
    ]);
    const nativeSession = { key: sessionKey, sessionId: 'physical-1', lifecycleRevision: 'revision-1' };
    client.request.mockResolvedValueOnce({ session: nativeSession })
      .mockResolvedValueOnce({ session: nativeSession })
      .mockResolvedValueOnce({ session: { ...nativeSession, lifecycleRevision: 'replacement' } });

    await expect(open(source)).rejects.toThrow('Native conversation changed');
    expect(openPath).not.toHaveBeenCalled();
  });

  it('does not stage or open a managed file after the Gateway generation changes', async () => {
    const { open, openPath, stage, manager } = setup([
      { role: 'assistant', openclawDelivery: { mediaUrls: [managedSource] } },
    ]);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      manager.getGatewayLifecycleGeneration = () => 16;
      return new Response('%PDF fixture', { headers: { 'content-type': 'application/pdf' } });
    });

    await expect(open(managedSource)).rejects.toThrow('Gateway changed');
    expect(openPath).not.toHaveBeenCalled();
    await expect(readdir(stage)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
