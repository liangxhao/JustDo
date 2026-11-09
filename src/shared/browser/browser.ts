import { matchesShortcut, type ShortcutInput } from '../app/shortcuts';

export const BrowserIpc = {
  GetStatus: 'browser:getStatus',
  CanSetMode: 'browser:canSetMode',
  SetMode: 'browser:setMode',
  TestConnection: 'browser:testConnection',
  CreateLocalHtmlPreview: 'browser:createLocalHtmlPreview',
  PanelOpenTab: 'browser:panelOpenTab',
  PanelPdfDetected: 'browser:panelPdfDetected',
  PanelFaviconUpdated: 'browser:panelFaviconUpdated',
  PanelHttpAuthRequest: 'browser:panelHttpAuthRequest',
  PanelHttpAuthResponse: 'browser:panelHttpAuthResponse',
  PanelHttpAuthDismissed: 'browser:panelHttpAuthDismissed',
  PanelSetShortcuts: 'browser:panelSetShortcuts',
  PanelShortcutAction: 'browser:panelShortcutAction',
  ListImportSources: 'browser:listImportSources',
  ImportData: 'browser:importData',
  ListHistory: 'browser:listHistory',
  LoadHistoryFavicon: 'browser:loadHistoryFavicon',
  DeleteHistory: 'browser:deleteHistory',
  ClearHistory: 'browser:clearHistory',
  ListDownloads: 'browser:listDownloads',
  DeleteDownloads: 'browser:deleteDownloads',
  ClearDownloads: 'browser:clearDownloads',
  OpenDownload: 'browser:openDownload',
  RevealDownload: 'browser:revealDownload',
  GetClearDataSummary: 'browser:getClearDataSummary',
  ClearBrowsingData: 'browser:clearBrowsingData',
  AgentRegisterTab: 'browser:agentRegisterTab',
  AgentUnregisterTab: 'browser:agentUnregisterTab',
  AgentSetActiveTab: 'browser:agentSetActiveTab',
  AgentEnsureTab: 'browser:agentEnsureTab',
  AgentFocusTab: 'browser:agentFocusTab',
  AgentCloseTab: 'browser:agentCloseTab',
  AgentInteractionState: 'browser:agentInteractionState',
  AgentInteractionReady: 'browser:agentInteractionReady',
  UserInteractionState: 'browser:userInteractionState',
} as const;

export type BrowserAgentProfile = string;

export const BROWSER_AGENT_PANEL_TARGET_ID = '__browser-agent-panel__';
export const BROWSER_AGENT_INTERACTION_ACK_TIMEOUT_MS = 5_000;

const BROWSER_AGENT_PROFILE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;

export const isBrowserAgentProfile = (value: unknown): value is BrowserAgentProfile =>
  typeof value === 'string' && BROWSER_AGENT_PROFILE_PATTERN.test(value);

export type BrowserAgentTabRegistration = {
  sessionId: string;
  targetId: string;
  webContentsId: number;
  profile: BrowserAgentProfile;
};

export type BrowserAgentTabReference = Pick<
  BrowserAgentTabRegistration,
  'sessionId' | 'targetId'
> & { profile?: BrowserAgentProfile; ownerSessionId?: string };

export type BrowserAgentInteractionState = BrowserAgentTabReference & {
  busy: boolean;
  operationId?: string;
};

export type BrowserAgentInteractionReady = BrowserAgentTabReference & {
  operationId: string;
};

export type BrowserAgentSessionEvent = {
  sessionId: string;
  ownerSessionId?: string;
  url?: string;
  targetId?: string;
  label?: string;
  profile?: BrowserAgentProfile;
};

export type BrowserPanelShortcutAction = 'terminal' | 'browser' | 'side-chat' | 'files' | 'review';

export type BrowserPanelShortcutSettings = Record<BrowserPanelShortcutAction, string>;

