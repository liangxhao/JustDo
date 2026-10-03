import { matchesShortcut, type ShortcutInput } from '../app/shortcuts';
import {
  type BrowserRecordingDraft,
  parseRecordingContext,
  RECORDING_LIMITS,
  serializeRecording,
} from './browserRecording';

export const BrowserIpc = {
  GetStatus: 'browser:getStatus',
  CanSetMode: 'browser:canSetMode',
  SetMode: 'browser:setMode',
  OpenRemoteDebugging: 'browser:openRemoteDebugging',
  TestConnection: 'browser:testConnection',
  OpenExtensionManagement: 'browser:openExtensionManagement',
  RevealExtension: 'browser:revealExtension',
  CopyExtensionPairing: 'browser:copyExtensionPairing',
  TestExtensionConnection: 'browser:testExtensionConnection',
  CreateLocalHtmlPreview: 'browser:createLocalHtmlPreview',
  LoadPdf: 'browser:loadPdf',
  CancelPdf: 'browser:cancelPdf',
  PanelOpenTab: 'browser:panelOpenTab',
  PanelPdfDetected: 'browser:panelPdfDetected',
  PanelHttpAuthRequest: 'browser:panelHttpAuthRequest',
  PanelHttpAuthResponse: 'browser:panelHttpAuthResponse',
  PanelHttpAuthDismissed: 'browser:panelHttpAuthDismissed',
  PanelSetShortcuts: 'browser:panelSetShortcuts',
  PanelShortcutAction: 'browser:panelShortcutAction',
  ListImportSources: 'browser:listImportSources',
  ImportData: 'browser:importData',
  ListHistory: 'browser:listHistory',
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
> & { profile?: BrowserAgentProfile };

export type BrowserAgentInteractionState = BrowserAgentTabReference & {
  busy: boolean;
  operationId?: string;
};

export type BrowserAgentInteractionReady = BrowserAgentTabReference & {
  operationId: string;
};

export type BrowserAgentSessionEvent = {
  sessionId: string;
  url?: string;
  targetId?: string;
  label?: string;
  profile?: BrowserAgentProfile;
};

export type BrowserPanelShortcutAction = 'terminal' | 'browser' | 'side-chat' | 'files';

export type BrowserPanelShortcutSettings = Record<BrowserPanelShortcutAction, string>;

export const DEFAULT_BROWSER_PANEL_SHORTCUTS: BrowserPanelShortcutSettings = {
  terminal: 'Ctrl+`',
  browser: 'Ctrl+T',
  'side-chat': 'Ctrl+Alt+S',
  files: 'Ctrl+P',
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
    typeof record.files !== 'string'
  )
    return null;
  return {
    terminal: record.terminal.slice(0, 80),
    browser: record.browser.slice(0, 80),
    'side-chat': record['side-chat'].slice(0, 80),
    files: record.files.slice(0, 80),
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
export const BROWSER_ANNOTATION_CONTEXT_MAX_LENGTH = 8_000;

export type BrowserPanelOpenTabEvent = {
  url: string;
  openerGuestId?: number;
  errorCode?: 'post-navigation-blocked';
};

export type BrowserPanelPdfDetectedEvent = {
  url: string;
  guestId: number;
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

export type BrowserPdfLoadRequest = {
  requestId: string;
  url: string;
  profile: BrowserAgentProfile;
};

export type BrowserPdfLoadResult =
  | { success: true; data: Uint8Array }
  | {
      success: false;
      errorCode: 'invalid_request' | 'not_pdf' | 'too_large' | 'load_failed';
    };

export const normalizeBrowserPanelOpenTabEvent = (
  value: unknown,
): BrowserPanelOpenTabEvent | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.url !== 'string') return null;
  return {
    url: record.url,
    ...(typeof record.openerGuestId === 'number' && Number.isInteger(record.openerGuestId)
      ? { openerGuestId: record.openerGuestId }
      : {}),
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
  value === BrowserMode.User || value === BrowserMode.Extension || value === BrowserMode.Embedded
    ? value
    : BrowserMode.Isolated;

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

export type BrowserPanelRect = { x: number; y: number; width: number; height: number };

export type BrowserInspectedElement = {
  tag: string;
  id: string;
  classes: string[];
  role: string;
  name: string;
  rect: BrowserPanelRect;
  focusable: boolean;
  cssPath: string;
  computedStyle?: BrowserInspectedElementStyle;
};

export type BrowserInspectedElementStyle = {
  color: string;
  backgroundColor: string;
  opacity: string;
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  display: string;
  position: string;
  zIndex: string;
  borderRadius: string;
};

export type BrowserAnnotationPoint = { x: number; y: number };
export type BrowserAnnotationStroke = { points: BrowserAnnotationPoint[] };
export type BrowserAnnotationRegion = BrowserPanelRect & {
  elements?: BrowserInspectedElement[];
};

export type BrowserAnnotationElementSummary = {
  tag: string;
  id: string;
  classes: string[];
  role: string;
  name: string;
  cssPath: string;
  rect: BrowserPanelRect;
};

export type BrowserAnnotationDisplay = {
  id: string;
  title: string;
  displayUrl: string;
  markedRegionCount: number;
  comment?: string;
  element?: BrowserAnnotationElementSummary;
};

export type BrowserAnnotationDraft = {
  id: string;
  modelContext: string;
  title: string;
  displayUrl: string;
  markedRegionCount: number;
  inspectedElement: boolean;
  comment?: string;
  display?: BrowserAnnotationDisplay;
  dataUrl: string;
  fileName: string;
  addedAt: number;
};

const EXTERNAL_BROWSER_CONTEXT_START = 'EXTERNAL_UNTRUSTED_CONTENT';
const EXTERNAL_BROWSER_CONTEXT_END = 'END_EXTERNAL_UNTRUSTED_CONTENT';
const EXTERNAL_BROWSER_CONTEXT_SOURCE = 'Source: Browser';
const EXTERNAL_BROWSER_CONTEXT_ID_PATTERN = '[a-f0-9]{16}';
const BROWSER_CONTEXT_LENGTH_PREFIX = 'content-length:';
const BROWSER_DISPLAY_LENGTH_PREFIX = 'display-metadata-length:';

export type ParsedBrowserAnnotationPrompt = {
  recording?: BrowserRecordingDraft;
  userText: string;
  annotations: BrowserAnnotationDisplay[];
  modelContext: string;
};

const boundedDisplayString = (value: unknown, maxLength: number): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength) : '';

const parseDisplayRect = (value: unknown): BrowserPanelRect | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const values = [record.x, record.y, record.width, record.height];
  if (!values.every(item => typeof item === 'number' && Number.isFinite(item))) return null;
  return {
    x: Math.max(-100_000, Math.min(100_000, record.x as number)),
    y: Math.max(-100_000, Math.min(100_000, record.y as number)),
    width: Math.max(0, Math.min(100_000, record.width as number)),
    height: Math.max(0, Math.min(100_000, record.height as number)),
  };
};

const parseDisplayAnnotations = (value: string): BrowserAnnotationDisplay[] => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 4).flatMap(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const record = item as Record<string, unknown>;
      const elementRecord =
        record.element && typeof record.element === 'object' && !Array.isArray(record.element)
          ? (record.element as Record<string, unknown>)
          : null;
      const rect = elementRecord ? parseDisplayRect(elementRecord.rect) : null;
      const element =
        elementRecord && rect
          ? {
              tag: boundedDisplayString(elementRecord.tag, 40).toLowerCase(),
              id: boundedDisplayString(elementRecord.id, 80),
              classes: Array.isArray(elementRecord.classes)
                ? elementRecord.classes
                    .slice(0, 3)
                    .map(item => boundedDisplayString(item, 60))
                    .filter(Boolean)
                : [],
              role: boundedDisplayString(elementRecord.role, 40),
              name: boundedDisplayString(elementRecord.name, 160),
              cssPath: boundedDisplayString(elementRecord.cssPath, 400),
              rect,
            }
          : undefined;
      return [
        {
          id: boundedDisplayString(record.id, 80),
          title: boundedDisplayString(record.title, 120),
          displayUrl: boundedDisplayString(record.displayUrl, 300),
          markedRegionCount:
            typeof record.markedRegionCount === 'number' &&
            Number.isFinite(record.markedRegionCount)
              ? Math.max(0, Math.min(8, Math.floor(record.markedRegionCount)))
              : 0,
          ...(boundedDisplayString(record.comment, 2_000)
            ? { comment: boundedDisplayString(record.comment, 2_000) }
            : {}),
          ...(element?.tag ? { element } : {}),
        },
      ];
    });
  } catch {
    return [];
  }
};

