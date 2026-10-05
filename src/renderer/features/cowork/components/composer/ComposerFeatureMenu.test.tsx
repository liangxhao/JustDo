// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { i18nService } from '@/services/i18n';

import ComposerFeatureMenu, { type ComposerFeatureItem } from './ComposerFeatureMenu';
import { buildComposerFeatures } from './composerFeatures';

afterEach(cleanup);
const item = (id: string, disabled = false): ComposerFeatureItem => ({
  id,
  label: id,
  icon: <span />,
  disabled,
  onSelect: vi.fn(),
});
test('supports multiple capabilities and skips disabled entries during keyboard navigation', () => {
  const items = [item('First'), item('Unavailable', true), item('Last')];
  render(<ComposerFeatureMenu items={items} label="Features" />);
  fireEvent.keyDown(screen.getByRole('button'), { key: 'ArrowDown' });
  const first = screen.getByRole('menuitem', { name: 'First' });
  const last = screen.getByRole('menuitem', { name: 'Last' });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(last);
  fireEvent.keyDown(last, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: 'End' });
  expect(document.activeElement).toBe(last);
  fireEvent.click(last);
  expect(items[2].onSelect).toHaveBeenCalledOnce();
  expect(items[0].onSelect).not.toHaveBeenCalled();
  expect(screen.queryByRole('menu')).toBeNull();
});
test('ArrowUp opens on the last enabled capability and Escape returns focus', () => {
  render(<ComposerFeatureMenu items={[item('First'), item('Last')]} label="Features" />);
  const trigger = screen.getByRole('button');
  fireEvent.keyDown(trigger, { key: 'ArrowUp' });
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Last' }));
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});
test('a running composer disables an already open menu without reopening it later', () => {
  const items = [item('Feature')];
  const view = render(<ComposerFeatureMenu items={items} label="Features" />);
  fireEvent.click(screen.getByRole('button'));
  view.rerender(<ComposerFeatureMenu items={items} label="Features" disabled />);
  expect(screen.queryByRole('menu')).toBeNull();
  view.rerender(<ComposerFeatureMenu items={items} label="Features" />);
  expect(screen.queryByRole('menu')).toBeNull();
});
test('focus leaving the module closes the menu without selecting anything', () => {
  const feature = item('Feature');
  render(
    <>
      <ComposerFeatureMenu items={[feature]} label="Features" />
      <button>Next</button>
    </>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Features' }));
  fireEvent.blur(screen.getByRole('menuitem'), {
    relatedTarget: screen.getByRole('button', { name: 'Next' }),
  });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(feature.onSelect).not.toHaveBeenCalled();
});
test('Swarm registers its own label, selection and action without changing menu mechanics', () => {
  i18nService.setLanguage('en', { persist: false });
  const selectSwarm = vi.fn();
  const items = buildComposerFeatures({ selectSwarm, swarm: { mode: 'auto', verify: true } });
  render(<ComposerFeatureMenu items={items} label="Features" />);
  fireEvent.click(screen.getByRole('button'));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Swarm collaboration' }));
  expect(selectSwarm).toHaveBeenCalledWith({ mode: 'auto', verify: true });
  expect(items[0].selected).toBe(true);
});
