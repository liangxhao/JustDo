// @vitest-environment jsdom
import type {
  AppBrowserContribution,
  AppBrowserHost,
  AppComposerMode,
} from '@app-plugin/sdk/browser';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ host: undefined as AppBrowserHost | undefined }));
vi.mock('./settings/AgentTeamSettingsDialog', () => ({
  default: ({ onClose, onOpenRuntime }: { onClose(): void; onOpenRuntime?(): void }) => (
    <button
      onClick={() => {
        onClose();
        onOpenRuntime?.();
      }}
    >
      Runtime settings
    </button>
  ),
}));
vi.mock('./ports', () => ({
  bindBrowserHost: () => () => undefined,
  browserHost: () => fixture.host!,
  application: { metadata: { getSnapshot: () => ({ agent: { agents: [] } }) } },
}));
vi.mock('./workspace', () => ({ TeamSummary: () => null, TeamWorkspace: () => null }));
vi.mock('./applicationPage', () => ({
  TeamApplicationPage: () => null,
  currentFocusedRoom: () => null,
}));
vi.mock('./display/agentTeamHistory', () => ({ OPEN_TEAM_RECORDS: 'open-team-records' }));
vi.mock('./ui', () => ({ useOwnerDocument: () => document }));
vi.mock('./sessionPresentation', () => ({
  registerSessionPresentation: () => () => undefined,
  teamDetailsPresentation: () => 'hidden',
  TeamSessionDetails: () => null,
}));

import { register } from './index';

afterEach(cleanup);

function registrations() {
  const views: AppBrowserContribution[] = [];
  const modes: AppComposerMode[] = [];
  const showSettings = vi.fn();
  fixture.host = {
    registerTranslations: vi.fn(),
    registerMessagePresentation: vi.fn(),
    registerInteractionPresentation: vi.fn(),
    registerView: (view: AppBrowserContribution) => {
      views.push(view);
      return () => undefined;
    },
    registerMode: (mode: AppComposerMode) => {
      modes.push(mode);
      return () => undefined;
    },
    application: { navigation: { showSettings } },
  } as unknown as AppBrowserHost;
  const release = register(fixture.host);
  return { views, modes, showSettings, release };
}

test('Team settings exposes the existing runtime destination and keeps its history action label', () => {
  const { views, showSettings, release } = registrations();
  const Settings = views.find(view => view.slot === 'plugin.settings')!.component;
  const close = vi.fn();
  render(<Settings onClose={close} />);
  fireEvent.click(screen.getByRole('button', { name: 'Runtime settings' }));
  expect(close).toHaveBeenCalledTimes(1);
  expect(showSettings).toHaveBeenCalledExactlyOnceWith({ initialTab: 'runtime' });
  expect(views.find(view => view.slot === 'plugin.history')?.labelKey).toBe('teamAllRecords');
  expect(views.find(view => view.slot === 'session.summary')?.order).toBe(20);
  expect(views.some(view => view.slot === 'chat.action')).toBe(false);
  release();
});

test('Team declarations retain the group-before-task menu and explicit chip controls', () => {
  const { modes, release } = registrations();
  expect(modes.map(mode => ({ id: mode.id, order: mode.order }))).toEqual([
    { id: 'group', order: 0 },
    { id: 'task', order: 1 },
  ]);
  for (const mode of modes) {
    expect(mode.group).toMatchObject({
      id: 'team',
      order: 20,
      labelKey: 'teamTitle',
      backLabelKey: 'teamFeatureBack',
    });
    expect(mode.group?.icon).toBeTruthy();
    expect(mode.icon).toBeTruthy();
    expect(mode.removeLabelKey).toBe('teamFeatureRemove');
  }
  release();
});
