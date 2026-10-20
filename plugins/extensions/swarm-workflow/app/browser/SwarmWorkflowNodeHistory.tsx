import { history } from './workflowBrowserPorts';
import { i18nService } from './ui';

export default function SwarmWorkflowNodeHistory(props: {
  sessionKey: string;
  workingDirectory: string;
  agentId?: string;
  name: string;
  active?: boolean;
}) {
  return history({
    ...props,
    labels: {
      loading: i18nService.t('swarmWorkflowHistory_loading'),
      empty: i18nService.t('swarmWorkflowHistory_empty'),
      error: i18nService.t('swarmWorkflowHistory_error'),
      retry: i18nService.t('sessionDetailsRetry'),
    },
  });
}