export const DEFAULT_BROWSER_PANEL_SHORTCUTS: BrowserPanelShortcutSettings = {
  terminal: 'Ctrl+`',
  browser: 'Ctrl+Shift+B',
  'side-chat': 'Ctrl+Alt+S',
  files: 'Ctrl+P',
  review: 'Ctrl+Shift+G',
};

export const normalizeBrowserPanelShortcutSettings = (
  value: unknown,
): BrowserPanelShortcutSettings | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.terminal !== 'string' ||
    typeof record.browser !== 'string' ||
    typeof record['side-chat'] !== 'string' ||
    typeof record.files !== 'string' ||
    typeof record.review !== 'string'
  )
    return null;
  return {
    terminal: record.terminal.slice(0, 80),
    browser: record.browser.slice(0, 80),
    'side-chat': record['side-chat'].slice(0, 80),
    files: record.files.slice(0, 80),
    review: record.review.slice(0, 80),
  };
};

export const resolveBrowserPanelShortcutAction = (
  input: ShortcutInput,
  shortcuts: BrowserPanelShortcutSettings,
): BrowserPanelShortcutAction | null => {
  if (matchesShortcut(input, shortcuts.terminal)) return 'terminal';
  if (matchesShortcut(input, shortcuts.browser)) return 'browser';
  if (matchesShortcut(input, shortcuts['side-chat'])) return 'side-chat';
  if (matchesShortcut(input, shortcuts.files)) return 'files';
  if (matchesShortcut(input, shortcuts.review)) return 'review';
  return null;
};

export type BrowserLocalHtmlPreviewResult =
  | {
      success: true;
      url: string;
      filePath: string;
      rootPath: string;
      previewRootUrl: string;
    }
  | {
      success: false;
      errorCode: 'invalid_request' | 'not_found' | 'invalid_type' | 'invalid_source' | 'failed';
    };

export const BROWSER_GUEST_COMMAND_CHANNEL = 'justdo-browser-command';
export const BROWSER_GUEST_ZOOM_CHANNEL = 'justdo-browser-zoom';
export const BROWSER_GUEST_CREDENTIALS_GET_CHANNEL = 'justdo-browser-credentials:get';
export const BROWSER_GUEST_CREDENTIALS_OFFER_CHANNEL = 'justdo-browser-credentials:offer';
export const BROWSER_GUEST_CREDENTIALS_FILL_CHANNEL = 'justdo-browser-credentials:fill';
export const BROWSER_PANEL_PARTITION = 'persist:justdo-browser';
export const BROWSER_IMPORTED_PROFILE_PARTITION = 'persist:justdo-browser-imported';
export const BROWSER_NAMED_PROFILE_PARTITION_PREFIX = 'persist:justdo-browser-profile-';
export const browserPartitionForProfile = (profile: BrowserAgentProfile): string =>
  profile === 'embedded'
    ? BROWSER_PANEL_PARTITION
    : profile === 'imported'
      ? BROWSER_IMPORTED_PROFILE_PARTITION
      : `${BROWSER_NAMED_PROFILE_PARTITION_PREFIX}${profile}`;
export const browserProfileFromPartition = (partition: string): BrowserAgentProfile | null => {
  if (partition === BROWSER_PANEL_PARTITION) return 'embedded';
  if (partition === BROWSER_IMPORTED_PROFILE_PARTITION) return 'imported';
  if (!partition.startsWith(BROWSER_NAMED_PROFILE_PARTITION_PREFIX)) return null;
  const profile = partition.slice(BROWSER_NAMED_PROFILE_PARTITION_PREFIX.length);
  return isBrowserAgentProfile(profile) ? profile : null;
};

export const BrowserTabPresentation = {
  Foreground: 'foreground',
  Background: 'background',
} as const;
export type BrowserTabPresentation =
  (typeof BrowserTabPresentation)[keyof typeof BrowserTabPresentation];

export type BrowserPanelOpenTabEvent = {
  url: string;
  openerGuestId?: number;
  /** A trusted Main presentation hint; it does not grant page or tool ownership. */
  presentation?: BrowserTabPresentation;
  errorCode?: 'post-navigation-blocked';
};

