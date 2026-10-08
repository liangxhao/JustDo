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

export const SETTINGS_GROUPS = [
  'personal',
  'intelligence',
  'execution',
  'connections',
  'application',
] as const;

export interface SettingsPage {
  id: SettingsTab;
  label: string;
  description: string;
  group: (typeof SETTINGS_GROUPS)[number];
  keywords: readonly string[];
}

export const SETTINGS_PAGES: readonly SettingsPage[] = [
  {
    id: 'general',
    label: 'general',
    description: 'settingsDescription_general',
    group: 'personal',
    keywords: ['language', 'autoLaunch', 'preventSleep', 'appUpdateFrequencyTitle'],
  },
  {
    id: 'appearance',
    label: 'appearance',
    description: 'settingsDescription_appearance',
    group: 'personal',
    keywords: ['appearanceMode'],
  },
  {
    id: 'shortcuts',
    label: 'shortcuts',
    description: 'settingsDescription_shortcuts',
    group: 'personal',
    keywords: [],
  },
  {
    id: 'voice',
    label: 'voiceSettings',
    description: 'settingsDescription_voice',
    group: 'personal',
    keywords: [],
  },
  {
    id: 'pet',
    label: 'coworkPetSettingsTitle',
    description: 'settingsDescription_pet',
    group: 'personal',
    keywords: [],
  },
  {
    id: 'model',
    label: 'model',
    description: 'settingsDescription_model',
    group: 'intelligence',
    keywords: ['apiKey', 'modelTypeLanguage', 'modelTypeImage', 'modelTypeVideo'],
  },
  {
    id: 'agents',
    label: 'agentManager',
    description: 'settingsDescription_agents',
    group: 'intelligence',
    keywords: [],
  },
  {
    id: 'runtime',
    label: 'agentRuntimeTab',
    description: 'settingsDescription_runtime',
    group: 'execution',
    keywords: [],
  },
  {
    id: 'security',
    label: 'settingsSecurityTitle',
    description: 'settingsDescription_security',
    group: 'execution',
    keywords: ['securitySettings'],
  },
  {
    id: 'worktrees',
    label: 'worktreeSettingsTitle',
    description: 'worktreeSettingsDescription',
    group: 'execution',
    keywords: ['worktreeStorageRoot', 'worktreeAcceleration', 'worktreeShowCheckbox'],
  },
  {
    id: 'browser',
    label: 'browserSettings',
    description: 'settingsDescription_browser',
    group: 'execution',
    keywords: [],
  },
  {
    id: 'computer',
    label: 'computerControlTitle',
    description: 'settingsDescription_computer',
    group: 'execution',
    keywords: ['computerControlEnable', 'computerControlModelRequirement'],
  },
  {
    id: 'integrations',
    label: 'integrationsTab',
    description: 'settingsDescription_integrations',
    group: 'connections',
    keywords: [],
  },
  {
    id: 'im',
    label: 'imBot',
    description: 'settingsDescription_im',
    group: 'connections',
    keywords: [],
  },
  {
    id: 'usage',
    label: 'usageAndStorage',
    description: 'settingsDescription_usage',
    group: 'application',
    keywords: [],
  },
  {
    id: 'help',
    label: 'settingsAboutHelpTitle',
    description: 'settingsDescription_help',
    group: 'application',
    keywords: ['help'],
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