export function serializeBrowserAnnotationContext(
  annotations: readonly BrowserAnnotationDraft[],
): string {
  const displayMetadata = JSON.stringify(
    annotations.map(annotation => ({
      id: annotation.display?.id ?? annotation.id,
      title: annotation.display?.title ?? annotation.title,
      displayUrl: annotation.display?.displayUrl ?? annotation.displayUrl,
      markedRegionCount: annotation.display?.markedRegionCount ?? annotation.markedRegionCount,
      ...(annotation.display?.comment || annotation.comment
        ? { comment: annotation.display?.comment ?? annotation.comment }
        : {}),
      ...(annotation.display?.element ? { element: annotation.display.element } : {}),
    })),
  );
  return `${BROWSER_DISPLAY_LENGTH_PREFIX}${displayMetadata.length}\n${displayMetadata}\n${annotations
    .map(annotation => annotation.modelContext)
    .join('\n\n')}`;
}

export function composeBrowserGatewayPrompt(
  userText: string,
  annotations: readonly BrowserAnnotationDraft[],
  recording?: BrowserRecordingDraft,
): string {
  if (!annotations.length && !recording) return userText;
  let context = serializeBrowserAnnotationContext(annotations);
  if (context.length > BROWSER_ANNOTATION_CONTEXT_MAX_LENGTH) {
    throw new RangeError('Browser annotation context exceeds the supported length.');
  }
  if (recording) {
    const serialized = serializeRecording(recording);
    context = `recording-data-length:${serialized.length}\n${serialized}\n${context}`;
  }
  const boundaryId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return `<<<${EXTERNAL_BROWSER_CONTEXT_START} id="${boundaryId}">>>\n${EXTERNAL_BROWSER_CONTEXT_SOURCE}\n---\n${BROWSER_CONTEXT_LENGTH_PREFIX}${context.length}\n${context}\n<<<${EXTERNAL_BROWSER_CONTEXT_END} id="${boundaryId}">>>\n\n${userText}`;
}

