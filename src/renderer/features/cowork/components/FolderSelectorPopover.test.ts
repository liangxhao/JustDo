import { describe, expect, it } from 'vitest';

import { areFolderPathsEqual, calculatePopoverPosition } from './FolderSelectorPopover';

describe('calculatePopoverPosition', () => {
  it('opens above the anchor when there is enough room', () => {
    const result = calculatePopoverPosition({ top: 700, bottom: 730, left: 120 }, 360, 1200, 800);

    expect(result).toEqual({ left: 120, top: 332, width: 360 });
  });

  it('opens below the anchor when that side has more room', () => {
    const result = calculatePopoverPosition({ top: 40, bottom: 70, left: 120 }, 360, 1200, 800);

    expect(result).toEqual({ left: 120, top: 78, width: 360 });
  });

  it('keeps the panel inside narrow and short viewports', () => {
    const result = calculatePopoverPosition({ top: 80, bottom: 110, left: 280 }, 176, 300, 200);

    expect(result).toEqual({ left: 12, top: 12, width: 276 });
  });
});

describe('areFolderPathsEqual', () => {
  it('ignores case and trailing separators on Windows', () => {
    expect(areFolderPathsEqual('C:\\Work\\Project\\', 'c:\\work\\project', 'win32')).toBe(true);
  });

  it('preserves case sensitivity on non-Windows platforms', () => {
    expect(areFolderPathsEqual('/work/Project', '/work/project', 'linux')).toBe(false);
  });
});
