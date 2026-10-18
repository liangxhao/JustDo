import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MCP_APP_DOWNLOAD_MAX_BYTES } from '../../../shared/plugins/mcpAppDownload';

const mocks = vi.hoisted(() => ({
  choose: vi.fn(),
  write: vi.fn(),
  owner: { isDestroyed: () => false },
}));
vi.mock('electron', () => ({ dialog: { showSaveDialog: mocks.choose } }));
vi.mock('node:fs/promises', () => ({ writeFile: mocks.write }));
vi.mock('../../core/window/workspaceWindowManager', () => ({
  getWorkspaceDialogOwner: () => mocks.owner,
}));
import { decodeMcpAppDownload, saveMcpAppDownload } from './mcpAppDownload';

const input = {
  fileName: '流程.drawio',
  mimeType: 'application/vnd.jgraph.mxfile',
  dataBase64: Buffer.from('<mxfile>中文</mxfile>').toString('base64'),
};
beforeEach(() => {
  vi.clearAllMocks();
});
describe('native MCP App file save', () => {
  it('writes exact bytes only to the path selected in the owner-bound native dialog', async () => {
    mocks.choose.mockResolvedValue({ canceled: false, filePath: 'D:/chosen/flow.drawio' });
    await expect(saveMcpAppDownload({ sender: {} } as IpcMainInvokeEvent, input)).resolves.toEqual({
      canceled: false,
    });
    expect(mocks.choose).toHaveBeenCalledWith(
      mocks.owner,
      expect.objectContaining({ defaultPath: '流程.drawio' }),
    );
    expect(mocks.write).toHaveBeenCalledWith(
      'D:/chosen/flow.drawio',
      Buffer.from('<mxfile>中文</mxfile>'),
    );
  });
  it('does not write on cancellation or invalid input', async () => {
    mocks.choose.mockResolvedValue({ canceled: true });
    await expect(saveMcpAppDownload({ sender: {} } as IpcMainInvokeEvent, input)).resolves.toEqual({
      canceled: true,
    });
    expect(mocks.write).not.toHaveBeenCalled();
    await expect(
      saveMcpAppDownload({} as IpcMainInvokeEvent, { ...input, fileName: '../flow.drawio' }),
    ).rejects.toThrow();
    expect(mocks.choose).toHaveBeenCalledTimes(1);
  });
  it('saves embedded spreadsheet bytes through the owner-bound file dialog', async () => {
    const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x80]);
    mocks.choose.mockResolvedValue({ canceled: false, filePath: 'D:/chosen/预算.xlsx' });
    await expect(
      saveMcpAppDownload({ sender: {} } as IpcMainInvokeEvent, {
        fileName: '预算.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        dataBase64: bytes.toString('base64'),
      }),
    ).resolves.toEqual({ canceled: false });
    expect(mocks.choose).toHaveBeenCalledWith(
      mocks.owner,
      expect.objectContaining({
        defaultPath: '预算.xlsx',
        filters: [{ name: 'XLSX', extensions: ['xlsx'] }],
      }),
    );
    expect(mocks.write).toHaveBeenCalledWith('D:/chosen/预算.xlsx', bytes);
  });
  it.each(['../file.png', 'file.exe', 'NUL.png', 'trailing.png '])(
    'rejects unsafe file name %s',
    fileName => {
      expect(() => decodeMcpAppDownload({ ...input, fileName, mimeType: 'image/png' })).toThrow();
    },
  );
  it('rejects malformed and oversized bytes before opening any dialog', () => {
    expect(() => decodeMcpAppDownload({ ...input, dataBase64: 'invalid!' })).toThrow();
    expect(() =>
      decodeMcpAppDownload({
        ...input,
        dataBase64: 'A'.repeat(Math.ceil(MCP_APP_DOWNLOAD_MAX_BYTES / 3) * 4 + 4),
      }),
    ).toThrow();
    expect(mocks.choose).not.toHaveBeenCalled();
  });
});
