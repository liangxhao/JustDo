import { UserCircleIcon } from '@heroicons/react/24/solid';
import { useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';

import { setCurrentAgentId } from '@/features/agents/agentSlice';
import { i18nService } from '@/services/i18n';
import ThemedSelect from '@/shared/components/ui/ThemedSelect';
import type { RootState } from '@/store';

export function ConversationAgentSelector({
  agentId,
  disabled,
  onChange,
}: {
  agentId: string;
  disabled: boolean;
  onChange?: (agentId: string) => void | Promise<void>;
}) {
  const dispatch = useDispatch();
  const agents = useSelector((state: RootState) => state.agent.agents);
  const [pending, setPending] = useState(false);
  const available = agents.filter(agent => agent.enabled && !agent.deletedAt);
  const options = [
    ...(!available.some(agent => agent.id === agentId)
      ? [
          {
            value: agentId,
            label:
              agents.find(agent => agent.id === agentId)?.name || i18nService.t('agentUnavailable'),
            disabled: true,
          },
        ]
      : []),
    ...available.map(agent => ({ value: agent.id, label: agent.name })),
  ];
  return (
    <ThemedSelect
      id="conversation-agent-selector"
      ariaLabel={i18nService.t('agentSelectConversation')}
      value={agentId}
      disabled={disabled || pending}
      title={onChange ? i18nService.t('agentSwitchNewConversation') : undefined}
      options={options}
      menuMinWidth={180}
      highlightSelected
      leadingIcon={<UserCircleIcon className="h-4 w-4 shrink-0 text-secondary" />}
      className="!rounded-full !border-border !bg-surface !px-2.5 !py-1.5 !text-xs !font-normal !shadow-sm hover:!border-primary/50"
      onChange={id => {
        void (async () => {
          if (id === agentId || pending) return;
          setPending(true);
          try {
            if (onChange) await onChange(id);
            else dispatch(setCurrentAgentId(id));
          } catch {
            window.dispatchEvent(
              new CustomEvent('app:showToast', { detail: i18nService.t('agentSwitchSaveFailed') }),
            );
          } finally {
            setPending(false);
          }
        })();
      }}
    />
  );
}
