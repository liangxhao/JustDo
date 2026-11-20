import { EventEmitter } from 'node:events';
import { type FileHandle, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { dialog, ipcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenClawAssistantMediaIpc } from '../../../shared/openclaw/assistantMedia';
import { getWorkspaceDialogOwner } from '../../core/window/workspaceWindowManager';
import type { OpenClawEngineManager } from '../../openclaw/runtime/openclawEngineManager';
import { registerManagedMediaDownloadHandler } from './managedMediaDownload';

vi.mock('electron', () => ({ dialog: { showSaveDialog: vi.fn() }, ipcMain: { handle: vi.fn() } }));
vi.mock('node:fs/promises', () => ({ open: vi.fn(), rename: vi.fn(), rm: vi.fn() }));
vi.mock('../../core/window/workspaceWindowManager', () => ({ getWorkspaceDialogOwner: vi.fn() }));

const sessionKey = 'agent:main:fixture';
const source = '/api/chat/media/outgoing/agent%3Amain%3Afixture/11111111-1111-4111-8111-111111111111/full';
const request = { sessionKey, source, filename: 'display-name.py' };
const nativeName = '示例 文件#1%.py';
const destination = path.resolve('reports', nativeName);

function setup() {
  const frame = { url: 'http://127.0.0.1:1234/index.html' };
  const sender = Object.assign(new EventEmitter(), { mainFrame: frame, isDestroyed: () => false });
  const window = { webContents: sender, isDestroyed: () => false } as unknown as Electron.BrowserWindow;
  const event = { sender, senderFrame: frame } as unknown as Electron.IpcMainInvokeEvent;
  let generation = 1;
  const manager = {
    getGatewayLifecycleGeneration: () => generation,
    getStatus: () => ({ phase: 'running' }),
    getGatewayConnectionInfo: () => ({ port: 5678, token: 'fixture-token' }),
  } as unknown as OpenClawEngineManager;
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('result bytes', {
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(nativeName),
    },
  }));

  vi.mocked(getWorkspaceDialogOwner).mockReturnValue(window);
  vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: destination });
  const writeFile = vi.fn(async (_bytes: Buffer) => {});
  vi.mocked(open).mockResolvedValue({ writeFile, close: vi.fn(async () => {}) } as unknown as FileHandle);
  registerManagedMediaDownloadHandler({ getMainWindow: () => window, getManager: () => manager });
  const registration = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) =>
    channel === OpenClawAssistantMediaIpc.SaveDelivery,
  );

  return { save: registration![1], event, frame, fetch, writeFile, restartGateway: () => { generation += 1; } };
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('saving a managed assistant delivery', () => {
  it('reads the native bytes with session authorization and saves to the chosen path', async () => {
    const { save, event, fetch, writeFile } = setup();

    await expect(save(event, request)).resolves.toEqual({ success: true, canceled: false });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(new URL(source, 'http://127.0.0.1:5678'), expect.objectContaining({
      redirect: 'error',
      headers: expect.objectContaining({
        Authorization: 'Bearer fixture-token',
        'x-openclaw-requester-session-key': sessionKey,
      }),
    }));
    expect(dialog.showSaveDialog).toHaveBeenCalledExactlyOnceWith(expect.anything(), { defaultPath: nativeName });
    const staged = vi.mocked(open).mock.calls[0][0] as string;
    expect(path.dirname(staged)).toBe(path.dirname(destination));
    expect(writeFile).toHaveBeenCalledExactlyOnceWith(Buffer.from('result bytes'));
    expect(rename).toHaveBeenCalledExactlyOnceWith(staged, destination);
  });

  it('rejects a mismatched session and a child frame without a Gateway request', async () => {
    const { save, event, frame, fetch } = setup();

    await expect(save(event, { ...request, sessionKey: 'agent:main:other' })).resolves.toEqual({ success: false });
    await expect(save({ ...event, senderFrame: { ...frame } } as Electron.IpcMainInvokeEvent, request))
      .resolves.toEqual({ success: false });
    expect(fetch).not.toHaveBeenCalled();
    expect(dialog.showSaveDialog).not.toHaveBeenCalled();
  });

  it('retains the native document size range for desktop saves', async () => {
    const { save, event, fetch, writeFile } = setup();
    const chunk = new Uint8Array(1024 * 1024);
    const size = 65 * chunk.byteLength;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 65; index += 1) controller.enqueue(chunk);
        controller.close();
      },
    });
    fetch.mockResolvedValue(new Response(body, { headers: {
      'content-length': String(size), 'content-type': 'application/pdf',
    } }));

    await expect(save(event, request)).resolves.toEqual({ success: true, canceled: false });
    expect(writeFile.mock.calls[0][0]).toHaveLength(size);
  });

  it('reports that a different attachment must wait for the active save', async () => {
    const { save, event, fetch } = setup();
    const dialogResult = Promise.withResolvers<Electron.SaveDialogReturnValue>();
    vi.mocked(dialog.showSaveDialog).mockReturnValue(dialogResult.promise);
    const saving = save(event, request);

    await expect(save(event, {
      ...request,
      source: source.replace('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'),
    })).resolves.toEqual({ success: false, reason: 'busy' });
    expect(fetch).toHaveBeenCalledOnce();

    dialogResult.resolve({ canceled: true, filePath: '' });
    await expect(saving).resolves.toEqual({ success: true, canceled: true });
  });

  it.each([true, false])('leaves the disk untouched after cancellation (%s) or a Gateway change', async canceled => {
    const { save, event, restartGateway } = setup();
    vi.mocked(dialog.showSaveDialog).mockImplementation(async () => {
      if (!canceled) restartGateway();
      return { canceled, filePath: canceled ? '' : destination };
    });

    await expect(save(event, request)).resolves.toEqual(canceled
      ? { success: true, canceled: true }
      : { success: false });
    expect(open).not.toHaveBeenCalled();
  });

  it('keeps the destination intact if writing the staged file fails', async () => {
    const { save, event, writeFile } = setup();
    writeFile.mockRejectedValue(new Error('Test write failure'));
    vi.mocked(rm).mockResolvedValue(undefined);

    await expect(save(event, request)).resolves.toEqual({ success: false });
    expect(rename).not.toHaveBeenCalled();
    expect(rm).toHaveBeenCalledExactlyOnceWith(vi.mocked(open).mock.calls[0][0], { force: true });
  });
});
