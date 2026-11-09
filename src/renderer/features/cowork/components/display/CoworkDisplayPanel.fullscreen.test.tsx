// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import CoworkDisplayPanel from './CoworkDisplayPanel';

const presentation = vi.hoisted(() => ({ native: false, target: null as HTMLElement | null }));
vi.mock('./workspace/useWorkspacePortal', () => ({
  useWorkspacePortal: () => ({
    ...presentation,
    detached: false,
    blocked: false,
    transitioning: false,
  }),
}));

afterEach(() => {
  cleanup();
  presentation.target?.remove();
  vi.restoreAllMocks();
});

describe.each([false, true])('workspace fullscreen (native: %s)', native => {
  beforeEach(() => {
    i18nService.setLanguage('en', { persist: false });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1_200);
    presentation.native = native;
    presentation.target = native ? document.createElement('div') : null;
    if (presentation.target) document.body.append(presentation.target);
  });

  const workspace = (session: string, open = true, activeTabId = 'file') => (
    <CoworkDisplayPanel
      browserSessionKey={session}
      activeTabId={activeTabId}
      isOpen={open}
      width={640}
      onClose={vi.fn()}
      tabs={[]}
    >
      <input data-testid="retained-workspace-draft" defaultValue="draft" />
    </CoworkDisplayPanel>
  );

  it('restores sidebar geometry when hidden and keeps retained content mounted', () => {
    const view = render(workspace('first'));
    const surface = view.container.querySelector('.cowork-display-panel') as HTMLElement;
    const draft = screen.getByTestId('retained-workspace-draft');
    fireEvent.click(screen.getByRole('button', { name: 'Fill workspace' }));
    expect(surface.style.width).toBe('100%');
    expect(surface.style.position).toBe('absolute');

    view.rerender(workspace('second', false));
    expect(surface.getAttribute('aria-hidden')).toBe('true');
    expect(surface.getAttribute('data-workspace-fullscreen')).toBe('false');
    expect(surface.style.width).toBe('640px');
    expect(surface.style.position).toBe('');
    expect(surface.style.getPropertyValue('--display-panel-width')).toBe('640px');
    expect(screen.getByTestId('retained-workspace-draft')).toBe(draft);

    view.rerender(workspace('first'));
    expect(surface.style.width).toBe('640px');
    expect(
      screen.getByRole('button', { name: 'Fill workspace' }).getAttribute('aria-pressed'),
    ).toBe('false');
  });

  it('clears fullscreen on an open-session switch and on closing the same session', () => {
    const view = render(workspace('first'));
    const surface = view.container.querySelector('.cowork-display-panel') as HTMLElement;
    fireEvent.click(screen.getByRole('button', { name: 'Fill workspace' }));
    view.rerender(workspace('first', true, 'terminal'));
    expect(surface.getAttribute('data-workspace-fullscreen')).toBe('true');
    expect(surface.style.width).toBe('100%');
    view.rerender(workspace('second'));
    expect(surface.getAttribute('data-workspace-fullscreen')).toBe('false');
    expect(surface.style.width).toBe('640px');

    fireEvent.click(screen.getByRole('button', { name: 'Fill workspace' }));
    view.rerender(workspace('second', false));
    expect(surface.getAttribute('data-workspace-fullscreen')).toBe('false');
    view.rerender(workspace('second'));
    expect(surface.style.width).toBe('640px');
  });
});
