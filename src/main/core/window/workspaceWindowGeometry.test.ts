import { describe, expect, it } from 'vitest';

import {
  clipWorkspaceViewBounds,
  fitWorkspaceWindowBounds,
  isWorkspaceWindowBounds,
} from './workspaceWindowGeometry';

describe('workspace display recovery', () => {
  const displays = [
    { x: 0, y: 0, width: 1920, height: 1040 },
    { x: 1920, y: -200, width: 1920, height: 1040 },
  ];
  it('retains the display containing most of a window spanning two screens', () => {
    expect(fitWorkspaceWindowBounds({ x: 1900, y: 0, width: 900, height: 720 }, displays)).toEqual({
      x: 1920,
      y: 0,
      width: 900,
      height: 720,
    });
  });
  it('recovers onto the nearest remaining display after unplugging a screen', () => {
    expect(fitWorkspaceWindowBounds({ x: 4000, y: 0, width: 900, height: 720 }, displays)).toEqual({
      x: 2940,
      y: 0,
      width: 900,
      height: 720,
    });
  });
  it('fits negative-origin displays and work areas smaller than the preferred minimum', () => {
    expect(
      fitWorkspaceWindowBounds({ x: -3000, y: -1000, width: 2000, height: 2000 }, [
        { x: -1280, y: -100, width: 1280, height: 900 },
      ]),
    ).toEqual({ x: -1280, y: -100, width: 1280, height: 900 });
    expect(
      fitWorkspaceWindowBounds({ x: 0, y: 0, width: 100, height: 100 }, [
        { x: 0, y: 0, width: 400, height: 200 },
      ]),
    ).toEqual({ x: 0, y: 0, width: 400, height: 200 });
  });
  it('clips the docked view to the main content area with renderer zoom', () => {
    expect(
      clipWorkspaceViewBounds(
        { x: 640, y: 40, width: 600, height: 800 },
        { width: 1500, height: 900 },
        1.25,
      ),
    ).toEqual({ x: 800, y: 50, width: 700, height: 850 });
    expect(
      clipWorkspaceViewBounds(
        { x: -10, y: -10, width: 300, height: 300 },
        { width: 1000, height: 700 },
        1,
      ),
    ).toEqual({ x: 0, y: 0, width: 290, height: 290 });
  });
  it('rejects invalid persisted bounds', () => {
    expect(isWorkspaceWindowBounds({ x: Infinity, y: 0, width: 900, height: 720 })).toBe(false);
    expect(isWorkspaceWindowBounds({ x: 0, y: 0, width: -1, height: 720 })).toBe(false);
    expect(isWorkspaceWindowBounds(null)).toBe(false);
  });
});
