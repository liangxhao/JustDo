// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

import { readWorkspaceOcclusion } from './workspaceOcclusion';

const bounds = { left: 500, right: 900, top: 0, bottom: 700 } as DOMRect;
const visible = (element: Element) =>
  vi.spyOn(element, 'getClientRects').mockReturnValue([bounds] as unknown as DOMRectList);
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it('blocks the native workspace for a light-DOM marker even when the modal itself is inside shadow DOM', () => {
  const chat = document.createElement('div');
  const root = chat.attachShadow({ mode: 'open' });
  document.body.append(chat);
  const modal = document.createElement('dialog');
  modal.dataset.workspaceOverlay = 'true';
  root.append(modal);
  visible(modal);
  expect(readWorkspaceOcclusion(bounds).blocked).toBe(false);
  const marker = document.createElement('div');
  marker.dataset.workspaceOverlay = 'true';
  marker.style.visibility = 'hidden';
  document.body.append(marker);
  visible(marker);
  expect(readWorkspaceOcclusion(bounds)).toEqual({ blocked: true, occluded: true });
  marker.remove();
  expect(readWorkspaceOcclusion(bounds)).toEqual({ blocked: false, occluded: false });
});

it('keeps hidden overlays and overlays in another document from blocking this workspace', () => {
  const overlay = document.createElement('div');
  overlay.dataset.workspaceOverlay = 'true';
  document.body.append(overlay);
  expect(readWorkspaceOcclusion(bounds).blocked).toBe(false);
  const other = document.implementation.createHTMLDocument();
  other.body.append(overlay);
  visible(overlay);
  expect(readWorkspaceOcclusion(bounds).blocked).toBe(false);
  expect(readWorkspaceOcclusion(bounds, other).blocked).toBe(true);
});

it('occludes overlapping menus without treating them as blocking dialogs', () => {
  const menu = document.createElement('div');
  menu.setAttribute('role', 'menu');
  document.body.append(menu);
  visible(menu);
  vi.spyOn(menu, 'getBoundingClientRect').mockReturnValue(bounds);
  expect(readWorkspaceOcclusion(bounds)).toEqual({ blocked: false, occluded: true });
  expect(readWorkspaceOcclusion({ ...bounds, left: 1000, right: 1300 } as DOMRect)).toEqual({
    blocked: false,
    occluded: false,
  });
});
