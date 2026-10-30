import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { vi } from 'vitest';

import { bindBrowserHost } from '../app/browser/ports';
import { agentTeamTranslations } from '../app/browser/translations';

vi.mock('../app/browser/state', () => import('./host/state'));

const commands: Record<string, [string, string]> = {
  'settings.read': ['agentTeamSettings', 'read'],
  'settings.save': ['agentTeamSettings', 'save'],
  'settings.read-team': ['agentTeamSettings', 'readTeam'],
  'settings.save-team': ['agentTeamSettings', 'saveTeam'],
  ...Object.fromEntries(
    Object.entries({
      create: 'create',
      read: 'read',
      list: 'list',
      stop: 'stop',
      'stop-member': 'stopMember',
      messages: 'readMessages',
      continue: 'prepareContinuation',
    }).map(([command, method]) => [`collaboration.${command}`, ['collaboration', method]]),
  ),
  ...Object.fromEntries(
    Object.entries({
      participation: 'participation',
      'create-task': 'createTask',
      list: 'list',
      create: 'create',
      read: 'read',
      send: 'send',
      enqueue: 'enqueue',
      cancel: 'cancelPending',
      stop: 'stop',
      delete: 'delete',
    }).map(([command, method]) => [`discussion.${command}`, ['teamDiscussion', method]]),
  ),
};
const hostRoot = process.env.APP_PLUGIN_HOST_ROOT;
if (hostRoot) {
  const { installBrowserBehaviorPorts } = await import(
    /* @vite-ignore */
    pathToFileURL(path.join(hostRoot, 'tests/plugin-host/legacyBehaviorPorts.ts')).href
  );
  installBrowserBehaviorPorts({
    pluginRoot: path.resolve(import.meta.dirname, '..'),
    bindBrowserHost,
    translations: agentTeamTranslations,
    async invoke(
      command: string,
      args: unknown[],
      bridge: Record<string, Record<string, (...args: unknown[]) => unknown>>,
    ) {
      const pair = commands[command];
      if (!pair) throw new Error(`Unknown fixture command ${command}`);
      if (command === 'collaboration.create') {
        const input = args[0] as { sessionId: string; agentIds: string[] };
        args = [input.sessionId, input.agentIds];
      } else if (command === 'collaboration.messages') {
        const input = args[0] as { sessionId: string; deliveryIds: string[] };
        args = [input.sessionId, input.deliveryIds];
      } else if (command.startsWith('settings.')) {
        const input = args[0] as {
          kind: string;
          roomId: string;
          value: unknown;
          expectedRevision: number;
        };
        if (command === 'settings.save') args = [input.value, input.expectedRevision];
        else if (command === 'settings.read-team') args = [input.kind, input.roomId];
        else if (command === 'settings.save-team')
          args = [input.kind, input.roomId, input.value, input.expectedRevision];
      }
      return bridge[pair[0]][pair[1]](...args);
    },
  });
}
