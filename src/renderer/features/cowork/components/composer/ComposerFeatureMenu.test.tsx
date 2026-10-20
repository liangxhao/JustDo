// @vitest-environment jsdom
import { OpenClawExtensionId } from '@shared/plugins/nativeIds';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import type { ExtensionEnablement } from '@/features/plugins/extensions/useExtensionEnablement';
import { i18nService } from '@/services/i18n';

import { buildAgentTeamFeature } from './AgentTeamSelector';
import ComposerFeatureMenu, { type ComposerFeatureItem } from './ComposerFeatureMenu';
import { buildComposerFeatures } from './composerFeatures';
import { buildSwarmWorkflowComposerFeature } from './swarmWorkflowComposerFeature';

afterEach(cleanup);
const item = (id: string, disabled = false): ComposerFeatureItem => ({
  id,
  label: id,
  icon: <span />,
  disabled,
  onSelect: vi.fn(),
});
test.each(['click', 'ArrowDown', 'ArrowUp'])(
  'notifies discovery only when the menu is opened with %s',
  trigger => {
    const onOpen = vi.fn();
    render(<ComposerFeatureMenu items={[item('App')]} label="Features" onOpen={onOpen} />);
    const button = screen.getByRole('button', { name: 'Features' });
    if (trigger === 'click') fireEvent.click(button);
    else fireEvent.keyDown(button, { key: trigger });
    expect(onOpen).toHaveBeenCalledOnce();
    fireEvent.keyDown(button, { key: 'ArrowDown' });
    expect(onOpen).toHaveBeenCalledOnce();
    fireEvent.keyDown(screen.getByRole('menuitem'), { key: 'Escape' });
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(2);
  },
);
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
  const selectSwarmWorkflow = vi.fn();
  const items = buildComposerFeatures(
    [
      buildSwarmWorkflowComposerFeature({
        selectSwarmWorkflow,
        swarmWorkflow: { mode: 'auto', verify: true },
      }),
    ],
    {
      loaded: true,
      enabled: new Map([[OpenClawExtensionId.SWARM_WORKFLOW, true]]),
      disabledRevisions: new Map(),
    },
  );
  render(<ComposerFeatureMenu items={items} label="Features" />);
  fireEvent.click(screen.getByRole('button'));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Swarm Workflow' }));
  expect(selectSwarmWorkflow).toHaveBeenCalledWith({ mode: 'auto', verify: true });
  expect(items[0].selected).toBe(true);
});

test('does not register Swarm while its plugin is disabled even with a selected draft', () => {
  const selectSwarmWorkflow = vi.fn();
  expect(
    buildComposerFeatures(
      [
        buildSwarmWorkflowComposerFeature({
          selectSwarmWorkflow,
          swarmWorkflow: { mode: 'auto', verify: true },
        }),
      ],
      {
        loaded: true,
        enabled: new Map([[OpenClawExtensionId.SWARM_WORKFLOW, false]]),
        disabledRevisions: new Map(),
      },
    ),
  ).toEqual([]);
  expect(selectSwarmWorkflow).not.toHaveBeenCalled();
});

test('plugin entries are independently gated and built-in entries do not require a plugin', () => {
  const select = vi.fn();
  const registrations = [
    { ...item('Swarm'), extensionId: OpenClawExtensionId.SWARM_WORKFLOW },
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

test('nested features coexist with flat entries and return to the root without selecting', () => {
  const child = item('Discussion');
  const team = { ...item('Team'), children: [child] };
  render(<ComposerFeatureMenu items={[item('Swarm'), team]} label="Features" backLabel="Back" />);
  fireEvent.click(screen.getByRole('button', { name: 'Features' }));
  fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Team' }), { key: 'ArrowRight' });
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Discussion' }));
  expect(screen.queryByRole('menuitem', { name: 'Back' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Team' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Team' }));
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
  expect(screen.getByRole('menuitem', { name: 'Swarm' })).toBeTruthy();
  expect(team.onSelect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Team' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Discussion' }));
  expect(child.onSelect).toHaveBeenCalledOnce();
  expect(screen.queryByRole('menu')).toBeNull();
});

test('registers Swarm and both Team modes in one menu with independent actions', () => {
  i18nService.setLanguage('en', { persist: false });
  const selectSwarm = vi.fn();
  const selectTeam = vi.fn();
  const items = buildComposerFeatures(
    [
      buildSwarmWorkflowComposerFeature({ selectSwarmWorkflow: selectSwarm }),
      buildAgentTeamFeature('group', selectTeam),
    ],
    {
      loaded: true,
      enabled: new Map([
        [OpenClawExtensionId.SWARM_WORKFLOW, true],
        [OpenClawExtensionId.AGENT_TEAM, true],
      ]),
      disabledRevisions: new Map(),
    },
  );
  render(<ComposerFeatureMenu items={items} label="Features" backLabel="Back" />);
  expect(screen.getAllByRole('button')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button'));
  fireEvent.click(screen.getByRole('menuitem', { name: items[1].label }));
  const choices = screen.getAllByRole('menuitemradio');
  expect(choices).toHaveLength(2);
  expect(choices[0].getAttribute('aria-checked')).toBe('true');
  fireEvent.click(choices[1]);
  expect(selectTeam).toHaveBeenCalledWith('task');
  expect(selectSwarm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button'));
  fireEvent.click(screen.getByRole('menuitem', { name: items[0].label }));
  expect(selectSwarm).toHaveBeenCalledWith({ mode: 'auto', verify: true });
});

test('removing Team while its submenu is open preserves the attachment action', () => {
  const selectTeam = vi.fn();
  const attachments = item('Attachments');
  const team = buildAgentTeamFeature('group', selectTeam);
  const settings = (enabled: boolean): ExtensionEnablement => ({
    loaded: true,
    enabled: new Map([[OpenClawExtensionId.AGENT_TEAM, enabled]]),
    disabledRevisions: new Map(),
  });
  const view = render(
    <ComposerFeatureMenu
      items={buildComposerFeatures([attachments, team], settings(true))}
      label="Features"
      backLabel="Back"
    />,
  );
  fireEvent.click(screen.getByRole('button'));
  fireEvent.click(screen.getByRole('menuitem', { name: team.label }));
  expect(screen.getAllByRole('menuitemradio')).toHaveLength(2);
  view.rerender(
    <ComposerFeatureMenu
      items={buildComposerFeatures([attachments, team], settings(false))}
      label="Features"
      backLabel="Back"
    />,
  );
  expect(screen.queryByRole('menuitemradio')).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Attachments' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Attachments' }));
  expect(attachments.onSelect).toHaveBeenCalledOnce();
  expect(selectTeam).not.toHaveBeenCalled();
});

test('an open submenu uses the current mode and callback after rerendering', () => {
  const oldSelect = vi.fn();
  const select = vi.fn();
  const view = render(
    <ComposerFeatureMenu items={[buildAgentTeamFeature('group', oldSelect)]} label="Features" />,
  );
  fireEvent.click(screen.getByRole('button'));
  fireEvent.click(screen.getByRole('menuitem'));
  view.rerender(
    <ComposerFeatureMenu items={[buildAgentTeamFeature('task', select)]} label="Features" />,
  );
  const choices = screen.getAllByRole('menuitemradio');
  expect(choices[1].getAttribute('aria-checked')).toBe('true');
  fireEvent.click(choices[0]);
  expect(select).toHaveBeenCalledWith('group');
  expect(oldSelect).not.toHaveBeenCalled();
});
