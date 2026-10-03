// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import FilePathBreadcrumbBar from './FilePathBreadcrumbBar';

const filePath = 'E:/work/Project/src/deep/preview/FileName.tsx';
let availableWidth = 400;
const observers: { callback: ResizeObserverCallback; instance: ResizeObserver }[] = [];

beforeEach(() => {
  i18nService.setLanguage('en', { persist: false });
  availableWidth = 400;
  observers.length = 0;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => availableWidth);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const width = Array.from(this.dataset.segment ?? '').length * 7;
    return {
      x: 920,
      y: 40,
      left: 920,
      right: 920 + width,
      top: 40,
      bottom: 64,
      width,
      height: 24,
      toJSON: () => ({}),
    };
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        observers.push({ callback, instance: this as unknown as ResizeObserver });
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function resize(width: number) {
  availableWidth = width;
  act(() => observers.slice().forEach(observer => observer.callback([], observer.instance)));
}

it('folds the middle as the toolbar narrows and restores full levels when it grows', () => {
  render(<FilePathBreadcrumbBar filePath={filePath} workspacePath="E:/work/Project" isVisible />);
  const bar = screen.getByLabelText(filePath);
  expect(within(bar).getByText('src')).toBeTruthy();
  expect(within(bar).getByText('deep')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Show full file path' })).toBeNull();

  resize(280);
  expect(within(bar).getByText('Project')).toBeTruthy();
  expect(within(bar).getByText('preview')).toBeTruthy();
  expect(within(bar).getByText('FileName.tsx')).toBeTruthy();
  expect(within(bar).queryByText('src')).toBeNull();
  expect(within(bar).queryByText('deep')).toBeNull();
  expect(within(bar).getByRole('button', { name: 'Show full file path' })).toBeTruthy();
  expect(bar.title).toBe(filePath);

  resize(400);
  expect(within(bar).getByText('src')).toBeTruthy();
  expect(within(bar).getByText('deep')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Show full file path' })).toBeNull();
});

it('opens complete selectable path details, restores focus on Escape and dismisses on outside click', () => {
  availableWidth = 280;
  render(
    <>
      <button>Other action</button>
      <FilePathBreadcrumbBar filePath={filePath} workspacePath="E:/work/Project" isVisible />
    </>,
  );
  const trigger = screen.getByRole('button', { name: 'Show full file path' });
  fireEvent.click(trigger);
  const details = screen.getByRole('dialog', { name: 'Show full file path' });
  expect(document.activeElement).toBe(details);
  expect(within(details).getByText(filePath)).toBeTruthy();
  expect(
    within(details)
      .getAllByRole('listitem')
      .map(item => item.textContent),
  ).toEqual(['Project', 'src', 'deep', 'preview', 'FileName.tsx']);
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(parseFloat(details.style.left) + parseFloat(details.style.width)).toBeLessThanOrEqual(
    window.innerWidth - 8,
  );

  fireEvent.keyDown(details, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Other action' }));
  expect(screen.queryByRole('dialog')).toBeNull();

  fireEvent.click(trigger);
  fireEvent.click(trigger);
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('dismisses path details when changing files, hiding the panel or restoring full breadcrumbs', () => {
  availableWidth = 280;
  const view = render(
    <FilePathBreadcrumbBar filePath={filePath} workspacePath="E:/work/Project" isVisible />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Show full file path' }));
  view.rerender(
    <FilePathBreadcrumbBar
      filePath="E:/work/Project/src/deep/preview/Other.tsx"
      workspacePath="E:/work/Project"
      isVisible
    />,
  );
  expect(screen.queryByRole('dialog')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Show full file path' }));
  view.rerender(
    <FilePathBreadcrumbBar
      filePath="E:/work/Project/src/deep/preview/Other.tsx"
      workspacePath="E:/work/Project"
      isVisible={false}
    />,
  );
  expect(screen.queryByRole('dialog')).toBeNull();
  view.rerender(
    <FilePathBreadcrumbBar filePath={filePath} workspacePath="E:/work/Project" isVisible />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Show full file path' }));
  resize(400);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('keeps the filename extension and project at narrow widths and supports standalone dotfiles', () => {
  availableWidth = 120;
  const view = render(
    <FilePathBreadcrumbBar filePath={filePath} workspacePath="E:/work/Project" isVisible />,
  );
  expect(screen.getByText('Project')).toBeTruthy();
  expect(screen.getByText('.tsx')).toBeTruthy();
  expect(screen.getByTitle('FileName.tsx').textContent).toBe('FileName.tsx');

  view.rerender(<FilePathBreadcrumbBar filePath=".gitignore" isVisible />);
  expect(screen.getByLabelText('.gitignore').textContent).toBe('.gitignore');
  expect(screen.queryByRole('button', { name: 'Show full file path' })).toBeNull();
});
