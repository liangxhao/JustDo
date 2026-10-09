import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => 'C:\\test-user-data') },
  safeStorage: {
    decryptString: vi.fn(),
    encryptString: vi.fn(),
  },
  session: { fromPartition: vi.fn() },
}));

import { importChromeData } from './browserDataImportService';

describe('browserDataImportService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('stops before reading or persisting browser data when cancelled', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Browser profile import was cancelled.'));

    await expect(
      importChromeData(
        {
          sourceId: 'Default',
          approved: true,
          cookies: true,
          passwords: false,
          history: false,
        },
        controller.signal,
      ),
    ).rejects.toThrow('cancelled');
  });
});