export type BrowserPanelPdfDetectedEvent = {
  url: string;
  guestId: number;
};

export const BROWSER_FAVICON_MAX_DATA_URL_LENGTH = 512 * 1024;

export const isBrowserFaviconDataUrl = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= BROWSER_FAVICON_MAX_DATA_URL_LENGTH &&
  /^data:image\/(?:png|jpeg|gif|webp|avif|bmp|svg\+xml|x-icon|vnd\.microsoft\.icon)[;,]/iu.test(
    value,
  );

export type BrowserPanelFaviconUpdatedEvent = {
  url: string;
  guestId: number;
  faviconUrl?: string;
};

export const normalizeBrowserPanelFaviconUpdatedEvent = (
  value: unknown,
): BrowserPanelFaviconUpdatedEvent | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.url !== 'string' ||
    (!/^https?:\/\//iu.test(record.url) && record.url !== 'about:blank') ||
    !Number.isInteger(record.guestId) ||
    (record.guestId as number) <= 0 ||
    (record.faviconUrl !== undefined && !isBrowserFaviconDataUrl(record.faviconUrl))
  ) {
    return null;
  }
  return {
    url: record.url,
    guestId: record.guestId as number,
    faviconUrl: record.faviconUrl as string | undefined,
  };
};

export type BrowserPanelHttpAuthRequest = {
  id: string;
  guestId: number;
  host: string;
  port: number;
  realm: string;
  scheme: string;
};

export type BrowserPanelHttpAuthResponse = {
  id: string;
  guestId: number;
  username?: string;
  password?: string;
};

export type BrowserPanelHttpAuthDismissed = Pick<BrowserPanelHttpAuthRequest, 'id' | 'guestId'>;

export const normalizeBrowserPanelHttpAuthRequest = (
  value: unknown,
): BrowserPanelHttpAuthRequest | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    !record.id ||
    typeof record.guestId !== 'number' ||
    !Number.isInteger(record.guestId) ||
    typeof record.host !== 'string' ||
    !record.host ||
    typeof record.port !== 'number' ||
    !Number.isInteger(record.port) ||
    typeof record.realm !== 'string' ||
    typeof record.scheme !== 'string'
  ) {
    return null;
  }
  return {
    id: record.id.slice(0, 128),
    guestId: record.guestId,
    host: record.host.slice(0, 512),
    port: record.port,
    realm: record.realm.slice(0, 1_024),
    scheme: record.scheme.slice(0, 64),
  };
};

export const normalizeBrowserPanelHttpAuthResponse = (
  value: unknown,
): BrowserPanelHttpAuthResponse | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    !record.id ||
    record.id.length > 128 ||
    typeof record.guestId !== 'number' ||
    !Number.isInteger(record.guestId)
  ) {
    return null;
  }
  const hasCredentials = typeof record.username === 'string' && typeof record.password === 'string';
  if (
    hasCredentials &&
    ((record.username as string).length > 4_096 || (record.password as string).length > 4_096)
  )
    return null;
  return {
    id: record.id,
    guestId: record.guestId,
    ...(hasCredentials
      ? {
          username: record.username as string,
          password: record.password as string,
        }
      : {}),
  };
};

export const normalizeBrowserPanelPdfDetectedEvent = (
  value: unknown,
): BrowserPanelPdfDetectedEvent | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.url !== 'string' ||
    !/^https?:\/\//iu.test(record.url) ||
    !Number.isInteger(record.guestId)
  ) {
    return null;
  }
  return { url: record.url, guestId: record.guestId as number };
};