function parseLengthDelimitedBrowserContext(params: {
  value: string;
  contentStart: number;
  endBoundary: (contextEnd: number) => number | null;
}): ParsedBrowserAnnotationPrompt | null {
  const { value, contentStart, endBoundary } = params;
  if (value.startsWith(BROWSER_CONTEXT_LENGTH_PREFIX, contentStart)) {
    const headerEnd = value.indexOf('\n', contentStart);
    if (headerEnd < 0) return null;
    const lengthText = value.slice(contentStart + BROWSER_CONTEXT_LENGTH_PREFIX.length, headerEnd);
    if (!/^\d+$/.test(lengthText)) return null;
    const contextLength = Number(lengthText);
    if (!Number.isSafeInteger(contextLength)) return null;
    const end = headerEnd + 1 + contextLength;
    const userTextStart = endBoundary(end);
    if (userTextStart === null) return null;
    // Gateway/history normalization trims trailing whitespace for submissions
    // without user text. The exact length and matching boundary above still
    // validate the envelope; EOF after that boundary is a valid empty prompt.
    if (userTextStart !== value.length && value.slice(userTextStart, userTextStart + 2) !== '\n\n')
      return null;
    let context = value.slice(headerEnd + 1, end);
    let recording: BrowserRecordingDraft | undefined;
    if (context.startsWith('recording-data-length:')) {
      const lineEnd = context.indexOf('\n');
      const length = Number(context.slice('recording-data-length:'.length, lineEnd));
      if (
        lineEnd < 0 ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > RECORDING_LIMITS.textLength
      )
        return null;
      recording =
        parseRecordingContext(context.slice(lineEnd + 1, lineEnd + 1 + length)) ?? undefined;
      if (!recording || context[lineEnd + 1 + length] !== '\n') return null;
      context = context.slice(lineEnd + 2 + length);
    }
    let annotations: BrowserAnnotationDisplay[] = [];
    let modelContext = context;
    if (context.startsWith(BROWSER_DISPLAY_LENGTH_PREFIX)) {
      const metadataHeaderEnd = context.indexOf('\n');
      const metadataLengthText = context.slice(
        BROWSER_DISPLAY_LENGTH_PREFIX.length,
        metadataHeaderEnd,
      );
      if (metadataHeaderEnd >= 0 && /^\d+$/.test(metadataLengthText)) {
        const metadataLength = Number(metadataLengthText);
        const metadataStart = metadataHeaderEnd + 1;
        if (
          Number.isSafeInteger(metadataLength) &&
          metadataLength >= 0 &&
          metadataLength <= 16_000 &&
          context.length >= metadataStart + metadataLength
        ) {
          annotations = parseDisplayAnnotations(
            context.slice(metadataStart, metadataStart + metadataLength),
          );
          modelContext = context.slice(metadataStart + metadataLength).replace(/^\n/u, '');
        }
      }
    }
    return {
      userText: value.slice(userTextStart + 2),
      annotations,
      modelContext,
      ...(recording ? { recording } : {}),
    };
  }

  return null;
}

