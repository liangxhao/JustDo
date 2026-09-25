import {
  ArrowLeftIcon,
  ArrowPathIcon,
  ArrowRightIcon,
  ChatBubbleOvalLeftIcon,
  ChevronDownIcon,
  EllipsisVerticalIcon,
  GlobeAltIcon,
  MagnifyingGlassIcon,
  PencilIcon,
  PlusIcon,
  RectangleGroupIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type {
  BrowserAgentInteractionState,
  BrowserAnnotationDraft,
  BrowserAnnotationPoint,
  BrowserAnnotationRegion,
  BrowserAnnotationStroke,
  BrowserGuestCommand,
  BrowserInspectedElement,
  BrowserPanelFrame,
  BrowserPanelHttpAuthRequest,
  BrowserPanelHttpAuthResponse,
  BrowserPanelTab,
} from '@shared/browser/browser';
import {
  BROWSER_AGENT_PANEL_TARGET_ID,
  BROWSER_GUEST_COMMAND_CHANNEL,
  BROWSER_GUEST_CREDENTIALS_FILL_CHANNEL,
  BROWSER_GUEST_CREDENTIALS_OFFER_CHANNEL,
  BROWSER_GUEST_ZOOM_CHANNEL,
  BrowserMode,
  browserPartitionForProfile,
  isBrowserGuestCommand,
  isBrowserGuestZoomDirection,
  normalizeBrowserSearchEngine,
  resolveBrowserAddressInput,
  resolveBrowserGuestShortcut,
  resolveBrowserPanelShortcutAction,
  stepBrowserZoomFactor,
} from '@shared/browser/browser';
import type { BrowserContinueResult } from '@shared/browser/browserIntervention';
import { RecordingStatus } from '@shared/browser/browserRecording';
import React, {
  forwardRef,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { defaultConfig } from '@/app/config';
import {
  browserAnnotationDataBytes,
  buildBrowserAnnotationDraft,
  composeAnnotatedBrowserImage,
} from '@/features/browser/browserAnnotation';
import BrowserAnnotationComposer from '@/features/browser/BrowserAnnotationComposer';
import BrowserAnnotationToolMenu, {
  type BrowserAnnotationTool,
} from '@/features/browser/BrowserAnnotationToolMenu';
import BrowserClearDataModal from '@/features/browser/BrowserClearDataModal';
import BrowserDataImportModal from '@/features/browser/BrowserDataImportModal';
import BrowserElementInspectorCard from '@/features/browser/BrowserElementInspectorCard';
import BrowserHttpAuthModal from '@/features/browser/BrowserHttpAuthModal';
import BrowserOverflowMenu, {
  type BrowserOverflowAction,
} from '@/features/browser/BrowserOverflowMenu';
import {
  getRetainedBrowserPanelTabs,
  setRetainedBrowserPanelTabs,
} from '@/features/browser/browserPanelRetention';
import { isLikelyPdfUrl } from '@/features/browser/browserPdf';
import type { BrowserPdfViewerHandle } from '@/features/browser/BrowserPdfViewer';
import BrowserTabContextMenu, {
  type BrowserTabMenuAction,
} from '@/features/browser/BrowserTabContextMenu';
import { normalizeLiveInspectedElement } from '@/features/browser/liveBrowserInspection';
import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';
import Tooltip from '@/shared/components/ui/Tooltip';

import { BrowserInterventionBar } from './BrowserInterventionBar';
import { BrowserRecordingControls } from './BrowserRecordingControls';
import { useBrowserRecording } from './useBrowserRecording';

type BrowserPanelMode = 'interact' | 'inspect' | 'pen' | 'rectangle';
type Gesture =
  | { kind: 'pen'; pointerId: number; stroke: BrowserAnnotationStroke }
  | { kind: 'rectangle'; pointerId: number; start: BrowserAnnotationPoint };
type GuestEvent = Event & {
  args?: unknown[];
  channel?: string;
  errorCode?: number;
  errorDescription?: string;
  favicons?: string[];
  isMainFrame?: boolean;
  result?: { activeMatchOrdinal?: number; matches?: number };
  title?: string;
  url?: string;
};
type GuestImage = {
  getSize: () => { width: number; height: number };
  toDataURL: () => string;
};
type LiveWebview = HTMLElement & {
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  capturePage: () => Promise<GuestImage>;
  getTitle: () => string;
  getURL: () => string;
  getWebContentsId?: () => number;
  findInPage?: (text: string, options?: { forward?: boolean; findNext?: boolean }) => number;
  stopFind?: (action: 'clearSelection' | 'keepSelection' | 'activateSelection') => void;
  print?: (
    options?: Record<string, unknown>,
    callback?: (success: boolean, failureReason?: string) => void,
  ) => void;
  getZoomFactor?: () => number;
  setZoomFactor?: (factor: number) => void;
  openDevTools?: () => void;
  goBack: () => void;
  goForward: () => void;
  loadURL: (url: string) => Promise<void>;
  reload: () => void;
  isAudioMuted?: () => boolean;
  setAudioMuted?: (muted: boolean) => void;
  send: (channel: string, ...args: unknown[]) => void;
};

const BROWSER_PANEL_MIN_WIDTH = 320;
// Zero lets the display host size the panel to half its available width.
export const BROWSER_PANEL_DEFAULT_WIDTH = 0;
const ANNOTATION_NOTICE_DURATION_MS = 3_500;
// Bump this when guest creation preferences change. Besides documenting that those
// preferences are attach-time only, the suffix makes Fast Refresh replace guests
// that were created by an older implementation instead of reusing a broken one.
const BROWSER_WEBVIEW_CAPABILITY_VERSION = 'isolated-session-v4-pdf';
const BrowserPdfViewer = lazy(() => import('@/features/browser/BrowserPdfViewer'));

const getBrowserPanelMaxWidth = (availableWidth = window.innerWidth): number =>
  Math.max(BROWSER_PANEL_MIN_WIDTH, availableWidth - 32);

type BrowserLocalHtmlSource = {
  sourceFilePath: string;
  sourcePreviewUrl: string;
  sourceRootPath: string;
  sourcePreviewRootUrl: string;
};

type BrowserOpenTabOptions = Partial<BrowserLocalHtmlSource> & {
  insertAfterTargetId?: string;
  targetId?: string;
  customTitle?: string;
  profile?: BrowserPanelTab['profile'];
};

export const createBrowserPanelTab = (
  url = 'about:blank',
  source?: BrowserOpenTabOptions,
): BrowserPanelTab => {
  const targetId = source?.targetId ?? `embedded-${crypto.randomUUID()}`;
  return {
    id: targetId,
    targetId,
    title: '',
    url,
    ...(source?.profile ? { profile: source.profile } : {}),
    ...(source?.customTitle ? { customTitle: source.customTitle } : {}),
    ...(source?.sourceFilePath
      ? {
          sourceFilePath: source.sourceFilePath,
          sourcePreviewUrl: source.sourcePreviewUrl || url,
          sourceRootPath: source.sourceRootPath,
          sourcePreviewRootUrl: source.sourcePreviewRootUrl,
        }
      : {}),
  };
};

const getLocalPreviewFilePath = (tab: BrowserPanelTab): string | null => {
  if (!tab.sourceFilePath || !tab.sourcePreviewUrl) return null;
  try {
    const current = new URL(tab.url);
    const source = new URL(tab.sourcePreviewUrl);
    if (current.origin !== source.origin) return null;
    if (current.pathname === source.pathname) return tab.sourceFilePath;
    if (!tab.sourceRootPath || !tab.sourcePreviewRootUrl) return null;
    const previewRoot = new URL(tab.sourcePreviewRootUrl);
    if (current.origin !== previewRoot.origin) return null;
    if (!current.pathname.startsWith(previewRoot.pathname)) return tab.sourceFilePath;
    if (current.pathname === previewRoot.pathname) return tab.sourceFilePath;
    const relativeSegments = current.pathname
      .slice(previewRoot.pathname.length)
      .split('/')
      .filter(Boolean)
      .map(decodeURIComponent);
    if (
      !relativeSegments.length ||
      relativeSegments.some(
        segment => segment === '.' || segment === '..' || /[\\/\0]/u.test(segment),
      )
    ) {
      return null;
    }
    const separator = tab.sourceRootPath.includes('\\') ? '\\' : '/';
    return `${tab.sourceRootPath.replace(/[\\/]+$/u, '')}${separator}${relativeSegments.join(separator)}`;
  } catch {
    return tab.url === tab.sourcePreviewUrl ? tab.sourceFilePath : null;
  }
};

const isAtSourcePreview = (tab: BrowserPanelTab): boolean => getLocalPreviewFilePath(tab) !== null;

export const getBrowserTabAddress = (tab: BrowserPanelTab | null | undefined): string => {
  if (!tab || tab.url === 'about:blank') return '';
  return getLocalPreviewFilePath(tab) ?? tab.url;
};

const normalizeUrl = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed === 'about:blank') return trimmed;
  const hasScheme = /^[a-z][a-z0-9+.-]*:(?![0-9])/i.test(trimmed);
  if (hasScheme && !/^https?:\/\//i.test(trimmed)) return null;
  try {
    const parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
};

const resolveAddressInput = (raw: string): string | null =>
  resolveBrowserAddressInput(
    raw,
    normalizeBrowserSearchEngine(configService.getConfig().browserSearchEngine),
  );

const isLocalFileAddress = (raw: string): boolean => /^file:/iu.test(raw.trim());

const normalizeFaviconUrl = (raw: string): string | null => {
  if (raw.length > 512 * 1024) return null;
  if (/^data:image\//i.test(raw)) return raw;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return null;
  }
};

export const getBrowserTabDisplayTitle = (tab: BrowserPanelTab): string => {
  if (tab.customTitle) return tab.customTitle;
  if (tab.url === 'about:blank' || tab.title === 'about:blank') {
    return i18nService.t('browserPanelNewTab');
  }
  return tab.title || tab.url || i18nService.t('browserPanelNewTab');
};

const modeButton = (active: boolean): string =>
  `inline-flex h-8 w-8 items-center justify-center rounded-md bg-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
    active
      ? 'text-primary ring-1 ring-inset ring-primary/55 hover:text-primary'
      : 'text-secondary hover:bg-surface-raised hover:text-foreground'
  } disabled:pointer-events-none disabled:opacity-40`;

const loadImage = (dataUrl: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Browser capture could not be decoded.'));
    image.src = dataUrl;
  });

export interface BrowserPanelHandle {
  promoteRecordingSession: (fromSessionId: string, toSessionId: string) => void;
  closeTab: (targetId: string) => void;
  openTabContextMenu: (
    targetId: string,
    x: number,
    y: number,
    closeActions?: BrowserTabCloseActions,
  ) => void;
  openTab: (url?: string, options?: Omit<BrowserOpenTabOptions, 'insertAfterTargetId'>) => boolean;
}

export interface BrowserTabCloseActions {
  canCloseOthers: boolean;
  canCloseRight: boolean;
  close: () => void | Promise<void>;
  closeOthers: () => void | Promise<void>;
  closeRight: () => void | Promise<void>;
  restoreFocus?: () => void;
}

interface BrowserPanelProps {
  draftKey: string;
  isOpen: boolean;
  width: number;
  activeTargetId: string | null;
  onClose: () => void;
  onWidthChange: (width: number) => void;
  onActiveTargetChange: (targetId: string | null) => void;
  onAddAnnotation: (annotation: BrowserAnnotationDraft) => boolean;
  onRequestBrowserSettings?: (page?: 'history' | 'downloads') => void;
  onStopTask?: () => Promise<boolean>;
  onCheckTaskStopped?: () => Promise<boolean>;
  onContinueTask?: (prompt: string) => Promise<BrowserContinueResult>;
  onTabsChange?: (tabs: BrowserPanelTab[]) => void;
  onRecordingRetentionChange?: (retained: boolean) => void;
  initialTabs?: readonly BrowserPanelTab[];
  retainedTargetIds?: readonly string[];
  agentInteractionStates?: readonly BrowserAgentInteractionState[];
  embedded?: boolean;
}

const BrowserPanel = forwardRef<BrowserPanelHandle, BrowserPanelProps>(function BrowserPanel(
  {
    draftKey,
    isOpen,
    width,
    activeTargetId,
    onClose,
    onWidthChange,
    onActiveTargetChange,
    onAddAnnotation,
    onRequestBrowserSettings,
    onStopTask,
    onCheckTaskStopped,
    onContinueTask,
    onTabsChange,
    onRecordingRetentionChange,
    initialTabs,
    retainedTargetIds,
    agentInteractionStates = [],
    embedded = false,
  },
  ref,
) {
  const [tabs, setTabs] = useState<BrowserPanelTab[]>(() => {
    if (initialTabs) {
      const tabs = [...initialTabs];
      setRetainedBrowserPanelTabs(draftKey, tabs);
      return tabs;
    }
    const retainedTabs = getRetainedBrowserPanelTabs(draftKey);
    if (retainedTabs) return retainedTabs;
    const tabs = embedded ? [] : [createBrowserPanelTab()];
    setRetainedBrowserPanelTabs(draftKey, tabs);
    return tabs;
  });
  const [urlDraft, setUrlDraft] = useState('');
  const [loadingTargets, setLoadingTargets] = useState<Set<string>>(() => new Set());
  const [agentBusyTargets, setAgentBusyTargets] = useState<Set<string>>(() => new Set());
  const [interventionBlocked, setInterventionBlocked] = useState(false);
  const [interventionDetailsHost, setInterventionDetailsHost] = useState<HTMLDivElement | null>(
    null,
  );
  const [browserMode, setBrowserMode] = useState(() => configService.getConfig().browserMode);
  useEffect(() => {
    const changed = () => setBrowserMode(configService.getConfig().browserMode);
    window.addEventListener('config-updated', changed);
    return () => window.removeEventListener('config-updated', changed);
  }, []);
  useEffect(() => {
    if (browserMode !== BrowserMode.Embedded || !onStopTask || !onContinueTask)
      setInterventionBlocked(false);
  }, [browserMode, onStopTask, onContinueTask]);
  const pendingAgentInteractionAcksRef = useRef(
    new Map<
      string,
      { sessionId: string; targetId: string; profile?: string; operationId: string }
    >(),
  );
  const acknowledgedExternalInteractionsRef = useRef(new Set<string>());
  const [loadErrors, setLoadErrors] = useState<Map<string, string>>(() => new Map());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [annotationNoticeSequence, setAnnotationNoticeSequence] = useState(0);
  const [mode, setMode] = useState<BrowserPanelMode>('interact');
  const [annotationTool, setAnnotationTool] = useState<BrowserAnnotationTool>('pen');
  const [annotationToolMenuAnchor, setAnnotationToolMenuAnchor] = useState<{
    left: number;
    right: number;
    top: number;
    bottom: number;
  } | null>(null);
  const [strokes, setStrokes] = useState<BrowserAnnotationStroke[]>([]);
  const [regions, setRegions] = useState<BrowserAnnotationRegion[]>([]);
  const [inspected, setInspected] = useState<BrowserInspectedElement | null>(null);
  const [hovered, setHovered] = useState<BrowserInspectedElement | null>(null);
  const [draftRectangle, setDraftRectangle] = useState<BrowserAnnotationRegion | null>(null);
  const [navigationVersion, setNavigationVersion] = useState(0);
  const [readyTargets, setReadyTargets] = useState<Set<string>>(() => new Set());
  const [isCapturing, setIsCapturing] = useState(false);
  const [commentDraft, setCommentDraft] = useState('');
  const [isCommentComposerOpen, setIsCommentComposerOpen] = useState(false);
  const [tabMenu, setTabMenu] = useState<{
    targetId: string;
    x: number;
    y: number;
    closeActions?: BrowserTabCloseActions;
  } | null>(null);
  const [renamingTargetId, setRenamingTargetId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [overflowMenuAnchor, setOverflowMenuAnchor] = useState<{
    left: number;
    right: number;
    top: number;
    bottom: number;
  } | null>(null);
  const [zoomFactor, setZoomFactor] = useState(1);
  const [findVisible, setFindVisible] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findResult, setFindResult] = useState<{ active: number; matches: number } | null>(null);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [isClearDataModalOpen, setIsClearDataModalOpen] = useState(false);
  const [httpAuthRequests, setHttpAuthRequests] = useState<BrowserPanelHttpAuthRequest[]>([]);
  const httpAuthRequestsRef = useRef(httpAuthRequests);
  httpAuthRequestsRef.current = httpAuthRequests;
  const pdfViewersRef = useRef(new Map<string, BrowserPdfViewerHandle>());
  const pdfZoomFactorsRef = useRef(new Map<string, number>());
  const [nonPdfUrls, setNonPdfUrls] = useState(new Map<string, string>());
  const [compatibilityPdfUrls, setCompatibilityPdfUrls] = useState(new Map<string, string>());
  const [credentialOfferTargetId, setCredentialOfferTargetId] = useState<string | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const addressDirtyRef = useRef(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const webviewsRef = useRef(new Map<string, LiveWebview>());
  const installedGuestsRef = useRef(new WeakSet<LiveWebview>());
  const guestElementRefs = useRef(new Map<string, (element: HTMLElement | null) => void>());
  const currentDraftKeyRef = useRef(draftKey);
  currentDraftKeyRef.current = draftKey;
  const registeredDraftKeyRef = useRef(draftKey);
  const readyGuestsRef = useRef(new WeakSet<LiveWebview>());
  const initialUrlsRef = useRef(new Map(tabs.map(tab => [tab.targetId, tab.url])));
  const tabsRef = useRef(tabs);
  const onTabsChangeRef = useRef(onTabsChange);
  onTabsChangeRef.current = onTabsChange;
  const closedTabsRef = useRef<BrowserPanelTab[]>([]);
  const pendingInspectionsRef = useRef(
    new Map<string, (value: BrowserInspectedElement[]) => void>(),
  );
  const gestureRef = useRef<Gesture | null>(null);
  const annotationOrderRef = useRef<Array<'stroke' | 'region'>>([]);
  const activeTargetRef = useRef(activeTargetId);
  const inspectionSequenceRef = useRef(0);
  const contentEpochRef = useRef(0);
  const inspectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const annotationNoticeTargetRef = useRef<string | null>(null);
  const annotationNoticeTextRef = useRef<string | null>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const addressSubmissionSequenceRef = useRef(0);

  const activeTab = tabs.find(tab => tab.targetId === activeTargetId) ?? tabs[0] ?? null;
  activeTargetRef.current = activeTab?.targetId ?? null;
  const activeWebview = activeTab ? (webviewsRef.current.get(activeTab.targetId) ?? null) : null;
  const canNavigate = (direction: 'back' | 'forward'): boolean => {
    if (!activeWebview?.isConnected || !readyGuestsRef.current.has(activeWebview)) return false;
    try {
      return direction === 'back' ? activeWebview.canGoBack() : activeWebview.canGoForward();
    } catch {
      // A retained target can outlive its Electron guest during session changes.
      return false;
    }
  };
  const recorder = useBrowserRecording({
    draftKey,
    isOpen,
    activeTab: activeTab ?? undefined,
    tabs,
    guests: webviewsRef,
  });
  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;
  const recordingRetentionCallback = useRef(onRecordingRetentionChange);
  recordingRetentionCallback.current = onRecordingRetentionChange;
  const retainsRecording = Boolean(recorder.session) || recorder.busy;
  useEffect(() => {
    recordingRetentionCallback.current?.(retainsRecording);
  }, [retainsRecording]);
  const isRecording = !!recorder.session && recorder.session.status !== RecordingStatus.Review;
  const detectedPdfUrl =
    activeTab &&
    nonPdfUrls.get(activeTab.targetId) !== activeTab.url &&
    (activeTab.pdfUrl === activeTab.url || isLikelyPdfUrl(activeTab.url))
      ? activeTab.url
      : null;
  const activePdfUrl =
    activeTab && compatibilityPdfUrls.get(activeTab.targetId) === detectedPdfUrl
      ? detectedPdfUrl
      : null;
  const loading = activeTab ? loadingTargets.has(activeTab.targetId) : false;
  const visibleError = error ?? (activeTab ? loadErrors.get(activeTab.targetId) : null);
  const visibleHttpAuthRequest = httpAuthRequests.find(request => {
    try {
      return activeWebview?.getWebContentsId?.() === request.guestId;
    } catch {
      return false;
    }
  });

  const clearAnnotations = useCallback(() => {
    contentEpochRef.current += 1;
    inspectionSequenceRef.current += 1;
    if (inspectionTimerRef.current) clearTimeout(inspectionTimerRef.current);
    inspectionTimerRef.current = null;
    gestureRef.current = null;
    annotationOrderRef.current = [];
    setStrokes([]);
    setRegions([]);
    setDraftRectangle(null);
    setInspected(null);
    setHovered(null);
    setCommentDraft('');
    setIsCommentComposerOpen(false);
    setAnnotationToolMenuAnchor(null);
    setMode('interact');
  }, []);

  const toggleAnnotationMode = useCallback(
    (nextMode: Exclude<BrowserPanelMode, 'interact'>) => {
      if (activePdfUrl || isRecording) return;
      setAnnotationToolMenuAnchor(null);
      setHovered(null);
      gestureRef.current = null;
      setDraftRectangle(null);

      if (mode === nextMode) {
        inspectionSequenceRef.current += 1;
        if (inspectionTimerRef.current) clearTimeout(inspectionTimerRef.current);
        inspectionTimerRef.current = null;
        if (nextMode === 'inspect') {
          setInspected(null);
          setCommentDraft('');
          setIsCommentComposerOpen(false);
        }
        setMode('interact');
        return;
      }

      if (nextMode === 'inspect') {
        setInspected(null);
        setCommentDraft('');
        setIsCommentComposerOpen(false);
      }
      setMode(nextMode);
    },
    [activePdfUrl, mode, isRecording],
  );

  useEffect(() => {
    tabsRef.current = tabs;
    setRetainedBrowserPanelTabs(draftKey, tabs);
    onTabsChangeRef.current?.(tabs);
  }, [draftKey, tabs]);

  useEffect(() => {
    setAgentBusyTargets(new Set());
    pendingAgentInteractionAcksRef.current.clear();
    return window.electron.browser.onAgentInteractionState(event => {
      if (event.sessionId !== draftKey) return;
      if (event.targetId === BROWSER_AGENT_PANEL_TARGET_ID) return;
      if (event.operationId) {
        if (event.busy) {
          pendingAgentInteractionAcksRef.current.set(event.operationId, {
            sessionId: event.sessionId,
            targetId: event.targetId,
            ...(event.profile ? { profile: event.profile } : {}),
            operationId: event.operationId,
          });
        } else {
          pendingAgentInteractionAcksRef.current.delete(event.operationId);
        }
      }
      setAgentBusyTargets(current => {
        const next = new Set(current);
        if (event.busy) next.add(event.targetId);
        else next.delete(event.targetId);
        return next;
      });
    });
  }, [draftKey]);

  useEffect(() => {
    if (!initialTabs?.length || tabsRef.current.length) return;
    const tabs = [...initialTabs];
    for (const tab of tabs) initialUrlsRef.current.set(tab.targetId, tab.url);
    tabsRef.current = tabs;
    setTabs(tabs);
  }, [initialTabs]);

  const retainedTargetIdsKey = retainedTargetIds?.join('\0');
  const appliedRetainedTargetIdsKeyRef = useRef<string>();
  useEffect(() => {
    if (
      retainedTargetIdsKey === undefined ||
      appliedRetainedTargetIdsKeyRef.current === retainedTargetIdsKey
    ) {
      return;
    }
    // StrictMode can replay this effect after the parent opens the first tab.
    // Apply each retention snapshot once so stale empty IDs cannot remove it.
    appliedRetainedTargetIdsKeyRef.current = retainedTargetIdsKey;
    const retainedIds = new Set(retainedTargetIdsKey ? retainedTargetIdsKey.split('\0') : []);
    setTabs(current => {
      const retainedTabs = current.filter(tab => retainedIds.has(tab.targetId));
      tabsRef.current = retainedTabs;
      return retainedTabs;
    });
    setLoadingTargets(
      current => new Set([...current].filter(targetId => retainedIds.has(targetId))),
    );
    setReadyTargets(current => new Set([...current].filter(targetId => retainedIds.has(targetId))));
    setLoadErrors(
      current => new Map([...current].filter(([targetId]) => retainedIds.has(targetId))),
    );
    for (const targetId of initialUrlsRef.current.keys()) {
      if (!retainedIds.has(targetId)) initialUrlsRef.current.delete(targetId);
    }
    for (const targetId of guestElementRefs.current.keys()) {
      if (!retainedIds.has(targetId)) guestElementRefs.current.delete(targetId);
    }
  }, [retainedTargetIdsKey]);

  const activeTabTargetId = activeTab?.targetId ?? null;
  const externalAgentBusyTargets = new Set(
    agentInteractionStates.filter(state => state.busy).map(state => state.targetId),
  );
  const userInteractionLocked = Boolean(
    isOpen && activeTabTargetId && (mode !== 'interact' || isCommentComposerOpen || isCapturing),
  );
  const browserOperationRunning = Boolean(
    externalAgentBusyTargets.has(BROWSER_AGENT_PANEL_TARGET_ID) ||
    agentBusyTargets.has(BROWSER_AGENT_PANEL_TARGET_ID) ||
    (activeTabTargetId && agentBusyTargets.has(activeTabTargetId)),
  );
  const agentInteractionLocked = !userInteractionLocked && browserOperationRunning;
  useLayoutEffect(() => {
    if (userInteractionLocked) return;
    const externalOperationIds = new Set(
      agentInteractionStates.flatMap(state => (state.operationId ? [state.operationId] : [])),
    );
    for (const operationId of acknowledgedExternalInteractionsRef.current) {
      if (!externalOperationIds.has(operationId)) {
        acknowledgedExternalInteractionsRef.current.delete(operationId);
      }
    }
    for (const acknowledgement of agentInteractionStates) {
      if (
        !acknowledgement.busy ||
        !acknowledgement.operationId ||
        acknowledgedExternalInteractionsRef.current.has(acknowledgement.operationId)
      ) {
        continue;
      }
      window.electron.browser.acknowledgeAgentInteraction({
        sessionId: acknowledgement.sessionId,
        targetId: acknowledgement.targetId,
        ...(acknowledgement.profile ? { profile: acknowledgement.profile } : {}),
        operationId: acknowledgement.operationId,
      });
      acknowledgedExternalInteractionsRef.current.add(acknowledgement.operationId);
    }
    for (const [operationId, acknowledgement] of pendingAgentInteractionAcksRef.current) {
      if (!agentBusyTargets.has(acknowledgement.targetId)) {
        continue;
      }
      if (
        acknowledgement.targetId !== BROWSER_AGENT_PANEL_TARGET_ID &&
        acknowledgement.targetId !== activeTabTargetId
      ) {
        continue;
      }
      window.electron.browser.acknowledgeAgentInteraction(acknowledgement);
      pendingAgentInteractionAcksRef.current.delete(operationId);
    }
  }, [activeTabTargetId, agentBusyTargets, agentInteractionStates, userInteractionLocked]);
  useEffect(() => {
    if (!activeTabTargetId || !userInteractionLocked) return;
    const state = {
      sessionId: draftKey,
      targetId: activeTabTargetId,
      busy: true,
    };
    window.electron.browser.setUserInteractionState(state);
    return () =>
      window.electron.browser.setUserInteractionState({
        ...state,
        busy: false,
      });
  }, [activeTabTargetId, draftKey, userInteractionLocked]);
  useEffect(() => {
    if (!activeTabTargetId) return;
    window.electron.browser.setAgentActiveTab({
      sessionId: draftKey,
      targetId: activeTabTargetId,
    });
  }, [activeTabTargetId, draftKey]);
  const annotationAddedNotice = i18nService.t('browserAnnotationAdded');
  useEffect(() => {
    if (!activeTabTargetId) return;
    if (activeTargetId !== activeTabTargetId) onActiveTargetChange(activeTabTargetId);
    const selectedTab = tabsRef.current.find(tab => tab.targetId === activeTabTargetId);
    addressDirtyRef.current = false;
    setError(null);
    setUrlDraft(getBrowserTabAddress(selectedTab));
  }, [activeTabTargetId, activeTargetId, onActiveTargetChange]);

  useEffect(() => {
    const noticeTargetId = annotationNoticeTargetRef.current;
    if (!noticeTargetId || noticeTargetId === activeTabTargetId) return;
    const noticeText = annotationNoticeTextRef.current;
    annotationNoticeTargetRef.current = null;
    annotationNoticeTextRef.current = null;
    setNotice(current => (current === noticeText ? null : current));
  }, [activeTabTargetId]);

  useEffect(() => {
    if (!annotationNoticeTargetRef.current || annotationNoticeSequence === 0) return;
    const previousText = annotationNoticeTextRef.current;
    annotationNoticeTextRef.current = annotationAddedNotice;
    setNotice(current =>
      current === previousText || current === null ? annotationAddedNotice : current,
    );
    const targetId = annotationNoticeTargetRef.current;
    const timer = window.setTimeout(() => {
      if (annotationNoticeTargetRef.current !== targetId) return;
      annotationNoticeTargetRef.current = null;
      annotationNoticeTextRef.current = null;
      setNotice(current => (current === annotationAddedNotice ? null : current));
    }, ANNOTATION_NOTICE_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [annotationAddedNotice, annotationNoticeSequence]);

  useEffect(() => clearAnnotations(), [clearAnnotations, draftKey]);
  useEffect(() => setCredentialOfferTargetId(null), [activeTabTargetId]);
  useEffect(() => {
    if (!isOpen) {
      setOverflowMenuAnchor(null);
      setAnnotationToolMenuAnchor(null);
      setTabMenu(null);
      setIsImportModalOpen(false);
      setIsClearDataModalOpen(false);
      setIsCommentComposerOpen(false);
      setCredentialOfferTargetId(null);
    }
  }, [isOpen]);
  useEffect(
    () => () => {
      if (inspectionTimerRef.current) clearTimeout(inspectionTimerRef.current);
      inspectionSequenceRef.current += 1;
      contentEpochRef.current += 1;
      pendingInspectionsRef.current.forEach(resolve => resolve([]));
      pendingInspectionsRef.current.clear();
    },
    [],
  );

  const updateTab = useCallback(
    (targetId: string, values: Partial<BrowserPanelTab>) => {
      const nextTabs = tabsRef.current.map(tab =>
        tab.targetId === targetId ? { ...tab, ...values } : tab,
      );
      tabsRef.current = nextTabs;
      setRetainedBrowserPanelTabs(draftKey, nextTabs);
      setTabs(nextTabs);
    },
    [draftKey],
  );

  const openTab = useCallback(
    (rawUrl = 'about:blank', options?: BrowserOpenTabOptions) => {
      if (options?.targetId && tabsRef.current.some(tab => tab.targetId === options.targetId)) {
        return true;
      }
      const url = normalizeUrl(rawUrl);
      if (!url || tabsRef.current.length >= 8) return false;
      const tab = createBrowserPanelTab(url, options);
      initialUrlsRef.current.set(tab.targetId, tab.url);
      const insertionIndex = options?.insertAfterTargetId
        ? tabsRef.current.findIndex(
            candidate => candidate.targetId === options.insertAfterTargetId,
          ) + 1
        : tabsRef.current.length;
      const nextTabs = [...tabsRef.current];
      nextTabs.splice(insertionIndex > 0 ? insertionIndex : nextTabs.length, 0, tab);
      tabsRef.current = nextTabs;
      setTabs(nextTabs);
      activeTargetRef.current = tab.targetId;
      onActiveTargetChange(tab.targetId);
      setUrlDraft(getBrowserTabAddress(tab));
      clearAnnotations();
      if (tab.url === 'about:blank') {
        requestAnimationFrame(() => {
          addressInputRef.current?.focus();
          addressInputRef.current?.select();
        });
      }
      return true;
    },
    [clearAnnotations, onActiveTargetChange],
  );

  useEffect(
    () =>
      window.electron.browser.onPanelOpenTab(event => {
        const openerTargetId =
          event.openerGuestId === undefined
            ? undefined
            : [...webviewsRef.current.entries()].find(
                ([, webview]) => webview.getWebContentsId?.() === event.openerGuestId,
              )?.[0];
        if (event.openerGuestId !== undefined && !openerTargetId) {
          return;
        }
        if (event.openerGuestId === undefined && !isOpen) return;
        if (event.errorCode === 'post-navigation-blocked') {
          setNotice(i18nService.t('browserPanelPostNavigationBlocked'));
          return;
        }
        const openerTab = openerTargetId
          ? tabsRef.current.find(tab => tab.targetId === openerTargetId)
          : undefined;
        openTab(event.url, { profile: openerTab?.profile });
      }),
    [isOpen, openTab],
  );

  const clearNonPdfFallback = useCallback((targetId: string) => {
    setNonPdfUrls(current => {
      if (!current.has(targetId)) return current;
      const next = new Map(current);
      next.delete(targetId);
      return next;
    });
  }, []);

  const respondToHttpAuth = useCallback((response: BrowserPanelHttpAuthResponse) => {
    window.electron.browser.respondToPanelHttpAuth(response);
    setHttpAuthRequests(current => current.filter(item => item.id !== response.id));
  }, []);

  useEffect(() => {
    const removeRequest = window.electron.browser.onPanelHttpAuthRequest(request => {
      const ownsGuest = [...webviewsRef.current.values()].some(webview => {
        try {
          return webview.getWebContentsId?.() === request.guestId;
        } catch {
          return false;
        }
      });
      if (!ownsGuest) return;
      setHttpAuthRequests(current =>
        current.some(item => item.id === request.id) ? current : [...current, request],
      );
    });
    const removeDismissed = window.electron.browser.onPanelHttpAuthDismissed(event => {
      setHttpAuthRequests(current => current.filter(item => item.id !== event.id));
    });
    return () => {
      removeRequest();
      removeDismissed();
      for (const { id, guestId } of httpAuthRequestsRef.current) {
        window.electron.browser.respondToPanelHttpAuth({ id, guestId });
      }
    };
  }, []);

  useEffect(
    () =>
      window.electron.browser.onPanelPdfDetected(event => {
        const targetId = [...webviewsRef.current.entries()].find(([, webview]) => {
          try {
            return webview.getWebContentsId?.() === event.guestId;
          } catch {
            return false;
          }
        })?.[0];
        if (!targetId) return;
        clearNonPdfFallback(targetId);
        updateTab(targetId, { pdfUrl: event.url });
      }),
    [clearNonPdfFallback, updateTab],
  );

  const closeTab = useCallback(
    (targetId: string) => {
      const performClose = () => {
        const currentTabs = tabsRef.current;
        const closingIndex = currentTabs.findIndex(tab => tab.targetId === targetId);
        if (closingIndex < 0) return;
        const closingTab = currentTabs[closingIndex]!;
        const closingWebview = webviewsRef.current.get(targetId);
        const closingUrl = closingWebview?.getURL() || closingTab.url;
        if (closingUrl && closingUrl !== 'about:blank') {
          closedTabsRef.current = [
            ...closedTabsRef.current.slice(-9),
            { ...closingTab, url: closingUrl },
          ];
        }
        initialUrlsRef.current.delete(targetId);
        pdfZoomFactorsRef.current.delete(targetId);
        setCompatibilityPdfUrls(current => {
          const next = new Map(current);
          next.delete(targetId);
          return next;
        });
        setNonPdfUrls(current => {
          if (!current.has(targetId)) return current;
          const next = new Map(current);
          next.delete(targetId);
          return next;
        });
        guestElementRefs.current.delete(targetId);
        const nextTabs = currentTabs.filter(tab => tab.targetId !== targetId);
        tabsRef.current = nextTabs;
        setTabs(nextTabs);
        setReadyTargets(current => {
          const next = new Set(current);
          next.delete(targetId);
          return next;
        });
        setLoadingTargets(current => {
          const next = new Set(current);
          next.delete(targetId);
          return next;
        });
        setLoadErrors(current => {
          const next = new Map(current);
          next.delete(targetId);
          return next;
        });
        if (activeTargetRef.current !== targetId) return;
        clearAnnotations();
        const nextTab = nextTabs[Math.min(closingIndex, nextTabs.length - 1)] ?? null;
        activeTargetRef.current = nextTab?.targetId ?? null;
        onActiveTargetChange(nextTab?.targetId ?? null);
        setUrlDraft(getBrowserTabAddress(nextTab));
        if (nextTab) setTimeout(() => webviewsRef.current.get(nextTab.targetId)?.focus(), 0);
      };
      if (recorderRef.current.session?.status === RecordingStatus.Recording)
        void recorderRef.current.drain().then(performClose);
      else performClose();
    },
    [clearAnnotations, onActiveTargetChange],
  );

  const openTabContextMenu = useCallback(
    (targetId: string, x: number, y: number, closeActions?: BrowserTabCloseActions) => {
      if (!tabsRef.current.some(tab => tab.targetId === targetId)) return;
      setTabMenu({ targetId, x, y, closeActions });
    },
    [],
  );

  useImperativeHandle(
    ref,
    () => ({
      closeTab,
      openTabContextMenu,
      openTab,
      promoteRecordingSession: (fromSessionId, toSessionId) =>
        recorderRef.current.promoteSession(fromSessionId, toSessionId),
    }),
    [closeTab, openTab, openTabContextMenu],
  );

  const runBrowserCommand = useCallback(
    (command: BrowserGuestCommand, sourceTargetId = activeTargetRef.current) => {
      if (command === 'focus-address') {
        addressInputRef.current?.focus();
        addressInputRef.current?.select();
        return;
      }
      if (command === 'new-tab') {
        openTab('about:blank', {
          profile: tabsRef.current.find(tab => tab.targetId === sourceTargetId)?.profile,
        });
        return;
      }
      if (command === 'reopen-tab') {
        const closedTab = closedTabsRef.current.pop();
        if (closedTab) {
          openTab(closedTab.url, {
            profile: closedTab.profile,
            sourceFilePath: closedTab.sourceFilePath,
            sourcePreviewUrl: closedTab.sourcePreviewUrl,
            sourceRootPath: closedTab.sourceRootPath,
            sourcePreviewRootUrl: closedTab.sourcePreviewRootUrl,
          });
        }
        return;
      }
      if (command === 'close-tab') {
        if (sourceTargetId) closeTab(sourceTargetId);
        return;
      }
      if (command === 'next-tab' || command === 'previous-tab') {
        const currentTabs = tabsRef.current;
        if (currentTabs.length < 2) return;
        const currentIndex = Math.max(
          0,
          currentTabs.findIndex(tab => tab.targetId === activeTargetRef.current),
        );
        const direction = command === 'next-tab' ? 1 : -1;
        const nextTab =
          currentTabs[(currentIndex + direction + currentTabs.length) % currentTabs.length]!;
        activeTargetRef.current = nextTab.targetId;
        onActiveTargetChange(nextTab.targetId);
        setUrlDraft(getBrowserTabAddress(nextTab));
        clearAnnotations();
        setTimeout(() => webviewsRef.current.get(nextTab.targetId)?.focus(), 0);
        return;
      }
      if (command === 'reload' && sourceTargetId) {
        clearNonPdfFallback(sourceTargetId);
        const viewer = pdfViewersRef.current.get(sourceTargetId);
        if (viewer) {
          viewer.reload();
          return;
        }
      }
      const webview = sourceTargetId ? webviewsRef.current.get(sourceTargetId) : null;
      if (!webview?.isConnected || !readyGuestsRef.current.has(webview)) return;
      try {
        if (command === 'reload') webview.reload();
        else if (command === 'back' && webview.canGoBack()) webview.goBack();
        else if (command === 'forward' && webview.canGoForward()) webview.goForward();
      } catch {
        // The guest can detach between the toolbar render and the command.
      }
    },
    [clearAnnotations, clearNonPdfFallback, closeTab, onActiveTargetChange, openTab],
  );

  const handleNavigation = useCallback(
    (
      targetId: string,
      webview: LiveWebview,
      url?: string,
      title?: string,
      authoritative = false,
    ) => {
      const nextUrl = url || webview.getURL() || 'about:blank';
      const retainedTab = tabsRef.current.find(tab => tab.targetId === targetId);
      // A newly attached Electron webview can briefly report its bootstrap
      // about:blank document before loading the retained URL. Treat that event
      // as transient so hiding/reopening the panel cannot erase the real page.
      if (nextUrl === 'about:blank' && retainedTab?.url !== 'about:blank') return;
      updateTab(targetId, {
        url: nextUrl,
        title: title || webview.getTitle() || '',
        pdfUrl: retainedTab?.pdfUrl === nextUrl ? nextUrl : undefined,
      });
      if (activeTargetRef.current === targetId) {
        setCredentialOfferTargetId(null);
        if (authoritative) addressDirtyRef.current = false;
        if (authoritative || !addressDirtyRef.current) {
          const nextTab = retainedTab ? { ...retainedTab, url: nextUrl } : undefined;
          setUrlDraft(getBrowserTabAddress(nextTab));
        }
        clearAnnotations();
        setNavigationVersion(value => value + 1);
      }
      if (authoritative) {
        setLoadErrors(current => {
          const next = new Map(current);
          next.delete(targetId);
          return next;
        });
      }
    },
    [clearAnnotations, updateTab],
  );

  const installGuest = useCallback(
    (targetId: string, webview: LiveWebview | null) => {
      if (!webview) {
        const previousGuest = webviewsRef.current.get(targetId);
        if (previousGuest) readyGuestsRef.current.delete(previousGuest);
        webviewsRef.current.delete(targetId);
        setReadyTargets(current => {
          if (!current.has(targetId)) return current;
          const next = new Set(current);
          next.delete(targetId);
          return next;
        });
        for (const sessionId of new Set([
          registeredDraftKeyRef.current,
          currentDraftKeyRef.current,
        ])) {
          window.electron.browser.unregisterAgentTab({ sessionId, targetId });
        }
        return;
      }
      webviewsRef.current.set(targetId, webview);
      const registerAgentTab = () => {
        try {
          const webContentsId = webview.getWebContentsId?.();
          if (Number.isInteger(webContentsId)) {
            const sessionId = currentDraftKeyRef.current;
            window.electron.browser.registerAgentTab({
              sessionId,
              targetId,
              webContentsId: webContentsId!,
              profile:
                tabsRef.current.find(candidate => candidate.targetId === targetId)?.profile ??
                'embedded',
            });
            if (activeTargetRef.current === targetId) {
              window.electron.browser.setAgentActiveTab({ sessionId, targetId });
            }
          }
        } catch {
          // A newly attached webview receives its id at dom-ready.
        }
      };
      registerAgentTab();
      if (installedGuestsRef.current.has(webview)) return;
      installedGuestsRef.current.add(webview);
      webview.addEventListener('did-start-navigation', event => {
        const details = event as GuestEvent;
        if (details.isMainFrame === true) clearNonPdfFallback(targetId);
      });
      webview.addEventListener('did-start-loading', () => {
        registerAgentTab();
        updateTab(targetId, { pdfUrl: undefined });
        setLoadingTargets(current => new Set(current).add(targetId));
        setLoadErrors(current => {
          const next = new Map(current);
          next.delete(targetId);
          return next;
        });
      });
      webview.addEventListener('did-attach', registerAgentTab);
      webview.addEventListener('did-stop-loading', () => {
        registerAgentTab();
        setLoadingTargets(current => {
          const next = new Set(current);
          next.delete(targetId);
          return next;
        });
        handleNavigation(targetId, webview);
      });
      webview.addEventListener('dom-ready', () => {
        if (webviewsRef.current.get(targetId) !== webview || !webview.isConnected) return;
        recorderRef.current.onReady(targetId);
        registerAgentTab();
        readyGuestsRef.current.add(webview);
        const retainedTab = tabsRef.current.find(tab => tab.targetId === targetId);
        const currentUrl = webview.getURL() || retainedTab?.url || 'about:blank';
        if (retainedTab && isAtSourcePreview({ ...retainedTab, url: currentUrl })) {
          try {
            // Electron persists zoom per host. Every isolated local preview is served from
            // 127.0.0.1, so a zoom chosen for an earlier preview would otherwise leak into
            // unrelated files (and can break canvas libraries that derive input from DPR).
            webview.setZoomFactor?.(1);
            if (activeTargetRef.current === targetId) setZoomFactor(1);
          } catch {
            // The guest can detach while its ready event is being delivered.
          }
        }
        setReadyTargets(current => new Set(current).add(targetId));
        handleNavigation(targetId, webview);
      });
      webview.addEventListener('ipc-message', event => {
        const details = event as GuestEvent;
        recorderRef.current.onMessage(targetId, details.channel ?? '', details.args?.[0]);
        if (details.channel === BROWSER_GUEST_COMMAND_CHANNEL) {
          const [command] = details.args ?? [];
          if (isBrowserGuestCommand(command)) runBrowserCommand(command, targetId);
          return;
        }
        if (details.channel === BROWSER_GUEST_ZOOM_CHANNEL) {
          const [direction] = details.args ?? [];
          if (!isBrowserGuestZoomDirection(direction)) return;
          const pdfViewer = pdfViewersRef.current.get(targetId);
          if (pdfViewer) {
            pdfViewer.setZoom(
              stepBrowserZoomFactor(pdfZoomFactorsRef.current.get(targetId) ?? 1, direction),
            );
            return;
          }
          try {
            const nextFactor = stepBrowserZoomFactor(webview.getZoomFactor?.() ?? 1, direction);
            webview.setZoomFactor?.(nextFactor);
            if (activeTargetRef.current === targetId) setZoomFactor(nextFactor);
          } catch {
            // The guest can detach between receiving its wheel event and applying zoom.
          }
          return;
        }
        if (details.channel === 'justdo-browser-viewport-changed') {
          if (activeTargetRef.current === targetId) clearAnnotations();
          return;
        }
        if (details.channel === BROWSER_GUEST_CREDENTIALS_OFFER_CHANNEL) {
          if (activeTargetRef.current === targetId) setCredentialOfferTargetId(targetId);
          return;
        }
        if (details.channel !== 'justdo-browser-inspect-result') return;
        const [requestId, raw] = details.args ?? [];
        if (typeof requestId !== 'string') return;
        const resolve = pendingInspectionsRef.current.get(requestId);
        if (!resolve) return;
        pendingInspectionsRef.current.delete(requestId);
        resolve(
          Array.isArray(raw)
            ? raw.flatMap(value => normalizeLiveInspectedElement(value) ?? []).slice(0, 12)
            : [],
        );
      });
      for (const eventName of ['did-navigate', 'did-navigate-in-page']) {
        webview.addEventListener(eventName, event => {
          const details = event as GuestEvent;
          if (details.isMainFrame === false) return;
          recorderRef.current.onNavigation(targetId, details.url ?? webview.getURL());
          handleNavigation(targetId, webview, details.url, undefined, true);
        });
      }
      webview.addEventListener('page-title-updated', event => {
        updateTab(targetId, { title: (event as GuestEvent).title ?? webview.getTitle() });
      });
      webview.addEventListener('page-favicon-updated', event => {
        const faviconUrl = (event as GuestEvent).favicons
          ?.map(normalizeFaviconUrl)
          .find((value): value is string => Boolean(value));
        if (faviconUrl) updateTab(targetId, { faviconUrl });
      });
      webview.addEventListener('found-in-page', event => {
        if (activeTargetRef.current !== targetId) return;
        const result = (event as GuestEvent).result;
        setFindResult({
          active: Math.max(0, result?.activeMatchOrdinal ?? 0),
          matches: Math.max(0, result?.matches ?? 0),
        });
      });
      webview.addEventListener('close', () => closeTab(targetId));
      webview.addEventListener('did-fail-load', event => {
        const details = event as GuestEvent;
        if (details.errorCode === -3 || details.isMainFrame === false) return;
        setLoadingTargets(current => {
          const next = new Set(current);
          next.delete(targetId);
          return next;
        });
        setLoadErrors(current =>
          new Map(current).set(
            targetId,
            details.errorDescription || i18nService.t('browserPanelLoadFailed'),
          ),
        );
      });
    },
    [
      clearAnnotations,
      clearNonPdfFallback,
      closeTab,
      handleNavigation,
      runBrowserCommand,
      updateTab,
    ],
  );
  const installGuestRef = useRef(installGuest);
  installGuestRef.current = installGuest;
  const getGuestElementRef = useCallback((targetId: string) => {
    const existing = guestElementRefs.current.get(targetId);
    if (existing) return existing;
    const callback = (element: HTMLElement | null) => {
      installGuestRef.current(targetId, element as LiveWebview | null);
    };
    guestElementRefs.current.set(targetId, callback);
    return callback;
  }, []);

  useEffect(() => {
    const previousDraftKey = registeredDraftKeyRef.current;
    if (previousDraftKey === draftKey) return;
    registeredDraftKeyRef.current = draftKey;
    for (const [targetId, webview] of webviewsRef.current) {
      window.electron.browser.unregisterAgentTab({ sessionId: previousDraftKey, targetId });
      try {
        const webContentsId = webview.getWebContentsId?.();
        if (!Number.isInteger(webContentsId)) continue;
        window.electron.browser.registerAgentTab({
          sessionId: draftKey,
          targetId,
          webContentsId: webContentsId!,
          profile:
            tabsRef.current.find(candidate => candidate.targetId === targetId)?.profile ??
            'embedded',
        });
        if (activeTargetRef.current === targetId) {
          window.electron.browser.setAgentActiveTab({ sessionId: draftKey, targetId });
        }
      } catch {
        // Registration retries on the next dom-ready event.
      }
    }
  }, [draftKey]);

  const drawOverlay = useCallback(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    const bounds = stage.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(bounds.width * ratio));
    canvas.height = Math.max(1, Math.round(bounds.height * ratio));
    canvas.style.width = `${bounds.width}px`;
    canvas.style.height = `${bounds.height}px`;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, bounds.width, bounds.height);
    context.strokeStyle = '#e0442d';
    context.fillStyle = 'rgba(224, 68, 45, 0.12)';
    context.lineWidth = Math.max(2, bounds.width * 0.005);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    strokes.forEach(stroke => {
      if (!stroke.points.length) return;
      context.beginPath();
      stroke.points.forEach((point, index) => {
        const x = point.x * bounds.width;
        const y = point.y * bounds.height;
        if (!index) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.stroke();
    });
    [...regions, ...(draftRectangle ? [draftRectangle] : [])].forEach(region => {
      context.fillRect(
        region.x * bounds.width,
        region.y * bounds.height,
        region.width * bounds.width,
        region.height * bounds.height,
      );
      context.strokeRect(
        region.x * bounds.width,
        region.y * bounds.height,
        region.width * bounds.width,
        region.height * bounds.height,
      );
    });
    const highlight = mode === 'interact' ? null : (inspected ?? hovered);
    if (highlight) {
      context.save();
      context.strokeStyle = inspected ? '#34d399' : '#38bdf8';
      context.fillStyle = inspected ? 'rgba(52, 211, 153, 0.12)' : 'rgba(56, 189, 248, 0.12)';
      context.lineWidth = 2;
      context.setLineDash(inspected ? [] : [5, 3]);
      context.fillRect(
        highlight.rect.x,
        highlight.rect.y,
        highlight.rect.width,
        highlight.rect.height,
      );
      context.strokeRect(
        highlight.rect.x,
        highlight.rect.y,
        highlight.rect.width,
        highlight.rect.height,
      );
      context.restore();
    }
  }, [draftRectangle, hovered, inspected, mode, regions, strokes]);

  useEffect(() => {
    drawOverlay();
    const observer = new ResizeObserver(drawOverlay);
    if (stageRef.current) observer.observe(stageRef.current);
    return () => observer.disconnect();
  }, [drawOverlay, navigationVersion]);

  const pointForEvent = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const bounds = stageRef.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return null;
    const x = Math.min(bounds.width, Math.max(0, event.clientX - bounds.left));
    const y = Math.min(bounds.height, Math.max(0, event.clientY - bounds.top));
    return { css: { x, y }, normalized: { x: x / bounds.width, y: y / bounds.height } };
  };

  const inspectPoints = useCallback(
    async (points: Array<{ x: number; y: number }>): Promise<BrowserInspectedElement[]> => {
      const webview = activeTargetRef.current
        ? webviewsRef.current.get(activeTargetRef.current)
        : null;
      if (!webview) return [];
      const requestId = crypto.randomUUID();
      return new Promise(resolve => {
        pendingInspectionsRef.current.set(requestId, resolve);
        webview.send('justdo-browser-inspect', requestId, points);
        setTimeout(() => {
          const pending = pendingInspectionsRef.current.get(requestId);
          if (!pending) return;
          pendingInspectionsRef.current.delete(requestId);
          pending([]);
        }, 3_000);
      });
    },
    [],
  );

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    const point = pointForEvent(event);
    if (!point) return;
    if (mode === 'pen') {
      const stroke = { points: [point.normalized] };
      gestureRef.current = { kind: 'pen', pointerId: event.pointerId, stroke };
      annotationOrderRef.current.push('stroke');
      setStrokes(current => [...current, stroke]);
      event.currentTarget.setPointerCapture(event.pointerId);
    } else if (mode === 'rectangle') {
      gestureRef.current = {
        kind: 'rectangle',
        pointerId: event.pointerId,
        start: point.normalized,
      };
      setDraftRectangle({ ...point.normalized, width: 0, height: 0 });
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = pointForEvent(event);
    if (!point) return;
    const gesture = gestureRef.current;
    if (gesture?.kind === 'pen' && gesture.pointerId === event.pointerId) {
      const stroke = { points: [...gesture.stroke.points, point.normalized] };
      gestureRef.current = { ...gesture, stroke };
      setStrokes(current => [...current.slice(0, -1), stroke]);
      return;
    }
    if (gesture?.kind === 'rectangle' && gesture.pointerId === event.pointerId) {
      setDraftRectangle({
        x: Math.min(gesture.start.x, point.normalized.x),
        y: Math.min(gesture.start.y, point.normalized.y),
        width: Math.abs(point.normalized.x - gesture.start.x),
        height: Math.abs(point.normalized.y - gesture.start.y),
      });
      return;
    }
    if (mode !== 'inspect' || inspected) return;
    if (inspectionTimerRef.current) clearTimeout(inspectionTimerRef.current);
    const sequence = ++inspectionSequenceRef.current;
    inspectionTimerRef.current = setTimeout(() => {
      void inspectPoints([point.css])
        .then(elements => {
          if (sequence === inspectionSequenceRef.current) setHovered(elements[0] ?? null);
        })
        .catch(() => {
          if (sequence === inspectionSequenceRef.current)
            setError(i18nService.t('browserPanelInspectFailed'));
        });
    }, 120);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    if (gesture.kind === 'pen') {
      setIsCommentComposerOpen(true);
      return;
    }
    const point = pointForEvent(event);
    const bounds = stageRef.current?.getBoundingClientRect();
    setDraftRectangle(null);
    if (!point || !bounds) return;
    const region = {
      x: Math.min(gesture.start.x, point.normalized.x),
      y: Math.min(gesture.start.y, point.normalized.y),
      width: Math.abs(point.normalized.x - gesture.start.x),
      height: Math.abs(point.normalized.y - gesture.start.y),
    };
    if (region.width < 0.005 || region.height < 0.005) return;
    const left = region.x * bounds.width;
    const top = region.y * bounds.height;
    const right = (region.x + region.width) * bounds.width;
    const bottom = (region.y + region.height) * bounds.height;
    const points = [
      { x: (left + right) / 2, y: (top + bottom) / 2 },
      { x: left + 2, y: top + 2 },
      { x: right - 2, y: top + 2 },
      { x: left + 2, y: bottom - 2 },
      { x: right - 2, y: bottom - 2 },
    ];
    const epoch = contentEpochRef.current;
    const targetId = activeTargetRef.current;
    const pendingRegion: BrowserAnnotationRegion = region;
    annotationOrderRef.current.push('region');
    setRegions(current => [...current, pendingRegion]);
    setIsCommentComposerOpen(true);
    void inspectPoints(points)
      .then(elements => {
        if (epoch === contentEpochRef.current && targetId === activeTargetRef.current) {
          setRegions(current =>
            current.map(candidate =>
              candidate === pendingRegion ? { ...candidate, elements } : candidate,
            ),
          );
        }
      })
      .catch(() => undefined);
  };

  const handleCanvasClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (mode !== 'inspect') return;
    const bounds = stageRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const sequence = ++inspectionSequenceRef.current;
    const epoch = contentEpochRef.current;
    const targetId = activeTargetRef.current;
    void inspectPoints([{ x: event.clientX - bounds.left, y: event.clientY - bounds.top }])
      .then(elements => {
        if (
          sequence !== inspectionSequenceRef.current ||
          epoch !== contentEpochRef.current ||
          targetId !== activeTargetRef.current
        )
          return;
        setInspected(elements[0] ?? null);
        setHovered(elements[0] ?? null);
        if (elements[0]) setIsCommentComposerOpen(true);
      })
      .catch(() => {
        if (epoch === contentEpochRef.current && targetId === activeTargetRef.current)
          setError(i18nService.t('browserPanelInspectFailed'));
      });
  };

  const submitUrl = async () => {
    const submissionSequence = ++addressSubmissionSequenceRef.current;
    const targetId = activeTargetRef.current;
    const activeTab = tabsRef.current.find(tab => tab.targetId === targetId);
    const address = urlDraft.trim();
    let source: BrowserLocalHtmlSource | undefined;
    let url: string | null;
    if (activeTab && address === getBrowserTabAddress(activeTab)) {
      url = activeTab.url;
    } else if (isLocalFileAddress(address)) {
      try {
        const preview = await window.electron.browser.createLocalHtmlPreview(address);
        if (submissionSequence !== addressSubmissionSequenceRef.current) return;
        if (!preview.success) {
          setError(
            preview.errorCode === 'not_found'
              ? i18nService.t('coworkAttachmentNotFound').replace('{filepath}', address)
              : preview.errorCode === 'invalid_type' || preview.errorCode === 'invalid_source'
                ? i18nService.t('coworkLocalHtmlPreviewInvalid')
                : i18nService.t('coworkFilePreviewFailed'),
          );
          return;
        }
        url = preview.url;
        source = {
          sourceFilePath: preview.filePath,
          sourcePreviewUrl: preview.url,
          sourceRootPath: preview.rootPath,
          sourcePreviewRootUrl: preview.previewRootUrl,
        };
      } catch {
        if (submissionSequence !== addressSubmissionSequenceRef.current) return;
        setError(i18nService.t('coworkFilePreviewFailed'));
        return;
      }
    } else {
      url = resolveAddressInput(address);
    }
    if (!url) {
      setError(i18nService.t('browserPanelInvalidUrl'));
      return;
    }
    if (activeTab && isAtSourcePreview(activeTab) && url !== activeTab.url) {
      openTab(url, { ...source, profile: activeTab.profile });
      return;
    }
    const webview = targetId ? webviewsRef.current.get(targetId) : null;
    if (!webview || !targetId) return;
    if (activeTargetRef.current === targetId) clearAnnotations();
    addressDirtyRef.current = false;
    setError(null);
    setLoadErrors(current => {
      const next = new Map(current);
      next.delete(targetId);
      return next;
    });
    setLoadingTargets(current => new Set(current).add(targetId));
    updateTab(targetId, { url, ...source });
    if (source && activeTargetRef.current === targetId) setUrlDraft(source.sourceFilePath);
    try {
      await webview.loadURL(url);
    } catch (loadError) {
      setLoadingTargets(current => {
        const next = new Set(current);
        next.delete(targetId);
        return next;
      });
      setLoadErrors(current =>
        new Map(current).set(
          targetId,
          loadError instanceof Error ? loadError.message : i18nService.t('browserPanelLoadFailed'),
        ),
      );
    }
  };

  const addAnnotation = async () => {
    const comment = commentDraft.trim();
    const targetId = activeTargetRef.current;
    const webview = targetId ? webviewsRef.current.get(targetId) : null;
    const tab = tabs.find(candidate => candidate.targetId === targetId);
    if (
      !targetId ||
      activePdfUrl ||
      !webview ||
      !tab ||
      isCapturing ||
      !comment ||
      (!strokes.length && !regions.length && !inspected)
    )
      return;
    const captureEpoch = contentEpochRef.current;
    setIsCapturing(true);
    try {
      const capture = await webview.capturePage();
      const size = capture.getSize();
      const sourceDataUrl = capture.toDataURL();
      if (contentEpochRef.current !== captureEpoch || activeTargetRef.current !== targetId) return;
      if (
        size.width < 1 ||
        size.height < 1 ||
        size.width > 16_384 ||
        size.height > 16_384 ||
        size.width * size.height > 40_000_000 ||
        !sourceDataUrl.startsWith('data:image/png;base64,') ||
        browserAnnotationDataBytes(sourceDataUrl) > 20 * 1024 * 1024
      ) {
        setError(i18nService.t('browserPanelCaptureFailed'));
        return;
      }
      const image = await loadImage(sourceDataUrl);
      if (contentEpochRef.current !== captureEpoch || activeTargetRef.current !== targetId) return;
      const frame: BrowserPanelFrame = {
        targetId,
        url: getBrowserTabAddress({ ...tab, url: webview.getURL() || tab.url }),
        title: webview.getTitle() || tab.title,
        width: size.width,
        height: size.height,
        viewportWidth: Math.max(1, webview.clientWidth),
        viewportHeight: Math.max(1, webview.clientHeight),
        capturedAt: Date.now(),
        dataUrl: sourceDataUrl,
      };
      const dataUrl = composeAnnotatedBrowserImage({
        image,
        width: frame.width,
        height: frame.height,
        viewportWidth: frame.viewportWidth,
        viewportHeight: frame.viewportHeight,
        strokes,
        regions,
        element: inspected,
      });
      if (browserAnnotationDataBytes(dataUrl) > 20 * 1024 * 1024) {
        setError(i18nService.t('browserAnnotationTooLarge'));
        return;
      }
      const accepted = onAddAnnotation(
        buildBrowserAnnotationDraft({
          frame,
          profile: tab.profile ?? 'embedded',
          strokes,
          regions,
          element: inspected,
          dataUrl,
          comment,
        }),
      );
      if (!accepted) {
        setError(i18nService.t('browserAnnotationLimitReached'));
        return;
      }
      annotationNoticeTargetRef.current = targetId;
      annotationNoticeTextRef.current = annotationAddedNotice;
      setNotice(annotationAddedNotice);
      setAnnotationNoticeSequence(value => value + 1);
      clearAnnotations();
    } catch (captureError) {
      setError(
        captureError instanceof Error
          ? captureError.message
          : i18nService.t('browserPanelCaptureFailed'),
      );
    } finally {
      setIsCapturing(false);
    }
  };

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const handle = event.currentTarget;
    const max = getBrowserPanelMaxWidth(panelRef.current?.parentElement?.clientWidth);
    const move = (moveEvent: PointerEvent) => {
      onWidthChange(
        Math.max(BROWSER_PANEL_MIN_WIDTH, Math.min(max, startWidth + startX - moveEvent.clientX)),
      );
    };
    const up = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      handle.removeEventListener('lostpointercapture', up);
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    handle.setPointerCapture(event.pointerId);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
    handle.addEventListener('lostpointercapture', up);
  };

  const commitTabRename = (targetId: string) => {
    const customTitle = renameDraft.trim();
    updateTab(targetId, { customTitle: customTitle || undefined });
    setRenamingTargetId(null);
    setRenameDraft('');
  };

  const handleTabMenuAction = async (action: BrowserTabMenuAction) => {
    const targetId = tabMenu?.targetId;
    const externalCloseActions = tabMenu?.closeActions;
    setTabMenu(null);
    if (!targetId) return;
    const tab = tabsRef.current.find(candidate => candidate.targetId === targetId);
    if (!tab) return;
    const webview = webviewsRef.current.get(targetId);
    const url = webview?.getURL() || tab.url;

    if (action === 'new-right') {
      openTab('about:blank', { insertAfterTargetId: targetId, profile: tab.profile });
      return;
    }
    if (action === 'reload') {
      clearNonPdfFallback(targetId);
      const viewer = pdfViewersRef.current.get(targetId);
      if (viewer) viewer.reload();
      else webview?.reload();
      return;
    }
    if (action === 'duplicate') {
      openTab(url, {
        insertAfterTargetId: targetId,
        profile: tab.profile,
        ...(isAtSourcePreview(tab) && tab.sourceFilePath
          ? {
              sourceFilePath: tab.sourceFilePath,
              sourcePreviewUrl: tab.sourcePreviewUrl,
              sourceRootPath: tab.sourceRootPath,
              sourcePreviewRootUrl: tab.sourcePreviewRootUrl,
            }
          : {}),
      });
      return;
    }
    if (action === 'copy-url') {
      try {
        await navigator.clipboard.writeText(getBrowserTabAddress({ ...tab, url }));
        setNotice(
          isAtSourcePreview({ ...tab, url })
            ? i18nService.t('browserTabMenuFilePathCopied')
            : i18nService.t('browserTabMenuUrlCopied'),
        );
      } catch {
        setError(i18nService.t('browserTabMenuCopyFailed'));
      }
      return;
    }
    if (action === 'open-external') {
      const localFilePath = getLocalPreviewFilePath({ ...tab, url });
      if (!localFilePath && !/^https?:\/\//i.test(url)) return;
      const result = localFilePath
        ? await window.electron.shell.openLocalHtmlExternal(url)
        : await window.electron.shell.openExternal(url);
      if (!result.success) setError(result.error || i18nService.t('browserPanelLoadFailed'));
      return;
    }
    if (action === 'rename') {
      if (embedded && activeTargetRef.current !== targetId) {
        activeTargetRef.current = targetId;
        onActiveTargetChange(targetId);
      }
      setRenameDraft(getBrowserTabDisplayTitle(tab));
      setRenamingTargetId(targetId);
      return;
    }
    if (action === 'toggle-mute') {
      const muted = webview?.isAudioMuted?.() ?? Boolean(tab.muted);
      webview?.setAudioMuted?.(!muted);
      updateTab(targetId, { muted: !muted });
      return;
    }
    if (action === 'close') {
      if (externalCloseActions) {
        await externalCloseActions.close();
        return;
      }
      closeTab(targetId);
      return;
    }
    if (action === 'close-others' && externalCloseActions) {
      await externalCloseActions.closeOthers();
      return;
    }
    if (action === 'close-right' && externalCloseActions) {
      await externalCloseActions.closeRight();
      return;
    }
    const targetIndex = tabsRef.current.findIndex(candidate => candidate.targetId === targetId);
    const targetIds =
      action === 'close-others'
        ? tabsRef.current
            .filter(candidate => candidate.targetId !== targetId)
            .map(candidate => candidate.targetId)
        : tabsRef.current.slice(targetIndex + 1).map(candidate => candidate.targetId);
    targetIds.forEach(closeTab);
  };

  const runFind = useCallback(
    (forward = true, findNext = false) => {
      if (activePdfUrl) return;
      const query = findQuery.trim();
      if (!query || !activeWebview?.findInPage) {
        activeWebview?.stopFind?.('clearSelection');
        setFindResult(null);
        return;
      }
      activeWebview.findInPage(query, { forward, findNext });
    },
    [activePdfUrl, activeWebview, findQuery],
  );

  const closeFind = useCallback(() => {
    activeWebview?.stopFind?.('clearSelection');
    setFindVisible(false);
    setFindQuery('');
    setFindResult(null);
    activeWebview?.focus();
  }, [activeWebview]);

  const changeZoom = useCallback(
    (factor: number) => {
      const normalized = Math.min(2, Math.max(0.5, Math.round(factor * 10) / 10));
      if (activePdfUrl && activeTab) {
        pdfViewersRef.current.get(activeTab.targetId)?.setZoom(normalized);
        setZoomFactor(normalized);
        return;
      }
      if (!activeWebview || !readyGuestsRef.current.has(activeWebview)) return;
      try {
        activeWebview.setZoomFactor?.(normalized);
      } catch {
        // Electron can detach a guest between the readiness check and this call.
        return;
      }
      setZoomFactor(normalized);
    },
    [activePdfUrl, activeTab, activeWebview],
  );

  const handleOverflowAction = async (action: BrowserOverflowAction) => {
    setOverflowMenuAnchor(null);
    if (action === 'pdf-viewer' && activeTab && detectedPdfUrl) {
      clearAnnotations();
      setCompatibilityPdfUrls(current => {
        const next = new Map(current);
        if (activePdfUrl) next.delete(activeTab.targetId);
        else next.set(activeTab.targetId, detectedPdfUrl);
        return next;
      });
      return;
    }
    if (action === 'print' && detectedPdfUrl && !activePdfUrl) {
      setNotice(i18nService.t('browserPdfUseToolbar'));
      return;
    }
    if (activePdfUrl && ['find', 'print', 'screenshot', 'device-tools'].includes(action)) {
      setNotice(i18nService.t('browserPdfActionUnavailable'));
      return;
    }
    if (action === 'find') {
      setFindVisible(true);
      requestAnimationFrame(() => findInputRef.current?.focus());
      return;
    }
    if (action === 'print') {
      if (!activeWebview?.print) return;
      activeWebview.print({}, (success, failureReason) => {
        if (!success) setError(failureReason || i18nService.t('browserMenuPrintFailed'));
      });
      return;
    }
    if (action === 'device-tools') {
      activeWebview?.openDevTools?.();
      return;
    }
    if (action === 'screenshot') {
      if (!activeWebview || !activeTab) return;
      try {
        const capture = await activeWebview.capturePage();
        const dataUrl = capture.toDataURL();
        if (!dataUrl.startsWith('data:image/png;base64,')) throw new Error();
        const title = getBrowserTabDisplayTitle(activeTab)
          .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
          .slice(0, 80);
        const link = document.createElement('a');
        link.href = dataUrl;
        link.download = `${title || 'screenshot'}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
        link.click();
        setNotice(i18nService.t('browserMenuScreenshotSaved'));
      } catch {
        setError(i18nService.t('browserPanelCaptureFailed'));
      }
      return;
    }
    if (action === 'import-data') {
      setIsImportModalOpen(true);
      return;
    }
    if (action === 'clear-data') {
      setIsClearDataModalOpen(true);
      return;
    }
    if (action === 'history') {
      onRequestBrowserSettings?.('history');
      return;
    }
    if (action === 'downloads') {
      onRequestBrowserSettings?.('downloads');
      return;
    }
    if (action === 'settings') onRequestBrowserSettings?.();
  };

  useEffect(() => {
    if (!findVisible) return;
    runFind(true, false);
  }, [findVisible, runFind]);

  useEffect(() => {
    if (activePdfUrl) return;
    if (!activeWebview || !readyGuestsRef.current.has(activeWebview)) {
      setZoomFactor(1);
      return;
    }
    try {
      const factor = activeWebview.getZoomFactor?.();
      setZoomFactor(typeof factor === 'number' && Number.isFinite(factor) ? factor : 1);
    } catch {
      // A guest may be detached while React is switching or remounting tabs.
      setZoomFactor(1);
    }
  }, [activePdfUrl, activeTabTargetId, activeWebview, readyTargets]);

  const annotationElement = inspected ?? regions[regions.length - 1]?.elements?.[0] ?? null;
  const stageWidth = stageRef.current?.clientWidth || 520;
  const stageHeight = stageRef.current?.clientHeight || 400;
  const lastRegion = regions[regions.length - 1];
  const lastStroke = strokes[strokes.length - 1];
  const strokeXs = lastStroke?.points.map(point => point.x) ?? [];
  const strokeYs = lastStroke?.points.map(point => point.y) ?? [];
  const annotationAnchor = inspected
    ? inspected.rect
    : lastRegion
      ? {
          x: lastRegion.x * stageWidth,
          y: lastRegion.y * stageHeight,
          width: lastRegion.width * stageWidth,
          height: lastRegion.height * stageHeight,
        }
      : strokeXs.length && strokeYs.length
        ? {
            x: Math.min(...strokeXs) * stageWidth,
            y: Math.min(...strokeYs) * stageHeight,
            width: (Math.max(...strokeXs) - Math.min(...strokeXs)) * stageWidth,
            height: (Math.max(...strokeYs) - Math.min(...strokeYs)) * stageHeight,
          }
        : { x: stageWidth / 2, y: stageHeight / 2, width: 0, height: 0 };
  const annotationComposerWidth = Math.min(560, Math.max(280, stageWidth - 16));
  const annotationAnchorCenter = annotationAnchor.x + annotationAnchor.width / 2;
  const annotationComposerLeft = Math.min(
    Math.max(8, annotationAnchorCenter - annotationComposerWidth / 2),
    Math.max(8, stageWidth - annotationComposerWidth - 8),
  );
  const annotationComposerBelowTop = annotationAnchor.y + annotationAnchor.height + 10;
  const annotationComposerPlacement =
    annotationComposerBelowTop + 48 <= stageHeight - 8 ? 'below' : 'above';
  const annotationComposerTop =
    annotationComposerPlacement === 'below'
      ? annotationComposerBelowTop
      : Math.max(8, annotationAnchor.y - 58);
  const annotationComposerAnchorOffset = Math.min(
    annotationComposerWidth - 18,
    Math.max(18, annotationAnchorCenter - annotationComposerLeft),
  );
  const inspectorElement =
    mode === 'inspect' && !isCommentComposerOpen ? (inspected ?? hovered) : null;
  const inspectActionLabel = i18nService.t(
    mode === 'inspect' ? 'browserPanelCancelInspect' : 'browserPanelInspect',
  );
  const annotationActionLabel = i18nService.t(
    mode === annotationTool
      ? annotationTool === 'pen'
        ? 'browserPanelCancelPen'
        : 'browserPanelCancelRectangle'
      : annotationTool === 'pen'
        ? 'browserPanelPen'
        : 'browserPanelRectangle',
  );
  const menuTab = tabMenu
    ? (tabs.find(candidate => candidate.targetId === tabMenu.targetId) ?? null)
    : null;
  const menuTabIndex = menuTab
    ? tabs.findIndex(candidate => candidate.targetId === menuTab.targetId)
    : -1;
  const inspectorCardStyle: React.CSSProperties = inspectorElement
    ? {
        ...(inspectorElement.rect.x > (stageRef.current?.clientWidth ?? 0) * 0.55
          ? { right: 8 }
          : { left: 8 }),
        top: Math.min(
          Math.max(8, inspectorElement.rect.y + inspectorElement.rect.height + 8),
          Math.max(8, (stageRef.current?.clientHeight ?? 320) - 304),
        ),
      }
    : {};

  return (
    <aside
      ref={panelRef}
      className={`${isOpen ? 'flex' : 'hidden'} flex-col bg-surface ${
        embedded
          ? 'absolute inset-0 min-h-0 min-w-0'
          : 'absolute inset-y-0 right-0 z-50 w-[min(var(--browser-panel-width),calc(100vw-32px))] max-w-[calc(100%-2rem)] border-l border-border shadow-xl min-[900px]:relative min-[900px]:inset-auto min-[900px]:z-auto min-[900px]:min-w-[320px] min-[900px]:max-w-[760px] min-[900px]:shrink-0 min-[900px]:shadow-none'
      }`}
      style={
        {
          display: isOpen ? 'flex' : 'none',
          ...(embedded ? {} : { '--browser-panel-width': `${width}px` }),
        } as React.CSSProperties
      }
      aria-label={i18nService.t('browserPanelTitle')}
      aria-hidden={!isOpen}
      tabIndex={-1}
      onKeyDownCapture={event => {
        if (
          event.target instanceof Element &&
          event.target.closest('[data-browser-http-auth-dialog], [data-browser-intervention]')
        )
          return;
        if (agentInteractionLocked || interventionBlocked) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        const shortcuts = {
          ...defaultConfig.shortcuts!,
          ...(configService.getConfig().shortcuts ?? {}),
        };
        const shortcutAction = event.repeat
          ? null
          : resolveBrowserPanelShortcutAction(event.nativeEvent, {
              terminal: shortcuts.terminal,
              browser: shortcuts.browser,
              'side-chat': shortcuts.sideChat,
              files: shortcuts.files,
            });
        if (shortcutAction) {
          event.preventDefault();
          event.stopPropagation();
          window.dispatchEvent(new CustomEvent(`cowork:shortcut:${shortcutAction}`));
          return;
        }
        const command = resolveBrowserGuestShortcut({
          type: 'keyDown',
          key: event.key,
          control: event.ctrlKey,
          meta: event.metaKey,
          alt: event.altKey,
          shift: event.shiftKey,
        });
        if (!command) return;
        event.preventDefault();
        runBrowserCommand(command);
      }}
    >
      {(agentInteractionLocked || interventionBlocked) && (
        <div
          className="absolute inset-0 z-[100] cursor-wait"
          aria-label={i18nService.t('browserPanelAgentControlling')}
          data-testid="browser-agent-interaction-lock"
        />
      )}
      {!embedded && (
        <div
          className="absolute inset-y-0 left-0 z-30 hidden w-5 -translate-x-1/2 touch-none cursor-col-resize min-[900px]:block"
          onPointerDown={beginResize}
          onKeyDown={event => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
            event.preventDefault();
            onWidthChange(
              Math.max(
                BROWSER_PANEL_MIN_WIDTH,
                Math.min(
                  getBrowserPanelMaxWidth(panelRef.current?.parentElement?.clientWidth),
                  width + (event.key === 'ArrowLeft' ? 20 : -20),
                ),
              ),
            );
          }}
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label={i18nService.t('browserPanelResize')}
          aria-valuemin={BROWSER_PANEL_MIN_WIDTH}
          aria-valuemax={getBrowserPanelMaxWidth(panelRef.current?.parentElement?.clientWidth)}
          aria-valuenow={width}
        />
      )}
      {!embedded && (
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
          <div
            className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
            role="tablist"
            aria-label={i18nService.t('browserPanelTabs')}
          >
            {tabs.map(tab => (
              <div
                key={tab.id}
                data-browser-tab-id={tab.targetId}
                className={`group flex max-w-44 shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs ${tab.targetId === activeTab?.targetId ? 'bg-primary-muted text-primary' : 'bg-surface-raised text-secondary'}`}
                onContextMenu={event => {
                  event.preventDefault();
                  setTabMenu({ targetId: tab.targetId, x: event.clientX, y: event.clientY });
                }}
              >
                {tab.faviconUrl ? (
                  <img
                    src={tab.faviconUrl}
                    alt=""
                    className="h-4 w-4 shrink-0 rounded-sm object-contain"
                    onError={() => updateTab(tab.targetId, { faviconUrl: undefined })}
                  />
                ) : (
                  <GlobeAltIcon className="h-4 w-4 shrink-0 opacity-60" aria-hidden="true" />
                )}
                {renamingTargetId === tab.targetId ? (
                  <input
                    autoFocus
                    value={renameDraft}
                    className="min-w-0 flex-1 rounded border border-primary bg-background px-1 py-0.5 text-xs text-foreground outline-none"
                    aria-label={i18nService.t('browserTabMenuRenameInput')}
                    onChange={event => setRenameDraft(event.target.value)}
                    onBlur={() => commitTabRename(tab.targetId)}
                    onClick={event => event.stopPropagation()}
                    onKeyDown={event => {
                      if (event.key === 'Enter') commitTabRename(tab.targetId);
                      if (event.key === 'Escape') {
                        setRenamingTargetId(null);
                        setRenameDraft('');
                      }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab.targetId === activeTab?.targetId}
                    onClick={() => {
                      onActiveTargetChange(tab.targetId);
                      activeTargetRef.current = tab.targetId;
                      setUrlDraft(getBrowserTabAddress(tab));
                      clearAnnotations();
                      setTimeout(() => webviewsRef.current.get(tab.targetId)?.focus(), 0);
                    }}
                    className="min-w-0 flex-1 truncate text-left"
                    title={getBrowserTabDisplayTitle(tab)}
                  >
                    {getBrowserTabDisplayTitle(tab)}
                  </button>
                )}
                <Tooltip
                  content={i18nService.t('browserPanelCloseTab')}
                  position="bottom"
                  renderInPortal
                  dismissOnClick
                >
                  <button
                    type="button"
                    className="rounded p-0.5 opacity-0 hover:bg-surface group-hover:opacity-100"
                    onClick={() => closeTab(tab.targetId)}
                    aria-label={i18nService.t('browserPanelCloseTab')}
                  >
                    <XMarkIcon className="h-3 w-3" />
                  </button>
                </Tooltip>
              </div>
            ))}
          </div>
          <Tooltip
            content={i18nService.t('browserPanelNewTab')}
            position="bottom"
            renderInPortal
            dismissOnClick
          >
            <button
              type="button"
              className={modeButton(false)}
              disabled={tabs.length >= 8}
              onClick={() => openTab()}
              aria-label={i18nService.t('browserPanelNewTab')}
            >
              <PlusIcon className="h-4 w-4" />
            </button>
          </Tooltip>
          <Tooltip
            content={i18nService.t('browserPanelClose')}
            position="bottom"
            renderInPortal
            dismissOnClick
          >
            <button
              type="button"
              className={modeButton(false)}
              onClick={onClose}
              aria-label={i18nService.t('browserPanelClose')}
            >
              <XMarkIcon className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>
      )}

      {embedded && renamingTargetId && (
        <form
          className="flex shrink-0 items-center border-b border-border bg-surface px-2 py-1.5"
          onSubmit={event => {
            event.preventDefault();
            commitTabRename(renamingTargetId);
          }}
        >
          <input
            autoFocus
            value={renameDraft}
            className="min-w-0 flex-1 rounded-md border border-primary bg-background px-2.5 py-1.5 text-xs text-foreground outline-none"
            aria-label={i18nService.t('browserTabMenuRenameInput')}
            onChange={event => setRenameDraft(event.target.value)}
            onBlur={() => commitTabRename(renamingTargetId)}
            onKeyDown={event => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              setRenamingTargetId(null);
              setRenameDraft('');
            }}
          />
        </form>
      )}

      <form
        className="flex h-[35px] shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2"
        onSubmit={event => {
          event.preventDefault();
          void submitUrl();
        }}
      >
        <Tooltip
          content={i18nService.t('browserPanelBack')}
          position="bottom"
          renderInPortal
          dismissOnClick
        >
          <button
            type="button"
            className={modeButton(false)}
            disabled={!canNavigate('back')}
            onClick={() => runBrowserCommand('back')}
            aria-label={i18nService.t('browserPanelBack')}
          >
            <ArrowLeftIcon className="h-4 w-4" />
          </button>
        </Tooltip>
        <Tooltip
          content={i18nService.t('browserPanelForward')}
          position="bottom"
          renderInPortal
          dismissOnClick
        >
          <button
            type="button"
            className={modeButton(false)}
            disabled={!canNavigate('forward')}
            onClick={() => runBrowserCommand('forward')}
            aria-label={i18nService.t('browserPanelForward')}
          >
            <ArrowRightIcon className="h-4 w-4" />
          </button>
        </Tooltip>
        <Tooltip
          content={i18nService.t('browserPanelReload')}
          position="bottom"
          renderInPortal
          dismissOnClick
        >
          <button
            type="button"
            className={modeButton(false)}
            disabled={!activeTab || (!activePdfUrl && !readyTargets.has(activeTab.targetId))}
            onClick={() => runBrowserCommand('reload')}
            aria-label={i18nService.t('browserPanelReload')}
          >
            <ArrowPathIcon className="h-4 w-4" />
          </button>
        </Tooltip>
        <input
          ref={addressInputRef}
          value={urlDraft}
          onChange={event => {
            addressDirtyRef.current = true;
            setUrlDraft(event.target.value);
          }}
          className="min-w-28 flex-1 rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-primary"
          aria-label={i18nService.t('browserPanelAddress')}
          placeholder={i18nService.t('browserPanelAddressPlaceholder')}
        />
        <BrowserRecordingControls
          recorder={recorder}
          disabled={
            !activeTab ||
            !readyTargets.has(activeTab.targetId) ||
            !/^https?:/.test(activeTab.url) ||
            !!detectedPdfUrl ||
            mode !== 'interact' ||
            isCommentComposerOpen ||
            isCapturing ||
            agentInteractionLocked
          }
        />
        <div
          className={`ml-1 flex shrink-0 items-center gap-0.5 rounded-lg border border-border/70 bg-surface-raised/60 p-0.5 ${isRecording ? 'pointer-events-none opacity-40' : ''}`}
          data-testid="browser-annotation-tool-group"
        >
          <Tooltip content={inspectActionLabel} position="bottom" renderInPortal dismissOnClick>
            <button
              type="button"
              className={modeButton(mode === 'inspect')}
              disabled={Boolean(activePdfUrl)}
              title={activePdfUrl ? i18nService.t('browserPdfActionUnavailable') : undefined}
              onClick={() => toggleAnnotationMode('inspect')}
              aria-label={inspectActionLabel}
              aria-pressed={mode === 'inspect'}
            >
              <span className="relative inline-flex h-5 w-5 items-center justify-center">
                <ChatBubbleOvalLeftIcon className="h-5 w-5" />
                <PlusIcon
                  data-testid="browser-inspect-plus"
                  className="pointer-events-none absolute left-1/2 top-[43%] h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2"
                  strokeWidth={3}
                />
              </span>
            </button>
          </Tooltip>
          <div className="relative h-8 w-8 shrink-0">
            <Tooltip
              content={annotationActionLabel}
              position="bottom"
              renderInPortal
              dismissOnClick
            >
              <button
                type="button"
                className={modeButton(mode === annotationTool)}
                disabled={Boolean(activePdfUrl)}
                title={activePdfUrl ? i18nService.t('browserPdfActionUnavailable') : undefined}
                onClick={() => toggleAnnotationMode(annotationTool)}
                aria-label={annotationActionLabel}
                aria-pressed={mode === annotationTool}
              >
                {annotationTool === 'pen' ? (
                  <PencilIcon className="h-4 w-4" />
                ) : (
                  <RectangleGroupIcon className="h-4 w-4" />
                )}
              </button>
            </Tooltip>
            <button
              type="button"
              className="absolute bottom-0 right-0 z-10 flex h-4 w-4 items-end justify-end p-0.5 text-secondary/80 hover:text-foreground"
              aria-label={i18nService.t('browserAnnotationToolSwitch')}
              disabled={Boolean(activePdfUrl)}
              title={i18nService.t('browserAnnotationToolSwitch')}
              aria-haspopup="menu"
              aria-expanded={annotationToolMenuAnchor !== null}
              onClick={event => {
                const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
                if (!bounds) return;
                setAnnotationToolMenuAnchor(current =>
                  current
                    ? null
                    : {
                        left: bounds.left,
                        right: bounds.right,
                        top: bounds.top,
                        bottom: bounds.bottom,
                      },
                );
              }}
            >
              <ChevronDownIcon className="h-2.5 w-2.5 stroke-2" />
            </button>
          </div>
          <Tooltip
            content={i18nService.t('browserPanelUndo')}
            position="bottom"
            renderInPortal
            dismissOnClick
          >
            <button
              type="button"
              className={modeButton(false)}
              disabled={!strokes.length && !regions.length}
              onClick={() => {
                const latest = annotationOrderRef.current.pop();
                if (latest === 'stroke') setStrokes(current => current.slice(0, -1));
                else if (latest === 'region') setRegions(current => current.slice(0, -1));
              }}
              aria-label={i18nService.t('browserPanelUndo')}
            >
              ↶
            </button>
          </Tooltip>
          <Tooltip
            content={i18nService.t('browserPanelClear')}
            position="bottom"
            renderInPortal
            dismissOnClick
          >
            <button
              type="button"
              className={modeButton(false)}
              onClick={clearAnnotations}
              aria-label={i18nService.t('browserPanelClear')}
            >
              <TrashIcon className="h-4 w-4" />
            </button>
          </Tooltip>
        </div>
        {browserMode === BrowserMode.Embedded &&
          onStopTask &&
          onContinueTask &&
          !draftKey.startsWith('temp-') && (
            <BrowserInterventionBar
              reference={{
                sessionId: draftKey,
                targetId: activeTab?.targetId ?? BROWSER_AGENT_PANEL_TARGET_ID,
                profile: activeTab?.profile ?? 'embedded',
              }}
              buttonClassName={modeButton(false)}
              detailsHost={interventionDetailsHost}
              active={isOpen}
              browserOperationRunning={
                browserOperationRunning &&
                Boolean(activeTab?.url.trim() && activeTab.url !== 'about:blank')
              }
              onStop={onStopTask}
              onCheckStopped={onCheckTaskStopped}
              onContinue={onContinueTask}
              onBlockedChange={setInterventionBlocked}
            />
          )}
        <Tooltip
          content={i18nService.t('browserMenuOpen')}
          position="bottom"
          renderInPortal
          dismissOnClick
        >
          <button
            type="button"
            className={modeButton(overflowMenuAnchor !== null)}
            aria-label={i18nService.t('browserMenuOpen')}
            aria-haspopup="menu"
            aria-expanded={overflowMenuAnchor !== null}
            onClick={event => {
              const bounds = event.currentTarget.getBoundingClientRect();
              setOverflowMenuAnchor(current =>
                current
                  ? null
                  : {
                      left: bounds.left,
                      right: bounds.right,
                      top: bounds.top,
                      bottom: bounds.bottom,
                    },
              );
            }}
          >
            <EllipsisVerticalIcon className="h-5 w-5" />
          </button>
        </Tooltip>
      </form>

      {findVisible && (
        <form
          className="flex shrink-0 items-center gap-1.5 border-b border-border bg-surface px-2 py-1.5"
          onSubmit={event => {
            event.preventDefault();
            runFind(true, true);
          }}
        >
          <MagnifyingGlassIcon className="h-4 w-4 shrink-0 text-secondary" aria-hidden="true" />
          <input
            ref={findInputRef}
            value={findQuery}
            className="min-w-0 flex-1 rounded-md border border-border bg-surface-raised px-2 py-1 text-xs text-foreground outline-none focus:border-primary"
            aria-label={i18nService.t('browserMenuFind')}
            placeholder={i18nService.t('browserMenuFindPlaceholder')}
            onChange={event => setFindQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape') {
                event.preventDefault();
                closeFind();
              }
            }}
          />
          <span className="min-w-10 text-center text-[11px] tabular-nums text-secondary">
            {findQuery && findResult ? `${findResult.active}/${findResult.matches}` : '—'}
          </span>
          <button
            type="button"
            className={modeButton(false)}
            disabled={!findQuery.trim()}
            aria-label={i18nService.t('browserMenuFindPrevious')}
            onClick={() => runFind(false, true)}
          >
            <ChevronDownIcon className="h-4 w-4 rotate-180" />
          </button>
          <button
            type="button"
            className={modeButton(false)}
            disabled={!findQuery.trim()}
            aria-label={i18nService.t('browserMenuFindNext')}
            onClick={() => runFind(true, true)}
          >
            <ChevronDownIcon className="h-4 w-4" />
          </button>
          <button
            type="button"
            className={modeButton(false)}
            aria-label={i18nService.t('browserMenuFindClose')}
            onClick={closeFind}
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </form>
      )}

      {visibleError && (
        <div
          role="alert"
          className="border-b border-border bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400"
        >
          {visibleError}
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="flex items-start gap-2 border-b border-border bg-primary-muted py-1.5 pl-3 pr-1.5 text-xs text-primary"
        >
          <span className="min-w-0 flex-1 py-0.5 leading-5">{notice}</span>
          <button
            type="button"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-primary/70 hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            aria-label={i18nService.t('browserPanelDismissNotice')}
            onClick={() => {
              annotationNoticeTargetRef.current = null;
              annotationNoticeTextRef.current = null;
              setNotice(null);
            }}
          >
            <XMarkIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {credentialOfferTargetId === activeTab?.targetId && (
        <div className="flex items-center gap-2 border-b border-border bg-surface-raised px-3 py-2 text-xs">
          <span className="min-w-0 flex-1 text-secondary">
            {i18nService.t('browserCredentialOffer')}
          </span>
          <button
            type="button"
            className="rounded-md bg-primary px-2.5 py-1 font-medium text-white hover:brightness-105"
            onClick={() => {
              activeWebview?.send(BROWSER_GUEST_CREDENTIALS_FILL_CHANNEL);
              setCredentialOfferTargetId(null);
            }}
          >
            {i18nService.t('browserCredentialFill')}
          </button>
          <button
            type="button"
            className="rounded p-1 text-secondary hover:bg-surface hover:text-foreground"
            aria-label={i18nService.t('browserCredentialDismiss')}
            onClick={() => setCredentialOfferTargetId(null)}
          >
            <XMarkIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="relative min-h-0 flex-1 overflow-hidden bg-neutral-950/5 p-2">
        <div
          ref={stageRef}
          className="relative h-full w-full overflow-hidden rounded border border-border bg-white"
        >
          <div
            ref={setInterventionDetailsHost}
            className="pointer-events-none absolute inset-0 z-[110]"
          />
          {tabs.map(tab => (
            <webview
              key={`${tab.targetId}:${BROWSER_WEBVIEW_CAPABILITY_VERSION}`}
              ref={getGuestElementRef(tab.targetId)}
              src={initialUrlsRef.current.get(tab.targetId) || 'about:blank'}
              partition={browserPartitionForProfile(tab.profile ?? 'embedded')}
              // React 18 drops a bare boolean for unknown/custom-element attributes.
              // Electron types this as boolean, but the DOM must receive the literal attribute.
              allowpopups={'true' as unknown as boolean}
              plugins={'true' as unknown as boolean}
              className={`absolute inset-0 h-full w-full ${tab.targetId === activeTab?.targetId ? 'visible' : 'invisible'}`}
              style={{
                visibility: isOpen && tab.targetId === activeTab?.targetId ? 'visible' : 'hidden',
              }}
            />
          ))}
          {tabs
            .filter(
              tab =>
                compatibilityPdfUrls.get(tab.targetId) === tab.url &&
                nonPdfUrls.get(tab.targetId) !== tab.url &&
                (tab.pdfUrl === tab.url || isLikelyPdfUrl(tab.url)),
            )
            .map(tab => (
              <div
                key={`${tab.targetId}:${tab.url}`}
                className="absolute inset-0 z-[4]"
                style={{
                  visibility: isOpen && tab.targetId === activeTab?.targetId ? 'visible' : 'hidden',
                }}
                aria-hidden={!isOpen || tab.targetId !== activeTab?.targetId}
              >
                <Suspense
                  fallback={
                    <div className="absolute inset-0 z-[4] flex items-center justify-center bg-neutral-200 text-sm text-secondary dark:bg-neutral-800">
                      {i18nService.t('browserPdfLoading')}
                    </div>
                  }
                >
                  <BrowserPdfViewer
                    ref={viewer => {
                      if (viewer) pdfViewersRef.current.set(tab.targetId, viewer);
                      else pdfViewersRef.current.delete(tab.targetId);
                    }}
                    url={tab.url}
                    profile={tab.profile ?? 'embedded'}
                    active={isOpen && tab.targetId === activeTab?.targetId}
                    onNotPdf={() =>
                      setNonPdfUrls(current => new Map(current).set(tab.targetId, tab.url))
                    }
                    onZoomChange={factor => {
                      pdfZoomFactorsRef.current.set(tab.targetId, factor);
                      if (activeTargetRef.current === tab.targetId) setZoomFactor(factor);
                    }}
                  />
                </Suspense>
              </div>
            ))}
          {activeTab?.url === 'about:blank' && (
            <button
              type="button"
              className="absolute inset-0 z-[5] flex cursor-default items-center justify-center bg-background text-foreground"
              aria-label={i18nService.t('browserPanelEmptyFocusAddress')}
              onClick={() => addressInputRef.current?.focus()}
            >
              <span className="flex -translate-y-2 flex-col items-center gap-2 text-center">
                <GlobeAltIcon
                  className="h-8 w-8 text-secondary/80"
                  strokeWidth={1.5}
                  aria-hidden="true"
                />
                <span className="text-sm font-semibold">
                  {i18nService.t('browserPanelEmptyTitle')}
                </span>
                <span className="text-xs text-secondary">
                  {i18nService.t('browserPanelEmptyDescription')}
                </span>
              </span>
            </button>
          )}
          {mode !== 'interact' && !activePdfUrl && (
            <canvas
              ref={canvasRef}
              tabIndex={0}
              aria-label={i18nService.t('browserPanelViewport')}
              className={`absolute inset-0 z-10 h-full w-full touch-none ${mode === 'inspect' ? 'browser-element-annotation-cursor' : 'cursor-cell'}`}
              onClick={handleCanvasClick}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            />
          )}
          {inspectorElement && (
            <BrowserElementInspectorCard
              element={inspectorElement}
              locked={inspected !== null}
              style={inspectorCardStyle}
            />
          )}
          {isCommentComposerOpen && (strokes.length || regions.length || inspected) && (
            <BrowserAnnotationComposer
              element={annotationElement}
              value={commentDraft}
              disabled={isCapturing}
              position={{
                left: annotationComposerLeft,
                top: annotationComposerTop,
                width: annotationComposerWidth,
              }}
              placement={annotationComposerPlacement}
              anchorOffset={annotationComposerAnchorOffset}
              onChange={setCommentDraft}
              onSubmit={() => void addAnnotation()}
              onDismiss={() => setIsCommentComposerOpen(false)}
            />
          )}
          {loading && (
            <div className="pointer-events-none absolute left-0 right-0 top-0 z-30 h-0.5 overflow-hidden bg-primary/20">
              <div className="h-full w-1/2 animate-pulse bg-primary" />
            </div>
          )}
        </div>
      </div>
      {tabMenu && menuTab && (
        <BrowserTabContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          muted={Boolean(menuTab.muted)}
          copyAddressLabel={
            isAtSourcePreview(menuTab) ? i18nService.t('browserTabMenuCopyFilePath') : undefined
          }
          canCloseOthers={tabMenu.closeActions?.canCloseOthers ?? tabs.length > 1}
          canCloseRight={
            tabMenu.closeActions?.canCloseRight ??
            (menuTabIndex >= 0 && menuTabIndex < tabs.length - 1)
          }
          onAction={action => void handleTabMenuAction(action)}
          onDismiss={() => setTabMenu(null)}
          onRestoreFocus={tabMenu.closeActions?.restoreFocus}
        />
      )}
      {annotationToolMenuAnchor && (
        <BrowserAnnotationToolMenu
          anchor={annotationToolMenuAnchor}
          selected={annotationTool}
          onSelect={tool => {
            setAnnotationTool(tool);
            setMode(tool);
            setAnnotationToolMenuAnchor(null);
          }}
          onDismiss={() => setAnnotationToolMenuAnchor(null)}
        />
      )}
      {overflowMenuAnchor && (
        <BrowserOverflowMenu
          anchor={overflowMenuAnchor}
          zoomFactor={zoomFactor}
          pdfCompatibilityMode={detectedPdfUrl ? Boolean(activePdfUrl) : undefined}
          disabledActions={
            activePdfUrl
              ? ['find', 'print', 'screenshot', 'device-tools']
              : detectedPdfUrl
                ? ['print']
                : []
          }
          disabledActionHint={activePdfUrl ? undefined : i18nService.t('browserPdfUseToolbar')}
          onAction={action => void handleOverflowAction(action)}
          onZoomChange={changeZoom}
          onDismiss={() => setOverflowMenuAnchor(null)}
        />
      )}
      {isImportModalOpen && (
        <BrowserDataImportModal
          onClose={() => setIsImportModalOpen(false)}
          onImport={async selection => {
            const result = await window.electron.browser.importData({
              ...selection,
              approved: true,
            });
            if (result.success && result.imported) {
              const summary = i18nService
                .t('browserImportComplete')
                .replace('{passwords}', String(result.imported.passwords))
                .replace('{cookies}', String(result.imported.cookies))
                .replace('{history}', String(result.imported.history));
              const skippedCookies = result.skippedAppBound?.cookies ?? 0;
              const skippedPasswords = result.skippedAppBound?.passwords ?? 0;
              const details = [
                result.imported.cookies === 0 && skippedCookies > 0
                  ? i18nService.t('browserImportLoginStateNotTransferred')
                  : '',
                skippedCookies
                  ? i18nService
                      .t('browserImportAppBoundCookiesSkipped')
                      .replace('{count}', String(skippedCookies))
                  : '',
                skippedPasswords
                  ? i18nService
                      .t('browserImportAppBoundPasswordsSkipped')
                      .replace('{count}', String(skippedPasswords))
                  : '',
              ].filter(Boolean);
              setNotice([summary, ...details].join(' '));
              if (
                result.imported.cookies > 0 &&
                activeWebview &&
                readyGuestsRef.current.has(activeWebview)
              ) {
                try {
                  activeWebview.reload();
                } catch {
                  // A later navigation will still use the imported persistent cookies.
                }
              }
            }
            return result;
          }}
        />
      )}
      {isClearDataModalOpen && (
        <BrowserClearDataModal
          onClose={() => setIsClearDataModalOpen(false)}
          onCleared={result => {
            clearAnnotations();
            setNotice(
              i18nService.t(
                result.success ? 'browserClearDataComplete' : 'browserClearDataPartial',
              ),
            );
          }}
        />
      )}
      {isOpen && visibleHttpAuthRequest && (
        <BrowserHttpAuthModal
          key={visibleHttpAuthRequest.id}
          request={visibleHttpAuthRequest}
          onRespond={respondToHttpAuth}
        />
      )}
    </aside>
  );
});

BrowserPanel.displayName = 'BrowserPanel';

export default BrowserPanel;
