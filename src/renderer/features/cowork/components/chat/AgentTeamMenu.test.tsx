// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { OwnerDocumentContext } from '@/shared/dom/ownerDocument';

import { type AgentTeamEntry, AgentTeamKind } from '../display/summary/agentTeamEntries';
import AgentTeamMenu from './AgentTeamMenu';

vi.mock('@/services/i18n', () => ({ i18nService: { t: (key: string) => key } }));
afterEach(() => {
  cleanup();
  document.querySelectorAll('iframe').forEach(frame => frame.remove());
});
const entries: AgentTeamEntry[] = [
  {
    kind: AgentTeamKind.TASK,
    key: 'task:room:old',
    roomId: 'room',
    roundId: 'old',
    label: 'Task 1',
    memberCount: 3,
    statusKey: 'teamRecordEnded',
  },
  {
    kind: AgentTeamKind.TASK,
    key: 'task:room:new',
    roomId: 'room',
    roundId: 'new',
    label: 'Task 2',
    memberCount: 3,
    statusKey: 'teamRecordOpen',
  },
  ...['Design', 'Architecture', 'Risks'].map(label => ({
    kind: AgentTeamKind.GROUP,
    key: `group:${label}`,
    roomId: label,
    label: `Group · ${label}`,
    memberCount: 2,
    statusKey: 'teamRecordReady',
  })),
];

it('lists every team with metadata and selects the exact group without navigating on open', () => {
  const select = vi.fn();
  render(<AgentTeamMenu entries={entries} onSelect={select} />);
  const trigger = screen.getByRole('button', { name: 'teamTitle' });
  expect(trigger.textContent).toContain('5');
  fireEvent.click(trigger);
  expect(select).not.toHaveBeenCalled();
  expect(screen.getAllByRole('menuitem')).toHaveLength(5);
  expect(screen.getByRole('menuitem', { name: /Task 1/ }).textContent).toContain('teamRecordEnded');
  expect(screen.getByRole('menuitem', { name: /Group · Risks/ }).textContent).toContain(
    'teamRecordMembers: 2',
  );
  fireEvent.click(screen.getByRole('menuitem', { name: /Group · Risks/ }));
  expect(select).toHaveBeenCalledExactlyOnceWith(entries[4]);
  expect(screen.queryByRole('menu')).toBeNull();
});

it('positions, portals and dismisses entries in their detached owner document', () => {
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const ownerDocument = frame.contentDocument!;
  const ownerWindow = frame.contentWindow! as Window & typeof globalThis;
  Object.defineProperty(ownerWindow, 'innerWidth', { configurable: true, value: 260 });
  Object.defineProperty(ownerWindow, 'innerHeight', { configurable: true, value: 180 });
  const container = ownerDocument.createElement('div');
  ownerDocument.body.append(container);
  const select = vi.fn();
  render(
    <OwnerDocumentContext.Provider value={ownerDocument}>
      <AgentTeamMenu entries={entries} onSelect={select} />
    </OwnerDocumentContext.Provider>,
    { container },
  );
  const host = within(ownerDocument.body);
  const trigger = host.getByRole('button', { name: 'teamTitle' });
  fireEvent.click(trigger);
  const menu = host.getByRole('menu');
  const items = host.getAllByRole('menuitem');
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(menu.style.width).toBe('244px');
  expect(ownerDocument.activeElement).toBe(items[0]);
  expect(items[0] instanceof Node).toBe(false);
  fireEvent.keyDown(items[0], { key: 'ArrowDown' });
  expect(ownerDocument.activeElement).toBe(items[1]);
  fireEvent.pointerDown(menu);
  expect(host.getByRole('menu')).toBe(menu);
  fireEvent.pointerDown(ownerDocument.body);
  expect(host.queryByRole('menu')).toBeNull();
  fireEvent.click(trigger);
  fireEvent(ownerWindow, new ownerWindow.Event('resize'));
  expect(host.queryByRole('menu')).toBeNull();
  expect(select).not.toHaveBeenCalled();
});

it('supports keyboard browsing and returns focus to the trigger on escape', () => {
  const select = vi.fn();
  render(<AgentTeamMenu entries={entries} onSelect={select} />);
  const trigger = screen.getByRole('button', { name: 'teamTitle' });
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
  const items = screen.getAllByRole('menuitem');
  expect(document.activeElement).toBe(items[0]);
  fireEvent.keyDown(items[0], { key: 'End' });
  expect(document.activeElement).toBe(items[4]);
  fireEvent.keyDown(items[4], { key: 'ArrowDown' });
  expect(document.activeElement).toBe(items[0]);
  fireEvent.keyDown(items[0], { key: 'Escape' });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(select).not.toHaveBeenCalled();
});

it('dismisses on outside interaction and never keeps a menu after its last team disappears', () => {
  const select = vi.fn();
  const { rerender } = render(<AgentTeamMenu entries={entries} onSelect={select} />);
  const trigger = screen.getByRole('button', { name: 'teamTitle' });
  fireEvent.click(trigger);
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('menu')).toBeNull();
  fireEvent.click(trigger);
  rerender(<AgentTeamMenu entries={[]} onSelect={select} />);
  expect(screen.queryByRole('menu')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  rerender(<AgentTeamMenu entries={entries} onSelect={select} />);
  expect(screen.queryByRole('menu')).toBeNull();
  expect(select).not.toHaveBeenCalled();
});

it('keeps global team records reachable when the current chat has no teams', () => {
  const history = vi.fn();
  const select = vi.fn();
  render(<AgentTeamMenu entries={[]} onSelect={select} onHistory={history} />);
  fireEvent.click(screen.getByRole('button', { name: 'teamTitle' }));
  expect(history).toHaveBeenCalledOnce();
  expect(select).not.toHaveBeenCalled();
  expect(screen.queryByRole('menu')).toBeNull();
});

it('opens all team records separately from selecting a current team', () => {
  const history = vi.fn();
  const select = vi.fn();
  render(<AgentTeamMenu entries={entries} onSelect={select} onHistory={history} />);
  fireEvent.click(screen.getByRole('button', { name: 'teamTitle' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'teamAllRecords' }));
  expect(history).toHaveBeenCalledOnce();
  expect(select).not.toHaveBeenCalled();
});
