// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import AgentTeamSelector from './AgentTeamSelector';

vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
afterEach(cleanup);

it('requires an explicit second-level choice, then closes without submitting anything', () => {
  const change = vi.fn();
  render(<AgentTeamSelector disabled={false} onChange={change} />);
  fireEvent.click(screen.getByRole('button', { name: 'composerFeatures' }));
  expect(screen.queryByRole('menuitemradio')).toBeNull();
  fireEvent.click(screen.getByRole('menuitem', { name: 'teamTitle' }));
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'teamGroup' }));
  expect(change).toHaveBeenCalledExactlyOnceWith('group');
  expect(screen.queryByRole('menu')).toBeNull();
});

it('supports keyboard navigation, mode selection, back and Escape', () => {
  const change = vi.fn();
  render(<AgentTeamSelector disabled={false} value="group" onChange={change} />);
  const trigger = screen.getByRole('button', { name: 'composerFeatures' });
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  fireEvent.keyDown(screen.getByRole('menuitem'), { key: 'ArrowRight' });
  expect(
    screen.getByRole('menuitemradio', { name: 'teamGroup' }).getAttribute('aria-checked'),
  ).toBe('true');
  fireEvent.keyDown(document.activeElement!, { key: 'End' });
  expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'teamTask' }));
  fireEvent.click(document.activeElement!);
  expect(change).toHaveBeenCalledWith('task');
  fireEvent.click(trigger);
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('dismisses outside clicks and disables the entry while busy', () => {
  const change = vi.fn();
  const view = render(<AgentTeamSelector disabled={false} onChange={change} />);
  fireEvent.click(screen.getByRole('button'));
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('menu')).toBeNull();
  view.rerender(<AgentTeamSelector disabled onChange={change} />);
  fireEvent.click(screen.getByRole('button'));
  expect(screen.queryByRole('menu')).toBeNull();
  expect(change).not.toHaveBeenCalled();
});
