// @vitest-environment jsdom

import type { WorkspaceWindowState } from '@shared/cowork/workspaceWindow';
import { afterEach, expect, test, vi } from 'vitest';

import { observeChatContentWidth } from '@/app/chatContentWidth';

import { createWorkspaceWindowControls } from './workspaceWindowControls';

const fixture = () => {
  const listeners = new Set<(state: WorkspaceWindowState) => void>();
  const api = {
    control: vi.fn(),
    getWindowState: vi.fn().mockResolvedValue(null),
    onStateChanged: vi.fn((callback: (state: WorkspaceWindowState) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }),
  };
  return {
    api,
    controls: createWorkspaceWindowControls(api, 'current'),
    emit: (state: WorkspaceWindowState) => listeners.forEach(callback => callback(state)),
  };
};

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.style.cssText = '';
});

test('binds all window controls and the initial query to the prepared generation', async () => {
  const { api, controls } = fixture();
  controls.minimize();
  controls.toggleMaximize();
  controls.close();
  controls.showSystemMenu({ x: 12, y: 24 });
  expect(api.control.mock.calls).toEqual([
    ['current', 'minimize'],
    ['current', 'toggleMaximize'],
    ['current', 'close'],
    ['current', 'showSystemMenu', { x: 12, y: 24 }],
  ]);
  await expect(controls.isMaximized()).resolves.toBe(false);
  expect(api.getWindowState).toHaveBeenCalledWith('current');
});

test('ignores stale window events and clears maximized state when docking', () => {
  const { controls, emit } = fixture();
  const onState = vi.fn();
  const unsubscribe = controls.onStateChanged(onState);
  const windowState = { isMaximized: true, isFullscreen: false, isFocused: true };
  emit({ generation: 'previous', detached: true, windowState });
  expect(onState).not.toHaveBeenCalled();
  emit({ generation: 'current', detached: true, windowState });
  expect(onState).toHaveBeenLastCalledWith(windowState);
  emit({ generation: 'current', detached: false });
  expect(onState).toHaveBeenLastCalledWith({
    isMaximized: false, isFullscreen: false, isFocused: false,
  });
  unsubscribe();
  onState.mockClear();
  emit({ generation: 'current', detached: true, windowState });
  expect(onState).not.toHaveBeenCalled();
});

test('applies the configured width on small-screen workspace maximize and restores it on docking', async () => {
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1280);
  vi.spyOn(window.screen, 'availWidth', 'get').mockReturnValue(1280);
  const { controls, emit } = fixture();
  const root = document.documentElement;
  const observer = observeChatContentWidth(root, controls);
  try {
    expect(root.style.getPropertyValue('--chat-content-width-progress')).toBe('0');
    emit({ generation: 'current', detached: true,
      windowState: { isMaximized: true, isFullscreen: false, isFocused: true } });
    await Promise.resolve();
    expect(root.style.getPropertyValue('--chat-content-width-progress')).toBe('1');
    emit({ generation: 'current', detached: false });
    expect(root.style.getPropertyValue('--chat-content-width-progress')).toBe('0');
  } finally {
    observer.dispose();
  }
});
