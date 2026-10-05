export type SettingsTab =
  | 'general'
  | 'appearance'
  | 'pet'
  | 'voice'
  | 'shortcuts'
  | 'model'
  | 'agents'
  | 'runtime'
  | 'worktrees'
  | 'security'
  | 'browser'
  | 'computer'
  | 'integrations'
  | 'im'
  | 'usage'
  | 'help';

export const SETTINGS_GROUPS = ['personal', 'intelligence', 'connections', 'application'] as const;

export interface SettingsPage {
  id: SettingsTab;
  label: string;
  description: string;
  group: (typeof SETTINGS_GROUPS)[number];
  wide: boolean;
  keywords: readonly string[];
}

export const SETTINGS_PAGES: readonly SettingsPage[] = [
  {
    id: 'general',
    label: 'general',
    description: 'settingsDescription_general',
    group: 'personal',
    wide: false,
    keywords: ['language', 'autoLaunch', 'preventSleep', 'appUpdateFrequencyTitle'],
  },
  {
    id: 'appearance',
    label: 'appearance',
    description: 'settingsDescription_appearance',
    group: 'personal',
    wide: true,
    keywords: ['appearanceMode'],
  },
  {
    id: 'pet',
    label: 'coworkPetSettingsTitle',
    description: 'settingsDescription_pet',
    group: 'personal',
    wide: false,
    keywords: [],
  },
  {
    id: 'voice',
    label: 'voiceSettings',
    description: 'settingsDescription_voice',
    group: 'personal',
    wide: false,
    keywords: [],
  },
  {
    id: 'shortcuts',
    label: 'shortcuts',
    description: 'settingsDescription_shortcuts',
    group: 'personal',
    wide: false,
    keywords: [],
  },
  {
    id: 'model',
    label: 'model',
    description: 'settingsDescription_model',
    group: 'intelligence',
    wide: true,
    keywords: ['apiKey', 'modelTypeLanguage', 'modelTypeImage', 'modelTypeVideo'],
  },
  {
    id: 'agents',
    label: 'agentManager',
    description: 'settingsDescription_agents',
    group: 'intelligence',
    wide: true,
    keywords: [],
  },
  {
    id: 'runtime',
    label: 'agentRuntimeTab',
    description: 'settingsDescription_runtime',
    group: 'intelligence',
    wide: false,
    keywords: [],
  },
  {
    id: 'worktrees',
    label: 'worktreeSettingsTitle',
    description: 'worktreeSettingsDescription',
    group: 'intelligence',
    wide: true,
    keywords: ['worktreeStorageRoot', 'worktreeAcceleration', 'worktreeShowCheckbox'],
  },
  {
    id: 'security',
    label: 'securitySettings',
    description: 'settingsDescription_security',
    group: 'intelligence',
    wide: false,
    keywords: [],
  },
  {
    id: 'browser',
    label: 'browserSettings',
    description: 'settingsDescription_browser',
    group: 'connections',
    wide: true,
    keywords: [],
  },
  {
    id: 'integrations',
    label: 'integrationsTab',
    description: 'settingsDescription_integrations',
    group: 'connections',
    wide: true,
    keywords: [],
  },
  {
    id: 'computer',
    label: 'computerControlTitle',
    description: 'settingsDescription_computer',
    group: 'connections',
    wide: false,
    keywords: ['computerControlEnable', 'computerControlModelRequirement'],
  },
  {
    id: 'im',
    label: 'imBot',
    description: 'settingsDescription_im',
    group: 'connections',
    wide: false,
    keywords: [],
  },
  {
    id: 'usage',
    label: 'usageAndStorage',
    description: 'settingsDescription_usage',
    group: 'application',
    wide: true,
    keywords: [],
  },
  {
    id: 'help',
    label: 'help',
    description: 'settingsDescription_help',
    group: 'application',
    wide: false,
    keywords: [],
  },
];

export function matchesSettingsPage(
  page: SettingsPage,
  query: string,
  translate: (key: string) => string,
): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const text = [page.label, page.description, ...page.keywords]
    .map(translate)
    .join(' ')
    .toLocaleLowerCase();
  return terms.every(term => text.includes(term));
}