export const normalizeBrowserPanelOpenTabEvent = (
  value: unknown,
): BrowserPanelOpenTabEvent | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.url !== 'string') return null;
  const presentation = record.presentation;
  if (
    presentation !== undefined &&
    presentation !== BrowserTabPresentation.Foreground &&
    presentation !== BrowserTabPresentation.Background
  ) return null;
  if (
    record.openerGuestId !== undefined &&
    (!Number.isInteger(record.openerGuestId) || (record.openerGuestId as number) <= 0)
  ) return null;
  return {
    url: record.url,
    ...(typeof record.openerGuestId === 'number' && Number.isInteger(record.openerGuestId)
      ? { openerGuestId: record.openerGuestId }
      : {}),
    ...(presentation !== undefined ? { presentation: presentation as BrowserTabPresentation } : {}),
    ...(record.errorCode === 'post-navigation-blocked'
      ? { errorCode: 'post-navigation-blocked' as const }
      : {}),
  };
};

export const BrowserGuestCommands = [
  'focus-address',
  'new-tab',
  'reopen-tab',
  'close-tab',
  'reload',
  'back',
  'forward',
  'next-tab',
  'previous-tab',
] as const;

export type BrowserGuestCommand = (typeof BrowserGuestCommands)[number];

export const isBrowserGuestCommand = (value: unknown): value is BrowserGuestCommand =>
  typeof value === 'string' && BrowserGuestCommands.some(command => command === value);

export type BrowserGuestZoomDirection = -1 | 1;

export const isBrowserGuestZoomDirection = (value: unknown): value is BrowserGuestZoomDirection =>
  value === -1 || value === 1;

export const resolveBrowserGuestWheelZoomDirection = (input: {
  ctrlKey: boolean;
  metaKey: boolean;
  deltaY: number;
}): BrowserGuestZoomDirection | null => {
  if ((!input.ctrlKey && !input.metaKey) || input.deltaY === 0) return null;
  return input.deltaY < 0 ? 1 : -1;
};

export const stepBrowserZoomFactor = (
  current: number,
  direction: BrowserGuestZoomDirection,
): number => {
  const safeCurrent = Number.isFinite(current) ? current : 1;
  return Math.min(2, Math.max(0.5, Math.round((safeCurrent + direction * 0.1) * 10) / 10));
};

type BrowserShortcutInput = {
  type: string;
  key: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
};

export const resolveBrowserGuestShortcut = (
  input: BrowserShortcutInput,
): BrowserGuestCommand | null => {
  if (input.type !== 'keyDown') return null;
  const key = input.key.toLowerCase();
  const primary = input.control || input.meta;
  if (primary && !input.alt) {
    if (key === 'l') return 'focus-address';
    if (key === 't' && input.shift) return 'reopen-tab';
    if (key === 'w') return 'close-tab';
    if (key === 'r') return 'reload';
    if (key === 'tab') return input.shift ? 'previous-tab' : 'next-tab';
  }
  if (!primary && input.alt && !input.shift) {
    if (key === 'arrowleft') return 'back';
    if (key === 'arrowright') return 'forward';
  }
  if (!primary && !input.alt && !input.shift && key === 'f5') return 'reload';
  return null;
};

export const BrowserMode = {
  Isolated: 'isolated',
  User: 'user',
  Extension: 'extension',
  Embedded: 'embedded',
} as const;

export type BrowserMode = (typeof BrowserMode)[keyof typeof BrowserMode];

export const normalizeBrowserMode = (value: unknown): BrowserMode =>
  value === BrowserMode.Isolated || value === BrowserMode.User || value === BrowserMode.Extension
    ? value
    : BrowserMode.Embedded;

export const BrowserSearchEngine = {
  Baidu: 'baidu',
  Google: 'google',
} as const;

export type BrowserSearchEngine = (typeof BrowserSearchEngine)[keyof typeof BrowserSearchEngine];

export const normalizeBrowserSearchEngine = (value: unknown): BrowserSearchEngine =>
  value === BrowserSearchEngine.Google ? BrowserSearchEngine.Google : BrowserSearchEngine.Baidu;

export type BrowserDownloadSettings = {
  directory: string;
  askWhereToSave: boolean;
};

