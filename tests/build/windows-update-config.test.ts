import { describe, expect, test } from 'vitest';

const { readWindowsUpdateConfig } = require('../../scripts/windows-update-config.cjs') as {
  readWindowsUpdateConfig: () => { feedUrl: string };
};

describe('Windows update build configuration', () => {
  test('uses the checked-in Generic feed without environment variables', () => {
    expect(readWindowsUpdateConfig()).toEqual({
      feedUrl: 'https://xxx.com/electron-app-update',
    });
  });
});
