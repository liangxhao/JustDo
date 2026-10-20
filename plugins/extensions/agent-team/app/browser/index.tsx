import type { AppBrowserHost } from '@app-plugin/sdk/browser';
import { UserGroupIcon } from '@heroicons/react/24/outline';
import { useEffect } from 'react';
import AgentTeamSettingsDialog from './settings/AgentTeamSettingsDialog';
import { bindBrowserHost } from './ports';
import { TeamSummary, TeamWorkspace } from './workspace';
import { TeamApplicationPage, currentFocusedRoom } from './applicationPage';
import { parseTeamDiscussionSessionKey } from '../../contracts/teamDiscussion';
import { application } from './ports';
import { OPEN_TEAM_RECORDS } from './display/agentTeamHistory';
import { appendAgentTeamInstruction } from '../../prompt/agentTeamPrompt';
import {
  registerSessionPresentation,
  teamDetailsPresentation,
  TeamSessionDetails,
} from './sessionPresentation';
import { useOwnerDocument } from './ui';

export function register(host: AppBrowserHost): () => void {
  const release = bindBrowserHost(host);
  const releasePresentation = registerSessionPresentation(host);
  host.registerView({
    id: 'session-details',
    slot: 'session.details',
    labelKey: 'teamTitle',
    detailsPresentation: teamDetailsPresentation,
    component: TeamSessionDetails,
  });
  for (const [order, mode] of (['group', 'task'] as const).entries())
    host.registerMode({
      id: mode,
      labelKey: mode === 'task' ? 'teamTask' : 'teamGroup',
      order,
      group: {
        id: 'team',
        labelKey: 'teamTitle',
        icon: <UserGroupIcon />,
        order: 20,
        backLabelKey: 'teamFeatureBack',
      },
      icon: <UserGroupIcon />,
      removeLabelKey: 'teamFeatureRemove',
      ordinaryTurnOnly: true,
      prepare: async input => {
        if (input.planModeEnabled || input.queued || input.prompt.trimStart().startsWith('/'))
          throw new Error('teamFeatureConflict');
        return { prompt: appendAgentTeamInstruction(input.prompt, mode) };
      },
    });
  host.registerView({
    id: 'page',
    slot: 'application.page',
    labelKey: 'teamTitle',
    component: TeamApplicationPage,
  });
  host.registerInteractionPresentation(key => {
    const identity = parseTeamDiscussionSessionKey(key);
    if (!identity) return undefined;
    return {
      visible: identity.roomId === currentFocusedRoom(),
      label: `${host.t('teamGroup')} · ${application.metadata.getSnapshot().agent.agents.find(agent => agent.id === identity.agentId)?.name ?? ''}`,
    };
  });
  host.registerView({
    id: 'history',
    slot: 'plugin.history',
    labelKey: 'teamAllRecords',
    component: ({ onClose }) => {
      const ownerDocument = useOwnerDocument();
      useEffect(() => {
        window.dispatchEvent(new CustomEvent(OPEN_TEAM_RECORDS, { detail: ownerDocument }));
        onClose?.();
      }, [ownerDocument, onClose]);
      return null;
    },
  });
  host.registerView({
    id: 'team',
    slot: 'workspace.tab',
    labelKey: 'teamTitle',
    icon: <UserGroupIcon className="h-4 w-4" />,
    component: TeamWorkspace,
  });
  host.registerView({
    id: 'team-summary',
    slot: 'session.summary',
    order: 20,
    labelKey: 'teamTitle',
    component: TeamSummary,
  });
  host.registerView({
    id: 'settings',
    slot: 'plugin.settings',
    labelKey: 'agentTeamSettings',
    component: ({ onClose }) => (
      <AgentTeamSettingsDialog
        onClose={onClose ?? (() => undefined)}
        onOpenRuntime={() => host.application.navigation.showSettings({ initialTab: 'runtime' })}
      />
    ),
  });
  return () => {
    releasePresentation();
    release();
  };
}
