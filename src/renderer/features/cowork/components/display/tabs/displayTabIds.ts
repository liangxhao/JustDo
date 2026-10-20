export const BROWSER_DISPLAY_TAB_PREFIX = 'browser:';

export const FILE_DISPLAY_TAB_PREFIX = 'file:';

export const WORKSPACE_FILES_DISPLAY_TAB_ID = 'workspace-files';

export const SUMMARY_RESOURCE_DISPLAY_TAB_IDS = {
  outputs: 'summary-outputs',
  sources: 'summary-sources',
} as const;

export type SummaryResourceListKind = keyof typeof SUMMARY_RESOURCE_DISPLAY_TAB_IDS;

export const TERMINAL_DISPLAY_TAB_PREFIX = 'terminal:';

export const PLAN_DISPLAY_TAB_ID = 'plan';

export const SUBAGENT_DISPLAY_TAB_ID = 'subagent';
export const SUBAGENTS_DISPLAY_TAB_ID = 'subagents';

export const MAX_TERMINAL_TABS = 16;

export const browserDisplayTabId = (targetId: string): string =>
  `${BROWSER_DISPLAY_TAB_PREFIX}${targetId}`;

export const fileDisplayTabId = (filePath: string): string =>
  `${FILE_DISPLAY_TAB_PREFIX}${filePath.replace(/\\/g, '/')}`;
