import { ChevronRightIcon } from '@heroicons/react/24/outline';
import type { CollaborationRoom } from '@shared/cowork/agent-team/collaboration';
import { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';

import { coworkService } from '@/features/cowork/coworkService';
import type { CoworkSessionSummary } from '@/features/cowork/coworkTypes';
import { i18nService } from '@/services/i18n';
import type { RootState } from '@/store';

import { COLLABORATION_PALETTE } from '../shared/collaborationPalette';

type Detail = Awaited<ReturnType<typeof coworkService.getSessionDetails>>;

export default function CollaborationTaskDetails({
  room,
  onSelect,
}: {
  room: CollaborationRoom;
  onSelect: (session: CoworkSessionSummary) => void;
}) {
  const agents = useSelector((state: RootState) => state.agent.agents);
  const [loaded, setLoaded] = useState<{ key: string; rows: Detail[] }>();
  const key = JSON.stringify(room.members.map(member => member.sessionId));
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const ids = JSON.parse(key) as string[];
      const rows = await Promise.all(
        ids.map(id => coworkService.getSessionDetails(id).catch(() => ({ session: null }))),
      );
      if (disposed) return;
      setLoaded({ key, rows });
      timer = setTimeout(() => void refresh(), 5000);
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [key]);
  const rows = loaded?.key === key ? loaded.rows : undefined;
  return (
    <section className="space-y-4">
      {room.deleting && (
        <p role="alert" className="text-sm text-red-500">
          {i18nService.t('collaborationDeletePending')}
        </p>
      )}
      <h3 className="text-xs font-semibold text-secondary">
        {i18nService.t('collaborationMembers')} · {room.members.length}
      </h3>
      <ul className="space-y-2">
        {room.members.map((member, index) => {
          const row = rows?.[index];
          const name = agents.find(agent => agent.id === member.agentId)?.name || member.agentId;
          return (
            <li key={member.sessionId}>
              <button
                type="button"
                disabled={!row?.session}
                onClick={() => row?.session && onSelect(row.session)}
                title={name}
                className="group flex w-full items-center gap-3 rounded-xl border border-border bg-surface px-3 py-3 text-left text-sm transition-colors enabled:hover:border-primary/30 enabled:hover:bg-surface-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50"
              >
                <span
                  aria-hidden="true"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white"
                  style={{
                    backgroundColor:
                      COLLABORATION_PALETTE[index % COLLABORATION_PALETTE.length].stroke,
                  }}
                >
                  {Array.from(name.trim())[0]?.toLocaleUpperCase() || '?'}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
                <ChevronRightIcon
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 text-secondary group-hover:text-primary"
                />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
