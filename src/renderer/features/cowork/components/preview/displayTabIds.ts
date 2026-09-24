export const BROWSER_DISPLAY_TAB_PREFIX = 'browser:';

export const FILE_DISPLAY_TAB_PREFIX = 'file:';

export const TERMINAL_DISPLAY_TAB_PREFIX = 'terminal:';

export const PLAN_DISPLAY_TAB_ID = 'plan';

export const SUBAGENT_DISPLAY_TAB_ID = 'subagent';

export const COLLABORATION_DISPLAY_TAB_ID = 'collaboration';

export const MAX_BROWSER_TABS = 8;

export const MAX_TERMINAL_TABS = 16;

export const browserDisplayTabId = (targetId: string): string =>
  `${BROWSER_DISPLAY_TAB_PREFIX}${targetId}`;

export const fileDisplayTabId = (filePath: string): string =>
  `${FILE_DISPLAY_TAB_PREFIX}${filePath.replace(/\\/g, '/')}`;
