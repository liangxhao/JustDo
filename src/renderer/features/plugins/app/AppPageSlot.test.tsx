// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import type { AppViewContext } from '../../../../../packages/app-plugin-sdk/browser';
import type { AppView } from './browserRegistry';

const fixture = vi.hoisted(() => ({
  views: [] as AppView[],
  listeners: new Set<() => void>(),
  contexts: new Map<string, AppViewContext>(),
}));
vi.mock('./runtime', () => ({
  appBrowserRegistry: {
    subscribe: (listener: () => void) => {
      fixture.listeners.add(listener);
      return () => fixture.listeners.delete(listener);
    },
    getViews: () => fixture.views,
  },
}));
import { AppPageSlot } from './AppPageSlot';

afterEach(() => {
  cleanup();
  fixture.views = [];
  fixture.contexts.clear();
});
const page = (id = 'discussion', epoch = 'first'): AppView => ({
  pluginId: 'fixture',
  id,
  epoch,
  slot: 'application.page',
  labelKey: id,
  component: function FixturePage(context) {
    fixture.contexts.set(id, context);
    const [draft, setDraft] = useState('');
    return (
      <section aria-label={id}>
        <input
          aria-label={`${id} draft`}
          value={draft}
          onChange={event => setDraft(event.target.value)}
        />
      </section>
    );
  },
});
function Shell({ active = true }: { active?: boolean }) {
  const [visible, setVisible] = useState(false);
  return (
    <main aria-label="content">
      <div hidden={visible}>Chat</div>
      <AppPageSlot context={{ active }} onVisibleChange={setVisible} />
    </main>
  );
}
test('keeps a standalone plugin page in the main content area and preserves it while hidden', () => {
  fixture.views = [page()];
  const view = render(<Shell />);
  const discussion = screen.getByRole('region', { name: 'discussion', hidden: true });
  expect(discussion.closest('main')).toBe(screen.getByRole('main', { name: 'content' }));
  expect(discussion.closest('[hidden]')).not.toBeNull();
  act(() => fixture.contexts.get('discussion')!.page!.setVisible(true));
  expect(discussion.closest('[hidden]')).toBeNull();
  expect(screen.getByText('Chat').hidden).toBe(true);
  expect(fixture.contexts.get('discussion')!.active).toBe(true);
  fireEvent.change(screen.getByRole('textbox', { name: 'discussion draft' }), {
    target: { value: 'Keep draft' },
  });
  view.rerender(<Shell active={false} />);
  expect(fixture.contexts.get('discussion')!.active).toBe(false);
  act(() => fixture.contexts.get('discussion')!.page!.setVisible(false));
  expect(screen.getByText('Chat').hidden).toBe(false);
  act(() => fixture.contexts.get('discussion')!.page!.setVisible(true));
  expect(
    (screen.getByRole('textbox', { name: 'discussion draft' }) as HTMLInputElement).value,
  ).toBe('Keep draft');
  expect(screen.queryByRole('dialog')).toBeNull();
});
test('restores chat on plugin retirement and never reopens a replacement page automatically', () => {
  fixture.views = [page()];
  render(<Shell />);
  act(() => fixture.contexts.get('discussion')!.page!.setVisible(true));
  expect(screen.getByText('Chat').hidden).toBe(true);
  act(() => {
    fixture.views = [];
    fixture.listeners.forEach(listener => listener());
  });
  expect(screen.getByText('Chat').hidden).toBe(false);
  act(() => {
    fixture.views = [page('discussion', 'second')];
    fixture.listeners.forEach(listener => listener());
  });
  expect(screen.getByText('Chat').hidden).toBe(false);
  expect(fixture.contexts.get('discussion')!.active).toBe(false);
});
test('an inactive page cannot close another selected page', () => {
  fixture.views = [page('first'), page('second')];
  render(<Shell />);
  act(() => fixture.contexts.get('first')!.page!.setVisible(true));
  act(() => fixture.contexts.get('second')!.page!.setVisible(true));
  act(() => fixture.contexts.get('first')!.page!.setVisible(false));
  expect(fixture.contexts.get('first')!.active).toBe(false);
  expect(fixture.contexts.get('second')!.active).toBe(true);
  expect(screen.getByText('Chat').hidden).toBe(true);
});
