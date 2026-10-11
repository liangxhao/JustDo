import { ShareIcon } from '@heroicons/react/24/outline';
import { OpenClawExtensionId } from '@shared/plugins/nativeIds';

import { i18nService } from '@/services/i18n';

import { AGENT_TEAM_MODE, type AgentTeamMode } from './agentTeamSubmission';
import ComposerFeatureMenu from './ComposerFeatureMenu';
import type { ComposerFeatureRegistration } from './composerFeatures';

export default function AgentTeamSelector({
  value,
  onChange,
  disabled,
}: {
  value?: AgentTeamMode;
  onChange: (value: AgentTeamMode) => void;
  disabled: boolean;
}) {
  const t = i18nService.t.bind(i18nService);
  return (
    <ComposerFeatureMenu
      label={t('composerFeatures')}
      backLabel={t('teamFeatureBack')}
      disabled={disabled}
      items={[buildAgentTeamFeature(value, onChange)]}
    />
  );
}

export function buildAgentTeamFeature(
  value: AgentTeamMode | undefined,
  onChange: (value: AgentTeamMode) => void,
): ComposerFeatureRegistration {
  const t = i18nService.t.bind(i18nService);
  return {
    id: OpenClawExtensionId.AGENT_TEAM,
    extensionId: OpenClawExtensionId.AGENT_TEAM,
    label: t('teamTitle'),
    icon: <ShareIcon />,
    selected: !!value,
    onSelect: () => {},
    children: [AGENT_TEAM_MODE.GROUP, AGENT_TEAM_MODE.TASK].map(option => ({
      id: option,
      label: t(option === AGENT_TEAM_MODE.GROUP ? 'teamGroup' : 'teamTask'),
      icon: <ShareIcon />,
      role: 'menuitemradio',
      selected: value === option,
      onSelect: () => onChange(option),
    })),
  };
}
