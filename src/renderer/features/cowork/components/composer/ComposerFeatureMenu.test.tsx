// @vitest-environment jsdom
import { OpenClawExtensionId } from '@shared/openclaw/extensions';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import type { ExtensionEnablement } from '@/features/plugins/extensions/useExtensionEnablement';
import { i18nService } from '@/services/i18n';

import ComposerFeatureMenu, { type ComposerFeatureItem } from './ComposerFeatureMenu';
import { buildComposerFeatures } from './composerFeatures';
import { buildSwarmComposerFeature } from './swarmComposerFeature';

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
  const items = buildComposerFeatures(
    [buildSwarmComposerFeature({ selectSwarm, swarm: { mode: 'auto', verify: true } })],
    {
      loaded: true,
      enabled: new Map([[OpenClawExtensionId.SWARM_FLOW, true]]),
      disabledRevisions: new Map(),
    },
  );
  render(<ComposerFeatureMenu items={items} label="Features" />);
  fireEvent.click(screen.getByRole('button'));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Swarm collaboration' }));
  expect(selectSwarm).toHaveBeenCalledWith({ mode: 'auto', verify: true });
  expect(items[0].selected).toBe(true);
});

test('does not register Swarm while its plugin is disabled even with a selected draft', () => {
  const selectSwarm = vi.fn();
  expect(
    buildComposerFeatures(
      [buildSwarmComposerFeature({ selectSwarm, swarm: { mode: 'auto', verify: true } })],
      {
        loaded: true,
        enabled: new Map([[OpenClawExtensionId.SWARM_FLOW, false]]),
        disabledRevisions: new Map(),
      },
    ),
  ).toEqual([]);
  expect(selectSwarm).not.toHaveBeenCalled();
});

test('plugin entries are independently gated and built-in entries do not require a plugin', () => {
  const select = vi.fn();
  const registrations = [
    { ...item('Swarm'), extensionId: OpenClawExtensionId.SWARM_FLOW },
    { ...item('Other'), extensionId: 'another-plugin', onSelect: select },
    { ...item('Other action'), extensionId: 'another-plugin' },
    item('Built-in'),
  ];
  const settings: ExtensionEnablement = {
    loaded: false,
    enabled: new Map([['another-plugin', true]]),
    disabledRevisions: new Map(),
  };
  const items = buildComposerFeatures(registrations, settings);
  expect(items.map(entry => entry.id)).toEqual(['Other', 'Other action', 'Built-in']);
  render(<ComposerFeatureMenu items={items} label="Features" />);
  fireEvent.click(screen.getByRole('button'));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Other' }));
  expect(select).toHaveBeenCalledOnce();
  expect(
    buildComposerFeatures(registrations, {
      loaded: true,
      enabled: new Map(),
      disabledRevisions: new Map(),
    }).map(entry => entry.id),
  ).toEqual(['Built-in']);
});

test('removing the focused plugin entry keeps another plugin accessible by keyboard', () => {
  const first = item('First');
  const second = item('Second');
  const view = render(<ComposerFeatureMenu items={[first, second]} label="Features" />);
  fireEvent.click(screen.getByRole('button'));
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'First' }));
  view.rerender(<ComposerFeatureMenu items={[second]} label="Features" />);
  expect(screen.queryByRole('menuitem', { name: 'First' })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Second' }));
  fireEvent.click(screen.getByRole('menuitem'));
  expect(second.onSelect).toHaveBeenCalledOnce();
});

test('an empty registry hides the plus button and restoring an entry keeps the menu closed', () => {
  const feature = item('Feature');
  const view = render(<ComposerFeatureMenu items={[feature]} label="Features" />);
  fireEvent.click(screen.getByRole('button'));
  view.rerender(<ComposerFeatureMenu items={[]} label="Features" />);
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.queryByRole('menu')).toBeNull();
  view.rerender(<ComposerFeatureMenu items={[feature]} label="Features" />);
  expect(screen.getByRole('button')).toBeTruthy();
  expect(screen.queryByRole('menu')).toBeNull();
});
