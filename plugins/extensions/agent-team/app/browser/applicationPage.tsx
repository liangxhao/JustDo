import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppViewContext } from '@app-plugin/sdk/browser';

import TeamDiscussionView, { useAgentTeamEntry } from './discussions/TeamDiscussionView';
import {
  OPEN_TEAM_PANEL,
  prepareDiscussionSource,
  TEAM_ROOM_FOCUSED,
} from './discussions/teamDiscussionNavigation';
import { appendDiscussionReference, appendTeamResultDraft } from './discussions/teamResultDraft';
import AgentTeamHistoryDialog from './display/AgentTeamHistoryDialog';
import { OPEN_TEAM_RECORDS, openTeamHistoryEntry } from './display/agentTeamHistory';
import { groupTeamKey } from './display/agentTeamEntries';
import { application, browserHost } from './ports';
import { OwnerDocumentProvider, useOwnerDocument } from './ui';

export { currentFocusedRoom } from './discussions/teamDiscussionFocus';
export function TeamApplicationPage({ navigation, active, page }: AppViewContext) {
  const host = browserHost();
  const ownerDocument = useOwnerDocument();
  const [entry, setEntry] = useAgentTeamEntry();
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const navigationRevision = useRef(navigation?.revision);
  navigationRevision.current = navigation?.revision;
  const [historyDocument, setHistoryDocument] = useState<Document | null>(null);
  const historyDocumentRef = useRef(historyDocument);
  historyDocumentRef.current = historyDocument;
  const closeHistory = useCallback(() => {
    historyDocumentRef.current = null;
    setHistoryDocument(null);
  }, []);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(
    () =>
      host.onNavigation(() => {
        setEntry(null);
        closeHistory();
      }),
    [host, closeHistory],
  );
  useEffect(() => {
    const open = (event: Event) => {
      const { sessionId, roomId, teamKey } = (
        event as CustomEvent<{ sessionId: string; roomId: string; teamKey?: string }>
      ).detail;
      setEntry(null);
      closeHistory();
      navigation?.showChat();
      host.openWorkspace('team', sessionId, {
        key: teamKey ?? groupTeamKey(roomId),
        version: Date.now(),
      });
    };
    const records = (event: Event) => {
      const requested = (event as CustomEvent<Document | undefined>).detail;
      const target = requested?.nodeType === 9 && requested.body ? requested : ownerDocument;
      if (target.defaultView?.closed) return;
      historyDocumentRef.current = target;
      setHistoryDocument(target);
    };
    const focus = () => host.interactionContextChanged();
    window.addEventListener(OPEN_TEAM_PANEL, open);
    window.addEventListener(OPEN_TEAM_RECORDS, records);
    window.addEventListener(TEAM_ROOM_FOCUSED, focus);
    return () => {
      window.removeEventListener(OPEN_TEAM_PANEL, open);
      window.removeEventListener(OPEN_TEAM_RECORDS, records);
      window.removeEventListener(TEAM_ROOM_FOCUSED, focus);
    };
  }, [host, navigation, ownerDocument, closeHistory]);
  useEffect(() => {
    if (entry) {
      navigation?.showChat();
    }
  }, [entry]);
  useEffect(() => {
    page?.setVisible(entry !== null);
  }, [entry, page?.setVisible]);
  useEffect(() => {
    closeHistory();
  }, [entry, navigation?.revision, closeHistory]);
  useEffect(() => {
    const ownerWindow = historyDocument?.defaultView;
    if (!ownerWindow) return;
    const close = () => {
      if (historyDocumentRef.current === historyDocument) closeHistory();
    };
    ownerWindow.addEventListener('pagehide', close);
    return () => ownerWindow.removeEventListener('pagehide', close);
  }, [historyDocument, closeHistory]);
  const reportError = (error: unknown) =>
    window.dispatchEvent(
      new CustomEvent('app:showToast', {
        detail: host.t(error instanceof Error ? error.message : 'teamDiscussionUnavailable'),
      }),
    );
  const prepare = async (id: string, action: () => void) => {
    if (!navigation) return;
    const origin = entry;
    const revision = navigation.revision;
    await prepareDiscussionSource(
      id,
      {
        requestTransition: navigation.requestTransition,
        isCurrent: () =>
          alive.current &&
          !host.signal.aborted &&
          entryRef.current === origin &&
          navigationRevision.current === revision,
        reportError,
      },
      () => {
        action();
        setEntry(null);
        navigation.showChat();
      },
    );
  };
  return (
    <>
      {entry && (
        <div className="h-full">
          <TeamDiscussionView
            key={entry.roomId ?? entry.sourceSessionId ?? 'new'}
            entry={entry}
            active={active}
            onClose={() => {
              setEntry(null);
              navigation?.showChat();
            }}
            onPrepareSourceDraft={(id, draft) =>
              prepare(id, () => appendTeamResultDraft(id, draft))
            }
            onReferenceSource={(id, quote) =>
              prepare(id, () => appendDiscussionReference(id, quote))
            }
          />
        </div>
      )}
      {historyDocument && (
        <OwnerDocumentProvider value={historyDocument}>
          <AgentTeamHistoryDialog
            onClose={closeHistory}
            onOpen={async (item, isCurrent) => {
              if (!navigation) return;
              const origin = application.metadata.getSnapshot().cowork.currentSession?.id;
              const revision = navigation.revision;
              const isCurrentHistory = () =>
                alive.current &&
                historyDocumentRef.current === historyDocument &&
                !historyDocument.defaultView?.closed &&
                isCurrent() &&
                !host.signal.aborted &&
                navigationRevision.current === revision &&
                [origin, item.sourceSessionId].includes(
                  application.metadata.getSnapshot().cowork.currentSession?.id,
                );
              await openTeamHistoryEntry(item, {
                requestTransition: navigation.requestTransition,
                isCurrent: isCurrentHistory,
              });
              if (isCurrentHistory()) closeHistory();
            }}
          />
        </OwnerDocumentProvider>
      )}
    </>
  );
}
