// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { OwnerDocumentContext } from '../../../tests/fixtures/ownerDocument';
import DiscussionActionsMenu from './DiscussionActionsMenu';

vi.mock('../../../tests/fixtures/i18n', () => ({ i18nService: { t: (key: string) => key } }));
afterEach(() => {
  cleanup();
  document.querySelectorAll('iframe').forEach(frame => frame.remove());
});

it('hides secondary actions until opened and invokes only the selected action', () => {
  const onExport = vi.fn(),
    onDelete = vi.fn();
  render(
    <DiscussionActionsMenu
      onExport={onExport}
      onDelete={onDelete}
      exportDisabled={false}
      busy={false}
    />,
  );
  expect(screen.queryByRole('menuitem')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'teamMore' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'teamDelete' }));
  expect(onDelete).toHaveBeenCalledOnce();
  expect(onExport).not.toHaveBeenCalled();
  expect(screen.queryByRole('menu')).toBeNull();
});

it('navigates and dismisses the menu in the detached team document', () => {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const ownerDocument = frame.contentDocument!;
  const container = ownerDocument.createElement('div');
  ownerDocument.body.append(container);
  render(
    <OwnerDocumentContext.Provider value={ownerDocument}>
      <DiscussionActionsMenu onSettings={vi.fn()} onExport={vi.fn()} onDelete={vi.fn()} />
    </OwnerDocumentContext.Provider>,
    { container },
  );
  const host = within(ownerDocument.body);
  const trigger = host.getByRole('button', { name: 'teamMore' });
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const items = host.getAllByRole('menuitem');
  expect(ownerDocument.activeElement).toBe(items[0]);
  fireEvent.keyDown(items[0], { key: 'ArrowDown' });
  expect(ownerDocument.activeElement).toBe(items[1]);
  fireEvent.keyDown(items[1], { key: 'ArrowDown' });
  expect(ownerDocument.activeElement).toBe(items[2]);
  fireEvent.keyDown(items[2], { key: 'Escape' });
  expect(ownerDocument.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.pointerDown(ownerDocument.body);
  expect(host.queryByRole('menu')).toBeNull();
});

it('skips unavailable export and restores trigger focus on Escape', () => {
  render(
    <DiscussionActionsMenu onExport={vi.fn()} onDelete={vi.fn()} exportDisabled busy={false} />,
  );
  const trigger = screen.getByRole('button');
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'teamDelete' }));
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('prepares summary recovery only after the user selects it from the menu', () => {
  const summarize = vi.fn();
  render(<DiscussionActionsMenu onSummarize={summarize} />);
  expect(screen.queryByRole('menuitem', { name: 'teamSummarizeInSource' })).toBeNull();
  expect(summarize).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'teamMore' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'teamSummarizeInSource' }));
  expect(summarize).toHaveBeenCalledOnce();
  expect(screen.queryByRole('menu')).toBeNull();
});

it('does not allow summary recovery while the original summary outcome is unconfirmed', () => {
  const summarize = vi.fn();
  render(<DiscussionActionsMenu onSummarize={summarize} summarizeDisabled />);
  fireEvent.click(screen.getByRole('button', { name: 'teamMore' }));
  const action = screen.getByRole('menuitem', { name: 'teamSummarizeInSource' });
  expect(action).toHaveProperty('disabled', true);
  fireEvent.click(action);
  expect(summarize).not.toHaveBeenCalled();
});
