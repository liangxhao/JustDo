// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import type { AppView } from './browserRegistry';

const fixture = vi.hoisted(() => ({ views: [] as AppView[] }));
vi.mock('./runtime', () => ({
  appBrowserRegistry: { subscribe: () => () => undefined, getViews: () => fixture.views },
}));

import { AppPluginSlot } from './AppPluginSlot';

afterEach(cleanup);

test('orders declared entries independently of plugin loading while preserving ties and withdrawal', () => {
  fixture.views = [
    { id: 'team', order: 20 },
    { id: 'workflow', order: 10 },
    { id: 'another', order: 10 },
  ].map(entry => ({
    ...entry,
    pluginId: entry.id,
    epoch: 'one',
    slot: 'session.summary',
    labelKey: entry.id,
    component: () => <button>{entry.id}</button>,
  }));
  const view = render(<AppPluginSlot slot="session.summary" context={{}} />);
  expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual([
    'workflow',
    'another',
    'team',
  ]);
  fixture.views = fixture.views.filter(entry => entry.id !== 'team');
  view.rerender(<AppPluginSlot slot="session.summary" context={{}} />);
  expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual([
    'workflow',
    'another',
  ]);
});
