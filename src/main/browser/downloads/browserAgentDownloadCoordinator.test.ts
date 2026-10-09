import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  armBrowserAgentDownload,
  beginBrowserAgentDownload,
  cancelBrowserAgentDownloadsForWebContents,
  claimBrowserAgentDownload,
  reserveBrowserAgentOutputPath,
} from './browserAgentDownloadCoordinator';

const downloadItem = () =>
  ({
    cancel: vi.fn(),
    getFilename: () => 'report.pdf',
    getState: () => 'progressing',
    getURL: () => 'https://example.com/report.pdf',
    getReceivedBytes: () => 12,
    getTotalBytes: () => 12,
  }) as Electron.DownloadItem;

afterEach(() => {
  vi.useRealTimers();
});

describe('browserAgentDownloadCoordinator', () => {
  test('atomically reserves a canonical output path until released', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-output-reservation-'));
    try {
      const outputPath = path.join(root, 'report.pdf');
      const first = reserveBrowserAgentOutputPath(outputPath);

      expect(() => reserveBrowserAgentOutputPath(outputPath)).toThrow('already reserved');

      first.release();
      first.release();
      const second = reserveBrowserAgentOutputPath(outputPath);
      second.release();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('treats junction aliases as the same output parent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-output-junction-'));
    try {
      const realParent = path.join(root, 'real');
      const aliasParent = path.join(root, 'alias');
      fs.mkdirSync(realParent);
      fs.symlinkSync(realParent, aliasParent, process.platform === 'win32' ? 'junction' : 'dir');
      const reservation = reserveBrowserAgentOutputPath(path.join(realParent, 'report.pdf'));

      expect(() => reserveBrowserAgentOutputPath(path.join(aliasParent, 'report.pdf'))).toThrow(
        'already reserved',
      );

      reservation.release();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test.runIf(process.platform === 'win32')(
    'treats Windows path casing as the same output path',
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-output-case-'));
      try {
        const outputPath = path.join(root, 'Report.pdf');
        const reservation = reserveBrowserAgentOutputPath(outputPath);

        expect(() => reserveBrowserAgentOutputPath(outputPath.toUpperCase())).toThrow(
          'already reserved',
        );

        reservation.release();
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test('claims only the matching guest download and settles once', async () => {
    const targetSession = {} as Electron.Session;
    const pending = armBrowserAgentDownload(
      targetSession,
      41,
      'C:\\workspace\\report.pdf',
      5_000,
      async () => undefined,
    );

    expect(
      claimBrowserAgentDownload(targetSession, downloadItem(), { id: 42 } as Electron.WebContents),
    ).toBeNull();
    const claim = claimBrowserAgentDownload(targetSession, downloadItem(), {
      id: 41,
    } as Electron.WebContents);
    expect(claim?.savePath).toBe('C:\\workspace\\report.pdf');
    claim?.settle(downloadItem(), 'completed');
    claim?.settle(downloadItem(), 'interrupted');

    await expect(pending).resolves.toEqual({
      state: 'completed',
      path: 'C:\\workspace\\report.pdf',
      fileName: 'report.pdf',
      sourceUrl: 'https://example.com/report.pdf',
      receivedBytes: 12,
      totalBytes: 12,
    });
  });

  test('removes an arm when its trigger fails', async () => {
    const targetSession = {} as Electron.Session;
    const pending = armBrowserAgentDownload(
      targetSession,
      41,
      'C:\\workspace\\report.pdf',
      5_000,
      async () => {
        throw new Error('click failed');
      },
    );

    await expect(pending).rejects.toThrow('click failed');
    const releasedReservation = reserveBrowserAgentOutputPath('C:\\workspace\\report.pdf');
    releasedReservation.release();
    expect(
      claimBrowserAgentDownload(targetSession, downloadItem(), { id: 41 } as Electron.WebContents),
    ).toBeNull();
  });

  test('times out and does not claim a later user download', async () => {
    vi.useFakeTimers();
    const targetSession = {} as Electron.Session;
    const pending = armBrowserAgentDownload(
      targetSession,
      41,
      'C:\\workspace\\report.pdf',
      100,
      async () => undefined,
    );
    const rejection = expect(pending).rejects.toThrow('Timed out');

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(
      claimBrowserAgentDownload(targetSession, downloadItem(), { id: 41 } as Electron.WebContents),
    ).toBeNull();
    const releasedReservation = reserveBrowserAgentOutputPath('C:\\workspace\\report.pdf');
    releasedReservation.release();
  });

  test('cancels a claimed download on timeout and redacts its source URL', async () => {
    vi.useFakeTimers();
    const targetSession = {} as Electron.Session;
    const item = downloadItem();
    item.getURL = () =>
      'https://alice:secret@example.com/report.pdf?access_token=secret&view=all';
    const pending = armBrowserAgentDownload(
      targetSession,
      41,
      'C:\\workspace\\report.pdf',
      100,
      async () => undefined,
    );
    const rejection = expect(pending).rejects.toThrow('Timed out');
    const claim = claimBrowserAgentDownload(targetSession, item, {
      id: 41,
    } as Electron.WebContents);

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(item.cancel).toHaveBeenCalledOnce();
    const releasedReservation = reserveBrowserAgentOutputPath('C:\\workspace\\report.pdf');
    releasedReservation.release();

    const nextPending = armBrowserAgentDownload(
      targetSession,
      41,
      'C:\\workspace\\report-2.pdf',
      5_000,
      async () => undefined,
    );
    const nextClaim = claimBrowserAgentDownload(targetSession, item, {
      id: 41,
    } as Electron.WebContents);
    nextClaim?.settle(item, 'completed');
    await expect(nextPending).resolves.toMatchObject({
      sourceUrl: 'https://example.com/report.pdf?access_token=%5BREDACTED%5D&view=all',
    });
    expect(claim?.savePath).toBe('C:\\workspace\\report.pdf');
  });

  test('finishes an unclaimed capture cleanly when its tab closes', async () => {
    const targetSession = {} as Electron.Session;
    const capture = beginBrowserAgentDownload(
      targetSession,
      41,
      'C:\\workspace\\report.pdf',
      5_000,
    );

    cancelBrowserAgentDownloadsForWebContents(41);

    await expect(capture.result).resolves.toBeNull();
    const releasedReservation = reserveBrowserAgentOutputPath('C:\\workspace\\report.pdf');
    releasedReservation.release();
  });

  test('cancels the download when resolving its managed path fails', async () => {
    const targetSession = {} as Electron.Session;
    const item = downloadItem();
    const capture = beginBrowserAgentDownload(targetSession, 41, () => {
      throw new Error('workspace unavailable');
    }, 5_000);
    const rejection = expect(capture.result).rejects.toThrow('workspace unavailable');

    const claim = claimBrowserAgentDownload(targetSession, item, {
      id: 41,
    } as Electron.WebContents);

    expect(claim).toMatchObject({ savePath: null, cancelled: true });
    expect(item.cancel).toHaveBeenCalledOnce();
    await rejection;
  });

  test('rejects a concurrent download claim for the same canonical path', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-output-download-'));
    try {
      const targetSession = {} as Electron.Session;
      const outputPath = path.join(root, 'report.pdf');
      const firstItem = downloadItem();
      const secondItem = downloadItem();
      const first = beginBrowserAgentDownload(targetSession, 41, () => outputPath, 5_000);
      const second = beginBrowserAgentDownload(targetSession, 41, () => outputPath, 5_000);
      const secondRejection = expect(second.result).rejects.toThrow('already reserved');

      const firstClaim = claimBrowserAgentDownload(targetSession, firstItem, {
        id: 41,
      } as Electron.WebContents);
      const secondClaim = claimBrowserAgentDownload(targetSession, secondItem, {
        id: 41,
      } as Electron.WebContents);

      expect(firstClaim?.savePath).toBe(outputPath);
      expect(secondClaim).toMatchObject({ savePath: null, cancelled: true });
      expect(secondItem.cancel).toHaveBeenCalledOnce();
      await secondRejection;
      firstClaim?.settle(firstItem, 'completed');
      await expect(first.result).resolves.toMatchObject({ state: 'completed', path: outputPath });

      const afterSettlement = reserveBrowserAgentOutputPath(outputPath);
      afterSettlement.release();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
