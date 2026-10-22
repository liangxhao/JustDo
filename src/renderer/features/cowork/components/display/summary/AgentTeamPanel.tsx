import { UserGroupIcon } from '@heroicons/react/24/outline';
import type { ComponentProps } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';

import { i18nService } from '@/services/i18n';

import CollaborationPanel, { useCollaborationRooms } from '../../collaboration/CollaborationPanel';
import { useTeamDiscussionRooms } from '../../discussions/teamDiscussionNavigation';
import TeamDiscussionView from '../../discussions/TeamDiscussionView';
import { appendDiscussionReference, appendTeamResultDraft } from '../../discussions/teamResultDraft';
import {
  type AgentTeamEntry,
  AgentTeamKind,
  buildAgentTeamEntries,
  groupTeamKey,
} from './agentTeamEntries';

export default function AgentTeamPanel(
  props: ComponentProps<typeof CollaborationPanel> & {
    discussionId?: string;
    selectionRequest?: { key?: string; version: number };
    onFocusComposer?: () => void;
  },
) {
  const groups = useTeamDiscussionRooms();
  const collaborations = useCollaborationRooms();
  const tabs = buildAgentTeamEntries(props.source.id, collaborations, groups, key =>
    i18nService.t(key),
  );
  const taskTabs = tabs.filter(tab => tab.kind === AgentTeamKind.TASK);
  const requestedKey =
    props.selectionRequest?.key ??
    (props.discussionId ? groupTeamKey(props.discussionId) : undefined);
  const requestVersion = props.selectionRequest?.version;
  const [selection, setSelection] = useState({
    sourceId: props.source.id,
    requestVersion,
    key: requestedKey,
  });
  // A new header request overrides manual tab selection without remounting the current view.
  const selectedKey =
    selection.sourceId === props.source.id && selection.requestVersion === requestVersion
      ? selection.key
      : requestedKey;
  const activeTab =
    tabs.find(tab => tab.key === selectedKey) ?? taskTabs[taskTabs.length - 1] ?? tabs[0];
  const tabsRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const container = tabsRef.current;
    const active = container?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
    if (!container || !active) return;
    const bounds = container.getBoundingClientRect();
    const selected = active.getBoundingClientRect();
    if (selected.left < bounds.left + 12) {
      container.scrollLeft -= bounds.left + 12 - selected.left;
    } else if (selected.right > bounds.right - 12) {
      container.scrollLeft += selected.right - bounds.right + 12;
    }
  }, [activeTab?.key, tabs.length]);
  const selectTab = (tab: AgentTeamEntry) => {
    props.onSelect(undefined);
    setSelection({ sourceId: props.source.id, requestVersion, key: tab.key });
  };
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label={i18nService.t('teamTitle')}>
      {tabs.length > 0 && (
        <nav
          ref={tabsRef}
          className="flex h-10 shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border-subtle bg-background px-3"
          aria-label={i18nService.t('teamRecords')}
        >
          {tabs.map(tab => (
            <button
              key={tab.key}
              type="button"
              title={tab.label}
              className="inline-flex h-7 max-w-56 shrink-0 items-center gap-1.5 rounded-lg border border-transparent px-2.5 text-[13px] font-medium text-secondary transition-colors hover:bg-surface-raised hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary aria-pressed:border-border-input aria-pressed:bg-primary-muted aria-pressed:text-primary"
              aria-pressed={activeTab?.key === tab.key}
              onClick={() => selectTab(tab)}
            >
              <UserGroupIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 truncate">{tab.label}</span>
            </button>
          ))}
        </nav>
      )}
      <div className="min-h-0 flex-1">
        {activeTab?.kind === AgentTeamKind.GROUP ? (
          <TeamDiscussionView
            key={activeTab.key}
            entry={{ roomId: activeTab.roomId }}
            embedded
            onReferenceSource={async (sessionId, quote) => {
              if (sessionId !== props.source.id) throw new Error('teamDiscussionNotFound');
              appendDiscussionReference(sessionId, quote);
              props.onFocusComposer?.();
            }}
            onPrepareSourceDraft={async (sessionId, draft) => {
              if (sessionId !== props.source.id) throw new Error('teamDiscussionNotFound');
              appendTeamResultDraft(sessionId, draft);
            }}
            onClose={() => {
              if (taskTabs.length) selectTab(taskTabs[taskTabs.length - 1]);
            }}
          />
        ) : activeTab ? (
          <CollaborationPanel
            key={activeTab.key}
            {...props}
            roomId={activeTab.roomId}
            roundId={activeTab.roundId}
          />
        ) : (
          <p className="p-4 text-sm text-secondary">{i18nService.t('teamNoTeams')}</p>
        )}
      </div>
    </section>
  );
}
