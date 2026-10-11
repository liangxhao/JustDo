import { ChatBubbleLeftRightIcon, ChevronRightIcon, ShareIcon } from '@heroicons/react/24/outline';

import { i18nService } from '@/services/i18n';

import { type AgentTeamEntry, AgentTeamKind } from './agentTeamEntries';

export default function AgentTeamRecordSummary({
  entry,
  title = entry.label,
  memberNames,
  caption,
}: {
  entry: AgentTeamEntry;
  title?: string;
  memberNames?: string[];
  caption?: string;
}) {
  const group = entry.kind === AgentTeamKind.GROUP;
  const groupPrefix = `${i18nService.t('teamGroup')} · `;
  const displayTitle =
    group && title.startsWith(groupPrefix) ? title.slice(groupPrefix.length) : title;
  const Icon = group ? ChatBubbleLeftRightIcon : ShareIcon;
  const tone = group
    ? 'bg-teal-500/10 text-teal-600 dark:text-teal-400'
    : 'bg-violet-500/10 text-violet-600 dark:text-violet-400';
  const status = ['teamRecordFailed', 'teamRecordPrepareFailed', 'teamRecordUnconfirmed'].includes(
    entry.statusKey,
  )
    ? 'bg-amber-500'
    : ['teamRecordRunning', 'teamRecordOpen', 'teamRecordSubmitting'].includes(entry.statusKey)
      ? 'bg-primary'
      : 'bg-secondary/50';
  return (
    <>
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tone}`}>
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-foreground" title={title}>
          {displayTitle}
        </span>
        <span className="mt-1.5 flex min-w-0 items-center gap-2 text-[11px] text-secondary">
          <span className={`shrink-0 rounded-md px-1.5 py-0.5 ${tone}`}>
            {i18nService.t(group ? 'teamGroup' : 'teamTask')}
          </span>
          <span className="flex shrink-0 items-center gap-1">
            <span className={`h-1.5 w-1.5 rounded-full ${status}`} />
            {i18nService.t(entry.statusKey)}
          </span>
          <span className="truncate">{caption}</span>
        </span>
        {memberNames && (
          <span className="mt-2 flex min-w-0 items-center gap-2 text-xs text-secondary">
            <span className="flex shrink-0 -space-x-1.5" aria-hidden="true">
              {memberNames.slice(0, 3).map((name, index) => (
                <span
                  key={index}
                  className={`flex h-5 w-5 items-center justify-center rounded-full border-2 border-surface text-[9px] font-medium ${tone}`}
                >
                  {Array.from(name)[0]}
                </span>
              ))}
            </span>
            <span className="truncate">{memberNames.join(' · ')}</span>
          </span>
        )}
        {!memberNames && (
          <span className="mt-1 block text-[11px] text-secondary">
            {i18nService.t('teamRecordMembers')}: {entry.memberCount}
          </span>
        )}
      </span>
      <ChevronRightIcon
        className="h-3.5 w-3.5 shrink-0 text-secondary/50 transition-transform group-hover:translate-x-0.5"
        aria-hidden="true"
      />
    </>
  );
}