export function parseBrowserAnnotationPrompt(value: string): ParsedBrowserAnnotationPrompt | null {
  const externalStart = new RegExp(
    `^<<<${EXTERNAL_BROWSER_CONTEXT_START} id="(${EXTERNAL_BROWSER_CONTEXT_ID_PATTERN})">>>\\n${EXTERNAL_BROWSER_CONTEXT_SOURCE}\\n---\\n`,
  ).exec(value);
  if (externalStart?.[1]) {
    const boundaryId = externalStart[1];
    const parsed = parseLengthDelimitedBrowserContext({
      value,
      contentStart: externalStart[0].length,
      endBoundary: contextEnd => {
        const boundary = `\n<<<${EXTERNAL_BROWSER_CONTEXT_END} id="${boundaryId}">>>`;
        return value.slice(contextEnd, contextEnd + boundary.length) === boundary
          ? contextEnd + boundary.length
          : null;
      },
    });
    if (parsed) return parsed;
    // Persisted recording-only envelopes can have stale lengths after Gateway
    // text sanitization. Recover only the exact compact-JSON grammar, never by
    // searching page text for a closing marker. Annotation contexts remain
    // strictly length-delimited because they can contain arbitrary newlines.
    const tail = value.slice(externalStart[0].length);
    const recovered =
      /^content-length:(\d+)\nrecording-data-length:(\d+)\n([^\n]+)\ndisplay-metadata-length:2\n\[\]\n\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="([a-f0-9]{16})">>>(?:\n\n([\s\S]*))?$/.exec(
        tail,
      );
    if (!recovered || recovered[4] !== boundaryId) return null;
    const declaredContext = Number(recovered[1]);
    const declaredRecording = Number(recovered[2]);
    const json = recovered[3];
    const actualContext =
      `recording-data-length:${recovered[2]}\n${json}\ndisplay-metadata-length:2\n[]\n`.length;
    if (
      !Number.isSafeInteger(declaredContext) ||
      !Number.isSafeInteger(declaredRecording) ||
      declaredRecording > RECORDING_LIMITS.textLength ||
      declaredRecording <= json.length ||
      declaredContext - actualContext !== declaredRecording - json.length
    )
      return null;
    const recording = parseRecordingContext(json);
    return recording
      ? { userText: recovered[5] ?? '', annotations: [], modelContext: '', recording }
      : null;
  }
  return null;
}

export function extractBrowserAnnotationUserText(value: string): string | null {
  return parseBrowserAnnotationPrompt(value)?.userText ?? null;
}

export const isBrowserProfileRunning = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  return (value as { running?: unknown }).running === true;
};

export const parseDevToolsActivePort = (content: string): number | null => {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const port = Number(firstLine);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
};
