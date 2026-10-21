// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWidgetViewportFit } from './viewport-fit';

let scene: HTMLElement;
let canvas: HTMLCanvasElement;
let staleCanvas = false;

beforeEach(() => {
  vi.stubGlobal('innerWidth', 840);
  vi.stubGlobal('innerHeight', 900);
  document.body.style.cssText = 'height:100%;overflow-y:hidden';
  document.body.innerHTML =
    '<div id="scene" style="height:70vh;min-height:480px;max-height:1000px"><canvas></canvas><button style="position:absolute">Rotate</button></div>';
  scene = document.getElementById('scene')!;
  canvas = scene.querySelector('canvas')!;
  staleCanvas = false;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const height =
      this === document.body || scene.style.height === '100%' || (this === canvas && staleCanvas)
        ? 900
        : 630;
    return {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      width: 840,
      height,
      right: 840,
      bottom: height,
      toJSON() {},
    };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  document.body.removeAttribute('style');
});

describe('standalone canvas viewport fitting', () => {
  it('fills the expanded viewport and restores authored sizing without retaining stale canvas overflow', () => {
    const fit = createWidgetViewportFit();
    fit(true);
    expect(scene.style.height).toBe('100%');
    expect(scene.style.minHeight).toBe('0px');
    expect(scene.style.maxHeight).toBe('none');
    expect(scene.style.overflowX).toBe('clip');
    expect(scene.style.overflowY).toBe('clip');
    const writes = vi.spyOn(scene.style, 'setProperty');
    fit(true);
    expect(writes).not.toHaveBeenCalled();

    staleCanvas = true;
    fit(false);
    expect(scene.style.height).toBe('70vh');
    expect(scene.style.minHeight).toBe('480px');
    expect(scene.style.maxHeight).toBe('1000px');
    expect(scene.style.overflowY).toBe('clip');
    writes.mockClear();
    fit(false);
    expect(writes).not.toHaveBeenCalled();
    staleCanvas = false;
    fit(true);
    expect(scene.style.height).toBe('100%');
  });

  it('restores original overflow longhands and priorities when the document becomes a flow layout', () => {
    scene.style.setProperty('height', '70vh', 'important');
    scene.style.setProperty('overflow-x', 'hidden', 'important');
    scene.style.setProperty('overflow-y', 'auto');
    const fit = createWidgetViewportFit();
    fit(true);
    scene.append(document.createElement('p'));
    fit(true);
    expect(scene.style.height).toBe('70vh');
    expect(scene.style.getPropertyPriority('height')).toBe('important');
    expect(scene.style.overflowX).toBe('hidden');
    expect(scene.style.getPropertyPriority('overflow-x')).toBe('important');
    expect(scene.style.overflowY).toBe('auto');
    expect(scene.style.getPropertyPriority('overflow-y')).toBe('');
  });

  it('preserves business-script changes to properties while expanded', () => {
    const fit = createWidgetViewportFit();
    fit(true);
    scene.style.setProperty('height', '600px');
    scene.style.setProperty('overflow-y', 'auto');
    fit(false);
    expect(scene.style.height).toBe('600px');
    expect(scene.style.overflowY).toBe('auto');
  });

  it.each(['flow body', 'caption', 'nested canvas', 'second canvas', 'second root', 'svg root'])(
    'leaves %s layouts unchanged',
    shape => {
      if (shape === 'flow body') document.body.style.overflowY = 'visible';
      if (shape === 'caption') scene.append(document.createElement('p'));
      if (shape === 'nested canvas') {
        const wrapper = document.createElement('div');
        canvas.replaceWith(wrapper);
        wrapper.append(canvas, document.createElement('p'));
      }
      if (shape === 'second canvas') scene.append(document.createElement('canvas'));
      if (shape === 'second root') document.body.append(document.createElement('section'));
      if (shape === 'svg root')
        document.body.append(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
      const original = scene.getAttribute('style');
      createWidgetViewportFit()(true);
      expect(scene.getAttribute('style')).toBe(original);
    },
  );

  it('does not infer a full-page scene from a smaller embedded chart', () => {
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      ...scene.getBoundingClientRect(),
      width: 400,
    });
    createWidgetViewportFit()(true);
    expect(scene.style.height).toBe('70vh');
    expect(scene.style.overflowY).toBe('');
  });
});