export const normalizeBrowserDownloadSettings = (value: {
  directory?: unknown;
  askWhereToSave?: unknown;
}): BrowserDownloadSettings => ({
  directory: typeof value.directory === 'string' ? value.directory.trim().slice(0, 4_096) : '',
  // Preserve the app's existing behavior for users who do not have this setting yet.
  askWhereToSave: typeof value.askWhereToSave === 'boolean' ? value.askWhereToSave : true,
});

const buildBrowserSearchUrl = (query: string, searchEngine: BrowserSearchEngine): string => {
  const url = new URL(
    searchEngine === BrowserSearchEngine.Google
      ? 'https://www.google.com/search'
      : 'https://www.baidu.com/s',
  );
  url.searchParams.set(searchEngine === BrowserSearchEngine.Google ? 'q' : 'wd', query);
  return url.toString();
};

/** Resolves omnibox input to a safe web URL, falling back to the selected search engine. */
export const resolveBrowserAddressInput = (
  raw: string,
  searchEngine: BrowserSearchEngine,
): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed === 'about:blank') return trimmed;
  // URL parsing expands bare numbers to IPv4 addresses; omnibox numbers are search terms.
  if (/^\d+$/u.test(trimmed)) return buildBrowserSearchUrl(trimmed, searchEngine);

  const explicitWebScheme = /^https?:\/\//i.test(trimmed);
  const hasAnyScheme = /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(trimmed);
  if (explicitWebScheme) {
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
    } catch {
      // Invalid explicit URLs are searched as text, matching browser omnibox behavior.
    }
    return buildBrowserSearchUrl(trimmed, searchEngine);
  }

  if (!hasAnyScheme && !/\s/.test(trimmed)) {
    try {
      const parsed = new URL(`https://${trimmed}`);
      const hostname = parsed.hostname.toLowerCase();
      const likelyWebHost =
        hostname === 'localhost' ||
        hostname.includes('.') ||
        hostname.includes(':') ||
        /:\d+(?:[/?#]|$)/.test(trimmed);
      if (likelyWebHost) return parsed.toString();
    } catch {
      // Non-URL input is handled as a search query below.
    }
  }

  return buildBrowserSearchUrl(trimmed, searchEngine);
};

export type BrowserConnectionIssue =
  | 'unsupported-platform'
  | 'chrome-not-found'
  | 'remote-debugging-disabled'
  | 'port-occupied-by-other-process'
  | 'chrome-restart-required'
  | 'not-running';

export type BrowserPortOwner = {
  pid: number;
  processName: string | null;
  isChrome: boolean;
};

export type BrowserConnectionStatus = {
  supported: boolean;
  chromeFound: boolean;
  remoteDebuggingEnabled: boolean;
  activePort: number | null;
  activePortFileExists: boolean;
  activePortOwnerResolved: boolean;
  activePortOwner: BrowserPortOwner | null;
  endpointReachable: boolean;
  issue: BrowserConnectionIssue | null;
};

export type BrowserStatusResult = {
  success: boolean;
  status?: BrowserConnectionStatus;
  bundledExtensionVersion?: string | null;
  error?: string;
};

export type BrowserActionResult = {
  success: boolean;
  error?: string;
};

export type BrowserImportSource = {
  id: string;
  browser: 'chrome' | 'brave' | 'edge' | 'chromium';
  name: string;
  profileId?: string;
  hasCookies?: boolean;
};

export type BrowserImportSourcesResult = BrowserActionResult & {
  sources?: BrowserImportSource[];
};

export type BrowserImportRequest = {
  sourceId: string;
  passwords: boolean;
  cookies: boolean;
  history: boolean;
  approved: boolean;
  domains?: string[];
  destinationProfile?: BrowserAgentProfile;
};

export type BrowserImportResult = BrowserActionResult & {
  imported?: { passwords: number; cookies: number; history: number };
  skippedAppBound?: { passwords: number; cookies: number };
  failed?: { cookies: number };
  errorCode?: 'invalid-request' | 'source-unavailable' | 'chrome-running' | 'decrypt-failed';
};

export type BrowserImportedCredential = { username: string; password: string };

export type BrowserHistoryEntry = {
  url: string;
  title: string;
  lastVisitAt: number;
  visitCount: number;
  faviconUrl?: string;
};

export type BrowserHistoryListResult = BrowserActionResult & {
  entries?: BrowserHistoryEntry[];
};

export type BrowserHistoryFaviconResult =
  | { success: true; dataUrl: string }
  | { success: false; errorCode: 'invalid_request' | 'not_found' | 'load_failed' };

export type BrowserDownloadState =
  'queued' | 'progressing' | 'completed' | 'cancelled' | 'interrupted';

export type BrowserDownloadEntry = {
  id: string;
  fileName: string;
  sourceUrl: string;
  state: BrowserDownloadState;
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
  updatedAt: number;
};

export type BrowserDownloadListResult = BrowserActionResult & {
  entries?: BrowserDownloadEntry[];
};

export const BrowserClearDataRanges = ['hour', 'day', 'week', 'four-weeks', 'all'] as const;
export type BrowserClearDataRange = (typeof BrowserClearDataRanges)[number];

export type BrowserClearDataSelection = {
  history: boolean;
  cookiesAndSiteData: boolean;
  cache: boolean;
  downloads: boolean;
  autofill: boolean;
};

export type BrowserClearDataRequest = {
  range: BrowserClearDataRange;
  selection: BrowserClearDataSelection;
};

export type BrowserClearDataSummary = {
  history: number;
  latestHistoryOrigin: string;
  cookieSites: number;
  downloads: number;
  autofill: number;
};

export type BrowserClearDataSummaryResult = BrowserActionResult & {
  summary?: BrowserClearDataSummary;
};

export type BrowserClearDataResult = BrowserActionResult & {
  cleared?: BrowserClearDataSummary;
  failedCategories?: Array<keyof BrowserClearDataSelection>;
  errorCode?: 'invalid-request' | 'clear-failed';
};

export const isBrowserClearDataRange = (value: unknown): value is BrowserClearDataRange =>
  typeof value === 'string' && BrowserClearDataRanges.some(range => range === value);

export type BrowserModeUpdateResult = BrowserActionResult & {
  mode?: BrowserMode;
  errorCode?: 'invalid-mode' | 'active-session' | 'config-sync-failed';
};

export type BrowserModeSwitchAvailabilityResult = BrowserActionResult & {
  canSwitch: boolean;
  errorCode?: 'active-session';
};

export type BrowserConnectionTestResult = BrowserActionResult & {
  errorCode?:
    | 'gateway-unavailable'
    | 'permission-timeout'
    | 'extension-not-connected'
    | 'browser-not-running'
    | 'connection-failed';
};

export type BrowserPanelTab = {
  id: string;
  targetId: string;
  /** Native execution resource; the containing panel still belongs to its product page. */
  resourceSessionId?: string;
  title: string;
  customTitle?: string;
  faviconUrl?: string;
  muted?: boolean;
  url: string;
  pdfUrl?: string;
  profile?: BrowserAgentProfile;
  sourceFilePath?: string;
  sourcePreviewUrl?: string;
  sourceRootPath?: string;
  sourcePreviewRootUrl?: string;
  urlUnavailableReason?: 'navigation_blocked' | 'navigation_check_failed';
};

export type BrowserPanelTabs = {
  running: boolean;
  profile: 'openclaw' | 'user' | 'chrome' | BrowserAgentProfile;
  tabs: BrowserPanelTab[];
};

export type BrowserPanelFrame = {
  targetId: string;
  url: string;
  title: string;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  capturedAt: number;
  dataUrl: string;
};

export const isBrowserProfileRunning = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  return (value as { running?: unknown }).running === true;
};

export const parseDevToolsActivePort = (content: string): number | null => {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const port = Number(firstLine);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
};
