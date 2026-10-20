type TeamDiscussionResult<T> = { success: true; value: T } | { success: false; error: string };
import type { AppBrowserHost } from '@app-plugin/sdk/browser';
import type {
  AgentTeamKind,
  AgentTeamOverrides,
  AgentTeamSettings,
  AgentTeamSettingsSnapshot,
  AgentTeamSettingsView,
} from '../../contracts/agentTeamSettings';

import type { AppServices } from '@app-plugin/sdk/application';
import type { TeamApis } from './api';
import { bindContinueDraftStorage } from '../../browser/collaboration/collaborationContinueDraft';
import { bindDiscussionDraftStorage } from '../../browser/discussion/teamDiscussionDraft';

let current: AppBrowserHost | undefined;
export const bindBrowserHost = (host: AppBrowserHost): (() => void) => {
  current = host;
  const releases = host.uiState
    ? [bindContinueDraftStorage(host.uiState), bindDiscussionDraftStorage(host.uiState)]
    : [];
  return () => {
    releases.forEach(release => release());
    if (current === host) current = undefined;
  };
};
export const invoke = <T>(command: string, ...args: unknown[]): Promise<T> => {
  if (!current || current.signal.aborted) return Promise.reject(new Error('appPluginUnavailable'));
  return current.invoke<T>(command, ...args);
};
export const browserHost = () => {
  if (!current || current.signal.aborted) throw new Error('appPluginUnavailable');
  return current;
};
export const application = new Proxy({} as AppServices, {
  get: (_target, key) => Reflect.get(browserHost().application, key),
});
export const settingsApi = {
  read: () => invoke<TeamDiscussionResult<AgentTeamSettingsSnapshot>>('settings.read'),
  save: (value: AgentTeamSettings, expectedRevision: number) =>
    invoke<TeamDiscussionResult<AgentTeamSettingsSnapshot>>('settings.save', {
      value,
      expectedRevision,
    }),
  readTeam: (kind: AgentTeamKind, roomId: string) =>
    invoke<TeamDiscussionResult<AgentTeamSettingsView>>('settings.read-team', { kind, roomId }),
  saveTeam: (
    kind: AgentTeamKind,
    roomId: string,
    value: AgentTeamOverrides,
    expectedRevision: number,
  ) =>
    invoke<TeamDiscussionResult<AgentTeamSettingsView>>('settings.save-team', {
      kind,
      roomId,
      value,
      expectedRevision,
    }),
};
const methods = (mapping: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(mapping).map(([name, command]) => [
      name,
      (...args: unknown[]) => invoke(command, ...args),
    ]),
  );
export const teamApi: TeamApis = {
  agentTeamSettings: settingsApi,
  teamDiscussion: methods({
    participation: 'discussion.participation',
    createTask: 'discussion.create-task',
    list: 'discussion.list',
    create: 'discussion.create',
    read: 'discussion.read',
    send: 'discussion.send',
    enqueue: 'discussion.enqueue',
    cancelPending: 'discussion.cancel',
    stop: 'discussion.stop',
    delete: 'discussion.delete',
  }) as TeamApis['teamDiscussion'],
  collaboration: {
    ...methods({
      prepareContinuation: 'collaboration.continue',
      read: 'collaboration.read',
      list: 'collaboration.list',
      stop: 'collaboration.stop',
      stopMember: 'collaboration.stop-member',
    }),
    create: (sessionId, agentIds) => invoke('collaboration.create', { sessionId, agentIds }),
    readMessages: (sessionId, deliveryIds) =>
      invoke('collaboration.messages', { sessionId, deliveryIds }),
  } as TeamApis['collaboration'],
};
