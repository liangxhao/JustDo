import type { TeamDiscussionRoom } from '@shared/cowork/agent-team/teamDiscussion';
import { useEffect, useRef, useState } from 'react';

import { coworkService } from '@/features/cowork/coworkService';
import { store } from '@/store';

import { openAgentTeam } from '../composer/ComposerMoreMenu';
import {
  type FilePreviewNavigationOptions,
  runGuardedFilePreviewNavigation,
} from '../preview/filePreviewNavigation';

export const OPEN_TEAM_PANEL = 'cowork:open-team-panel';
export const TEAM_ROOM_FOCUSED = 'cowork:team-room-focused';
export const TEAM_ROOMS_CHANGED = 'app:team-rooms-changed';

export async function openTeamPanel(
  room: TeamDiscussionRoom,
  navigation: {
    requestTransition: (options?: FilePreviewNavigationOptions) => Promise<boolean>;
    isCurrent: () => boolean;
  },
): Promise<void> {
  await runGuardedFilePreviewNavigation(
    navigation.requestTransition,
    async () => {
      if (!navigation.isCurrent()) return;
      if (!room.sourceSessionId) {
        openAgentTeam({ roomId: room.id });
        return;
      }
      const loaded = await coworkService
        .loadSession(room.sourceSessionId, { canSelect: navigation.isCurrent })
        .catch(() => null);
      if (!navigation.isCurrent()) return;
      // Discussions retain their native history when the organizing task is deleted.
      if (!loaded) {
        openAgentTeam({ roomId: room.id });
        return;
      }
      if (store.getState().cowork.currentSession?.id !== room.sourceSessionId) return;
      window.dispatchEvent(
        new CustomEvent(OPEN_TEAM_PANEL, {
          detail: { sessionId: room.sourceSessionId, roomId: room.id },
        }),
      );
    },
    { preserveTabs: true },
  );
}

/** Prepare source drafts only while their originating group is still selected. */
export async function prepareDiscussionSource(
  sessionId: string,
  navigation: {
    requestTransition: (options?: FilePreviewNavigationOptions) => Promise<boolean>;
    isCurrent: () => boolean;
    reportError?: (error: unknown) => void;
  },
  prepare: () => void,
): Promise<void> {
  let selected = false;
  let prepared = false;
  let preparationFailure: { error: unknown } | undefined;
  try {
    await runGuardedFilePreviewNavigation(navigation.requestTransition, async () => {
      if (!navigation.isCurrent()) return;
      const loaded = await coworkService.loadSession(sessionId, {
        canSelect: navigation.isCurrent,
        onSelected: () => {
          selected = true;
          try {
            prepare();
            prepared = true;
          } catch (error) {
            preparationFailure = { error };
            throw error;
          }
        },
      });
      if (!navigation.isCurrent()) return;
      if (!loaded) throw new Error('teamDiscussionNotFound');
    });
  } catch (error) {
    // A later hydration failure must not turn a committed reference into a failed action.
    if (prepared || (!selected && !navigation.isCurrent())) return;
    const failure = preparationFailure?.error ?? error;
    // Source selection can unmount the group; report through its stable App owner.
    if (navigation.reportError) navigation.reportError(failure);
    else throw failure;
  }
}

/** Navigation stores metadata only; each mounted message view reads native history. */
export function useTeamDiscussionRooms(onCreated?: (room: TeamDiscussionRoom) => void) {
  const [rooms, setRooms] = useState<TeamDiscussionRoom[]>([]);
  const callback = useRef(onCreated);
  callback.current = onCreated;
  useEffect(() => {
    let live = true;
    let revision = 0;
    let observed: Set<string> | undefined;
    const refresh = async () => {
      const request = ++revision;
      try {
        const result = await window.electron?.teamDiscussion?.list();
        if (!live || request !== revision || !result?.success) return;
        const newlyCreated = observed ? result.value.filter(room => !observed!.has(room.id)) : [];
        observed ??= new Set<string>();
        result.value.forEach(room => observed!.add(room.id));
        setRooms(result.value);
        newlyCreated.forEach(room => callback.current?.(room));
      } catch {
        /* A later metadata notification retries the read. */
      }
    };
    void refresh();
    const off = window.electron?.cowork?.onSessionsChanged?.(() => void refresh());
    window.addEventListener(TEAM_ROOMS_CHANGED, refresh);
    return () => {
      live = false;
      off?.();
      window.removeEventListener(TEAM_ROOMS_CHANGED, refresh);
    };
  }, []);
  return rooms;
}
