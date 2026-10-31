/**
 * <justdo-chat> Lit custom element.
 * Renders OpenClaw-style chat messages in a shadow DOM.
 *
 * Can receive messages either:
 * 1. Directly via properties (messages, stream, etc.)
 * 2. Via a ChatController reference (controller property)
 */
import type { SessionRunTiming } from '@shared/cowork/sessionRun';
import { McpAppEvent } from '@shared/plugins/mcpApps';
import { LocalSpeechModelKind } from '@shared/speech/localSpeechModels';
import { normalizeLocalSpeechSettings } from '@shared/speech/localSpeechSettings';
import { html, LitElement, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { guard } from 'lit/directives/guard.js';
import { repeat } from 'lit/directives/repeat.js';

import type { MessageQuoteHandler } from '@/features/cowork/components/composer/draft/messageQuote';
import type { OpenMessageFileLink } from '@/features/cowork/components/preview/messageFileLinks';
import { subscribeMessagePresentation } from '@/features/plugins/app/messagePresentation';
import {
  renderMessageBlock,
  renderMessageBlockWithTrailingStream,
  renderStreamingGroup,
  shouldRenderGroupAvatarByPrevItem,
  shouldRenderGroupFooterByNextItem,
} from '@/libs/openclaw-chat/components/message/message-render';
import {
  type EditDiffMode,
  renderTerminalTimelineMessage,
  renderTimelineItem,
} from '@/libs/openclaw-chat/components/timeline/active-turn-timeline';
import { renderCompactionDivider } from '@/libs/openclaw-chat/components/timeline/compaction-divider';
import { renderCompletedProcess } from '@/libs/openclaw-chat/components/timeline/completed-process';
import { CompletedProcessMotion } from '@/libs/openclaw-chat/components/timeline/completed-process-motion';
import { materializeDisclosureContents } from '@/libs/openclaw-chat/components/timeline/disclosure-content';
import { historyViewport, type HistoryViewportHandle } from '@/libs/openclaw-chat/components/timeline/history-viewport';
import { ChatScrollController } from '@/libs/openclaw-chat/controllers/chat-scroll-controller';
import { HistoryDisclosureState } from '@/libs/openclaw-chat/controllers/history-disclosure-state';
import { HistoryRenderScheduler } from '@/libs/openclaw-chat/controllers/history-render-scheduler';
import { HistorySearchIndex, type HistorySearchMatch } from '@/libs/openclaw-chat/controllers/history-search-index';
import { MessageDisclosureState } from '@/libs/openclaw-chat/controllers/message-disclosure-state';
import { StreamRenderScheduler } from '@/libs/openclaw-chat/controllers/stream-render-scheduler';
import type { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import {
  nativePendingInputReadFailed,
  nativePendingInputState,
  projectNativePendingInputs,
} from '@/libs/openclaw-chat/gateway/input/chat-pending-inputs';
import {
  traceTimelineDom,
  traceTimelineProjection,
} from '@/libs/openclaw-chat/model/chat-timeline-trace';
import {
  type AssistantTurn,
  type AssistantTurnTiming,
} from '@/libs/openclaw-chat/model/chat-transcript-state';
import { projectPersistedMessagesForActiveTurn } from '@/libs/openclaw-chat/model/history/optimistic-history-tail';
import { planImplementationEntryIds } from '@/libs/openclaw-chat/model/history/transcript-identity';
import { mergePendingUserMessageForDisplay } from '@/libs/openclaw-chat/model/input/optimistic-user-message';
import {
  type ActiveTurnFooter,
  formatActiveTurnDuration,
  formatActiveTurnTimestamp,
  projectActiveTurnFooter,
  resolveActiveTurnModel,
  selectActiveTurnTiming,
  shouldRenderInterruptedTerminalFallback,
} from '@/libs/openclaw-chat/model/timeline/active-turn-footer';
import {
  type ChatMinimapEntry,
  projectChatMinimapEntries,
} from '@/libs/openclaw-chat/model/timeline/chat-minimap';
import { coalesceAdjacentProcessSummaries } from '@/libs/openclaw-chat/model/timeline/coalesce-process-summaries';
import { unfoldProcessItems } from '@/libs/openclaw-chat/model/timeline/completed-process';
import { HistoryProcessIdentity } from '@/libs/openclaw-chat/model/timeline/history-process-identity';
import { PersistedTimelineCache } from '@/libs/openclaw-chat/model/timeline/persisted-timeline-cache';
import {
  createProcessSummarySessionIdentity,
  ProcessSummaryTakeoverSetTracker,
  ProcessSummaryTakeoverTracker,
} from '@/libs/openclaw-chat/model/timeline/process-summary-takeover';
import {
  type PersistedTimelineItem,
  projectPersistedTimeline,
} from '@/libs/openclaw-chat/model/timeline/project-history-timeline';
import {
  type ActiveTurnTimelineItem,
  type ProcessSummaryTimelineItem,
  projectTurnItems,
} from '@/libs/openclaw-chat/model/timeline/project-turn-items';
import type {
  VisibleTimelineItem,
  VisibleTimelineRow,
} from '@/libs/openclaw-chat/model/timeline/timeline-avatar-state';
import {
  PersistedTimelineRenderCache,
  projectIncrementalTimelineView,
} from '@/libs/openclaw-chat/model/timeline/timeline-render-cache';
import {
  isFailedRunMessage,
  readFailedRunMessageModelRef,
  readFailedRunMessageText,
  readFailedRunMessageTimestamp,
  withFailureDetailsForDisplay,
} from '@/libs/openclaw-chat/model/turn/failed-run-message';
import { projectWaitingStatus } from '@/libs/openclaw-chat/model/turn/run-activity';
import { buildChatItems } from '@/libs/openclaw-chat/pipeline/build-chat-items';
import { extractTextCached } from '@/libs/openclaw-chat/pipeline/message-extract';
import {
  isPluginReplyMirror,
  isTeamDiscussionInput,
  isTrustedPeerInput,
} from '@/libs/openclaw-chat/pipeline/message-normalizer';
import type {
  ChatItem,
  GatewayMessage,
  MessageGroup,
  UserMessageHistoryAction,
} from '@/libs/openclaw-chat/types';
import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';
import { isDomHTMLElement } from '@/shared/dom/ownerDocument';

import { readCompleteHistoryMessage } from '../gateway/history/chat-history-protocol';
import { resolveFullToolOutput } from '../model/tools/tool-presentation';
import { chatStyles } from './justdo-chat.styles';
import { renderMessageDiagram } from './markdown/mermaidRenderer';
import { RichMessageControls } from './markdown/rich-message-controls';
import { McpAppAnchor } from './mcp-app/anchor';
import { McpAppView, type McpAppViewContext } from './mcp-app/view';
import { renderChatAvatar } from './message/chat-avatar';
import {
  handleMessageDiagramToggle,
  handleMessageImageClick,
  handleMessageImageContextMenu,
  handleMessageLinkClick,
} from './message/message-content-interactions';
import { revealThinkingContent, ThinkingContentPresentation } from './message/thinking-content';
import { NativeWidgetAnchor } from './native-widget/anchor';
import {
  NATIVE_WIDGET_CONTEXT_REQUEST,
  NATIVE_WIDGET_DRAFT_EVENT,
  type NativeWidgetContext,
} from './native-widget/host';
import { getNativeWidgetPresentations } from './native-widget/presentations';
import { NativeWidgetView } from './native-widget/view';
import type { TerminalErrorMessage } from './timeline/terminal-error-message';
import { EditDiffMonacoController } from './tools/edit-diff-monaco';
import { TOOL_OUTPUT_REQUEST, type ToolOutput } from './tools/tool-output';
import { WebpageEmbedAnchor } from './webpage-embed/anchor';
import { WEBPAGE_EMBED_CONTEXT_REQUEST, type WebpageEmbedContext } from './webpage-embed/context';
import { getWebpageEmbedPresentations } from './webpage-embed/presentations';

const MERMAID_BUBBLE_MIN_WIDTH = 500;
const MERMAID_BUBBLE_MAX_WIDTH = 820;
const MERMAID_BUBBLE_HORIZONTAL_PADDING = 64;
const MINIMAP_VISIBLE_ENTRY_THRESHOLD = 2;
const MINIMAP_RENDER_LIMIT = 250;
const MAX_SPEECH_AUDIO_BASE64_LENGTH = 64 * 1024 * 1024;

interface SearchDomMatch {
  node: Text;
  start: number;
  endNode: Text;
  end: number;
  editDiff?: { host: HTMLElement; lineIndex: number };
}

function openClawEntryId(message: GatewayMessage | undefined): string | null {
  const marker = message?.__openclaw;
  if (marker?.kind === 'pending-send') return null;
  const id = marker && typeof marker.id === 'string' ? marker.id.trim() : '';
  return id || null;
}

function gatewayMessageRunId(message: GatewayMessage | undefined): string | null {
  if (!message) return null;
  const record = message as Record<string, unknown>;
  const metadata =
    record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? (record.metadata as Record<string, unknown>)
      : null;
  const marker = message.__openclaw;
  for (const value of [
    record.runId,
    record.run_id,
    metadata?.runId,
    metadata?.run_id,
    marker?.runId,
    marker?.run_id,
  ]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function latestPersistedUserEntryId(messages: readonly GatewayMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role?.toLowerCase() !== 'user') continue;
    return openClawEntryId(message);
  }
  return null;
}

@customElement('justdo-chat')
export class JustDoChatElement extends LitElement {
  private readonly codeCopyFeedbackTimers = new WeakMap<HTMLButtonElement, number>();

  // ─── Properties ─────────────────────────────────────────────────────────

  /** Direct message input (when not using controller) */
  @property({ type: Array, attribute: false })
  declare messages: GatewayMessage[];

  /** Isolated active turn supplied by standalone consumers such as side chat. */
  @property({ attribute: false })
  declare activeTurn: AssistantTurn | null;

  @property({ type: String, attribute: false })
  declare stream: string | null;

  @property({ type: Number, attribute: false })
  declare streamStartedAt: number | null;

  @property({ type: Boolean, attribute: false })
  declare isStreaming: boolean;

  @property({ type: String, attribute: false })
  declare assistantName: string;

  @property({ attribute: false })
  declare assistantId: string;

  @property({ attribute: false })
  declare peerColors: Readonly<Record<string, string>>;

  private get assistantAvatar(): TemplateResult | undefined {
    return this.peerPerspective && this.assistantName
      ? renderChatAvatar('assistant', {
          id: this.assistantId || `local:${this.assistantName}`,
          label: this.assistantName,
          color: this.peerColors[this.assistantId],
        })
      : undefined;
  }

  /** Display names for trusted inter-session senders, keyed by native agent id. */
  @property({ attribute: false })
  declare peerNames: Readonly<Record<string, string>>;

  /** Show a selected agent on the left and its trusted peer inputs on the right. */
  @property({ type: Boolean, attribute: false })
  declare peerPerspective: boolean;

  @property({ type: String, attribute: false })
  declare workingDirectory: string;

  @property({ attribute: false })
  declare onOpenFile: OpenMessageFileLink | undefined;

  @property({ type: String, attribute: false })
  declare searchQuery: string;

  @property({ type: Boolean, attribute: false })
  declare searchCaseSensitive: boolean;

  @property({ type: Boolean, attribute: false })
  declare processSummariesExpanded: boolean;

  @property({ type: Array, attribute: false })
  declare runTimings: SessionRunTiming[];

  @property({ attribute: false })
  declare onLastUserMessageAction:
    | ((
        action: UserMessageHistoryAction,
        entryId: string,
        editedText?: string,
      ) => boolean | Promise<boolean>)
    | undefined;

  @property({ attribute: false })
  declare onMessageQuote: MessageQuoteHandler | undefined;

  @property({ attribute: false })
  declare canDraftWidget: (() => boolean) | undefined;

  @property({ attribute: false })
  declare openWidgetLink: ((sessionKey: string, url: string) => void) | undefined;

  @property({ attribute: false })
  declare addMcpAppDraft: ((text: string) => Promise<boolean>) | undefined;

  @property({ attribute: false })
  declare addNewMcpAppDraft: ((text: string, content: unknown[]) => Promise<boolean>) | undefined;

  @property({ attribute: false })
  declare openMcpAppFile: McpAppViewContext['openFile'];
  captureMcpAppContext?: () => McpAppViewContext | undefined;
  captureWidgetContext?: () => NativeWidgetContext | undefined;

  @property({ attribute: false })
  declare onAssistantMessageFork: ((entryId: string) => boolean | Promise<boolean>) | undefined;

  @state()
  declare private userMessageEditor: { entryId: string; value: string; submitting: boolean } | null;

  @state()
  declare private openProcessSummaryKey: string | null;

  @state()
  declare private collapsedProcessSummaryKeys: ReadonlySet<string>;

  @state()
  declare private currentMinimapKey: string | null;

  @state()
  declare private hoveredMinimapKey: string | null;

  @state()
  declare private editDiffModes: ReadonlyMap<string, EditDiffMode>;

  @state()
  declare private thinkingViewRevision: number;

  @state()
  declare private localTtsAvailable: boolean;

  @state()
  declare private speechLoadingGroupKey: string | null;

  @state()
  declare private speechPlayingGroupKey: string | null;

  private readonly chatScrollController = new ChatScrollController(
    () => this.syncScrollIndicator(),
    async () => {
      const shifted = await (this._controller?.loadOlderHistory() ?? false);
      await this.historyRenderComplete;
      return shifted;
    },
    undefined,
    () => {
      if (this.scrollbarRenderDeferred) this.requestUpdate();
      for (const viewport of this.historyViewports.values()) viewport.refresh();
    },
  );
  private readonly historyViewports = new Map<string, HistoryViewportHandle>();
  private historyPresentationRows: readonly VisibleTimelineRow[] = [];
  private readonly historyProcessIdentity = new HistoryProcessIdentity();
  private readonly historySearchIndex = new HistorySearchIndex();
  private historyOwnerRevision = 0;
  private readonly thinkingContentPresentation = new ThinkingContentPresentation({
    isFollowing: () => this.chatScrollController.state.mode === 'follow',
    requestUpdate: () => {
      this.thinkingViewRevision += 1;
    },
    preserve: element => {
      this.chatScrollController.preserveAnchorForInteraction(element);
    },
  });
  private scrollbarRenderDeferred = false;
  private scrollbarDeferredProperties = new Map<string | number | symbol, unknown>();
  private scrollbarRenderWaiters: Array<() => void> = [];
  private readonly streamRenderScheduler = new StreamRenderScheduler(
    () => this.publishStreamFrame(),
    () => Date.now(),
    () => this.ownerDocument.defaultView ?? undefined,
  );
  private readonly persistedTimelineCache = new PersistedTimelineCache();
  private projectedActiveHistorySource: GatewayMessage[] | null = null;
  private projectedActiveTurnKey = '';
  private projectedActiveMessages: GatewayMessage[] = [];
  private peerFilteredHistory = new WeakMap<GatewayMessage[], GatewayMessage[]>();
  private peerPerspectiveHistory = new WeakMap<GatewayMessage[], GatewayMessage[]>();
  private persistedRenderRevision = 0;
  private readonly persistedTimelineRenderCache = new PersistedTimelineRenderCache();
  private readonly historyRenderScheduler = new HistoryRenderScheduler<VisibleTimelineRow>(() =>
    this.streamRenderScheduler.schedule(),
  );
  private readonly historyDisclosureState = new HistoryDisclosureState();
  private readonly completedProcessMotion = new CompletedProcessMotion(this);
  private readonly messageDisclosureState = new MessageDisclosureState();
  private renderStartedAt = 0;
  private readonly processSummaryTakeoverTracker = new ProcessSummaryTakeoverTracker();
  private readonly collapsedProcessSummaryTakeoverTracker = new ProcessSummaryTakeoverSetTracker();
  private readonly persistedProcessSummaries = new WeakMap<readonly VisibleTimelineRow[], readonly ProcessSummaryTimelineItem[]>();
  private processResolution: {
    persisted: readonly ProcessSummaryTimelineItem[];
    active: string;
    scope: string;
    open: string | null;
    collapsed: ReadonlySet<string>;
    expanded: boolean;
  } | null = null;
  private readonly editDiffMonacoController = new EditDiffMonacoController();
  private renderedOpenProcessSummaryKey: string | null = null;
  private renderedCollapsedProcessSummaryKeys: ReadonlySet<string> = new Set();
  private focusedProcessSummaryKeyBeforeRender: string | null = null;
  private processSummarySessionIdentity: string | null = null;
  private lastSearchEnhancementKey = '';
  private lastMermaidEnhancementKey = '';
  private lastMinimapSyncKey = '';
  private latestMinimapPrefix: readonly ChatMinimapEntry[] = [];
  private latestMinimapTail: ChatMinimapEntry | null = null;
  private minimapEntriesSignature = '';
  private minimapPreviewTop = 0;
  private outputReadContext: unknown[] = [];
  private messageThemeObserver: MutationObserver | null = null;
  private richMessageControls: RichMessageControls | null = null;
  private mermaidScrollFrame: number | null = null;
  private minimapScrollFrame: number | null = null;
  private editDiffMonacoFrame: number | null = null;
  private activeTurnClockTimer: ReturnType<typeof setInterval> | null = null;
  private actionableUserEntryId: string | null = null;
  private userMessageHistoryActionsAvailable = false;
  private forkEligibilityMessages: GatewayMessage[] = [];
  private actionEligibilitySource: GatewayMessage[] | null = null;
  private actionEligibilityIds: ReadonlySet<string> = new Set();

  constructor() {
    super();
    this.messages = [];
    this.activeTurn = null;
    this.stream = null;
    this.streamStartedAt = null;
    this.isStreaming = false;
    this.assistantName = '';
    this.assistantId = '';
    this.peerColors = {};
    this.peerNames = {};
    this.peerPerspective = false;
    this.workingDirectory = '';
    this.searchQuery = '';
    this.searchCaseSensitive = false;
    this.processSummariesExpanded = false;
    this.runTimings = [];
    this.onLastUserMessageAction = undefined;
    this.onAssistantMessageFork = undefined;
    this.onMessageQuote = undefined;
    this.canDraftWidget = undefined;
    this.openWidgetLink = undefined;
    this.userMessageEditor = null;
    this.openProcessSummaryKey = null;
    this.collapsedProcessSummaryKeys = new Set();
    this.currentMinimapKey = null;
    this.hoveredMinimapKey = null;
    this.editDiffModes = new Map();
    this.thinkingViewRevision = 0;
    this.localTtsAvailable = false;
    this.speechLoadingGroupKey = null;
    this.speechPlayingGroupKey = null;
  }

  /** ChatController reference (preferred — connects directly to gateway) */
  private _controller: ChatController | null = null;
  private _controllerUnsubscribe: (() => void) | null = null;
  private _streamUnsubscribe: (() => void) | null = null;
  private unsubscribeMessagePresentation: (() => void) | null = null;
  private readonly handleMessagePresentationChanged = () => {
    this.peerFilteredHistory = new WeakMap();
    this.peerPerspectiveHistory = new WeakMap();
    this.persistedTimelineCache.clear();
    this.persistedTimelineRenderCache.clear();
    this.historySearchIndex.clear();
    this.persistedRenderRevision++;
    this.requestUpdate();
  };
  private activeSearchIndex = -1;

  get controller(): ChatController | null {
    return this._controller;
  }

  set controller(ctrl: ChatController | null) {
    if (this._controller === ctrl) return;
    this.historyOwnerRevision += 1;
    this.processResolution = null;
    this.processSummarySessionIdentity = null;
    this.stopSpeech();
    this.unsubscribeController();
    this.historyRenderScheduler.clear();
    this.historyProcessIdentity.clear();
    this.historySearchIndex.clear();
    this.historyDisclosureState.reset(null);
    this.completedProcessMotion.reset(null);
    this.messageDisclosureState.reset(null);
    this.thinkingContentPresentation.reset(null);
    this._controller = ctrl;
    this.editDiffModes = new Map();
    if (ctrl) this.subscribeController(ctrl);
    void this.refreshLocalTtsStatus();
    this.requestUpdate();
  }

  /** Resolves after actual commits, including history batches and thumb-drag deferral. */
  public get historyRenderComplete(): Promise<void> {
    return this.updateComplete.then(async () => {
      if (this.scrollbarRenderDeferred) {
        await new Promise<void>(resolve => this.scrollbarRenderWaiters.push(resolve));
      }
      await this.historyRenderScheduler.complete;
    });
  }

  private speechAudio: HTMLAudioElement | null = null;
  private speechObjectUrl: string | null = null;
  private speechRequestGeneration = 0;
  private localTtsStatusGeneration = 0;
  private unsubscribeLocalSpeechModels: (() => void) | null = null;

  private async refreshLocalTtsStatus(): Promise<void> {
    const generation = this.localTtsStatusGeneration + 1;
    this.localTtsStatusGeneration = generation;
    try {
      const settings = normalizeLocalSpeechSettings(configService.getConfig().voice);
      if (!settings.outputEnabled) {
        this.localTtsAvailable = false;
        this.stopSpeech();
        return;
      }
      const status =
        settings.synthesisMode === 'online'
          ? await window.electron.onlineTts.getStatus()
          : await window.electron.localTts.getStatus(settings.ttsModelId);
      if (generation !== this.localTtsStatusGeneration) return;
      this.localTtsAvailable = status.available;
      if (!this.localTtsAvailable) this.stopSpeech();
    } catch {
      if (generation !== this.localTtsStatusGeneration) return;
      this.localTtsAvailable = false;
      this.stopSpeech();
    }
  }

  private readonly handleSpeechConfigUpdated = (): void => {
    void this.refreshLocalTtsStatus();
  };

  private stopSpeech(): void {
    this.speechRequestGeneration += 1;
    if (this.speechAudio) {
      this.speechAudio.onended = null;
      this.speechAudio.onerror = null;
      this.speechAudio.pause();
    }
    this.speechAudio = null;
    if (this.speechObjectUrl) URL.revokeObjectURL(this.speechObjectUrl);
    this.speechObjectUrl = null;
    this.speechLoadingGroupKey = null;
    this.speechPlayingGroupKey = null;
  }

  private readonly handleSpeak = async (groupKey: string, text: string): Promise<void> => {
    if (this.speechLoadingGroupKey === groupKey || this.speechPlayingGroupKey === groupKey) {
      this.stopSpeech();
      return;
    }
    const controller = this._controller;
    if (!controller || !text.trim()) return;

    this.stopSpeech();
    const requestGeneration = this.speechRequestGeneration;
    this.speechLoadingGroupKey = groupKey;
    try {
      const result = await controller.speak(text);
      if (
        requestGeneration !== this.speechRequestGeneration ||
        this.speechLoadingGroupKey !== groupKey
      ) {
        return;
      }
      if (
        typeof result.audioBase64 !== 'string' ||
        !result.audioBase64 ||
        result.audioBase64.length > MAX_SPEECH_AUDIO_BASE64_LENGTH ||
        (result.mimeType !== undefined && !result.mimeType.startsWith('audio/'))
      ) {
        throw new Error('Invalid speech audio response.');
      }
      const bytes = Uint8Array.from(atob(result.audioBase64), char => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType ?? 'audio/wav' }));
      const audio = new Audio(url);
      this.speechAudio = audio;
      this.speechObjectUrl = url;
      this.speechLoadingGroupKey = null;
      this.speechPlayingGroupKey = groupKey;
      audio.onended = () => {
        if (requestGeneration === this.speechRequestGeneration && this.speechAudio === audio) {
          this.stopSpeech();
        }
      };
      audio.onerror = () => {
        if (requestGeneration !== this.speechRequestGeneration || this.speechAudio !== audio) {
          return;
        }
        this.stopSpeech();
        window.dispatchEvent(
          new CustomEvent('app:showToast', { detail: i18nService.t('localTtsPlaybackFailed') }),
        );
      };
      await audio.play();
    } catch {
      if (requestGeneration !== this.speechRequestGeneration) return;
      this.stopSpeech();
      window.dispatchEvent(
        new CustomEvent('app:showToast', { detail: i18nService.t('localTtsPlaybackFailed') }),
      );
    }
  };

  private getSpeechState(groupKey: string): 'idle' | 'loading' | 'playing' {
    if (this.speechLoadingGroupKey === groupKey) return 'loading';
    if (this.speechPlayingGroupKey === groupKey) return 'playing';
    return 'idle';
  }

  // ─── Styles ─────────────────────────────────────────────────────────────

  private get animationWindow(): Window & typeof globalThis {
    return (this.ownerDocument.defaultView ?? window) as Window & typeof globalThis;
  }

  static styles = chatStyles;

  protected createRenderRoot(): HTMLElement | DocumentFragment {
    if (this.ownerDocument === document) return super.createRenderRoot();
    // Constructed stylesheets cannot be adopted by another document. Keep the
    // source registry for nested custom elements and materialize styles locally.
    const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
    for (const sheet of (this.constructor as typeof LitElement).elementStyles) {
      const style = this.ownerDocument.createElement('style');
      style.textContent =
        'cssText' in sheet
          ? sheet.cssText
          : Array.from(sheet.cssRules, rule => rule.cssText).join('\n');
      root.appendChild(style);
    }
    this.renderOptions.renderBefore = root.firstChild;
    return root;
  }

  // ─── Rendering ──────────────────────────────────────────────────────────

  private messagesForPerspective(messages: GatewayMessage[]): GatewayMessage[] {
    if (this.peerPerspective) {
      let projected = this.peerPerspectiveHistory.get(messages);
      if (!projected) {
        // Incoming peer messages can carry the native assistant role. Project
        // their display side before timeline grouping, not only inside bubbles,
        // so they reset the local assistant's consecutive-message avatar slot.
        // A room-owned session also stores public group mirrors, including
        // borrowed-source replies. They are not this member's model execution.
        projected = messages
          .filter(message => !isPluginReplyMirror(message))
          .map(message =>
            isTrustedPeerInput(message) && message.role === 'assistant'
              ? { ...message, role: 'user' }
              : message,
          );
        this.peerPerspectiveHistory.set(messages, projected);
      }
      return projected;
    }
    let projected = this.peerFilteredHistory.get(messages);
    if (!projected) {
      projected = messages.filter(
        message => !isTrustedPeerInput(message) && !isTeamDiscussionInput(message),
      );
      this.peerFilteredHistory.set(messages, projected);
    }
    return projected;
  }

  render(): TemplateResult {
    this.historyPresentationRows = [];
    // Use controller state if available, otherwise use direct properties
    const ctrl = this._controller;
    const sourceActiveTurn = this.activeTurnForDisplay(ctrl);
    const activePersistedMessages = this.messagesForPerspective(
      ctrl ? (ctrl.getLoadedMessages() as GatewayMessage[]) : this.messages,
    );
    const activeTurn = withFailureDetailsForDisplay(sourceActiveTurn, activePersistedMessages);
    let pendingMessage = (ctrl?.state.pendingUserMessage as GatewayMessage | null) ?? null;
    const compactionOwners =
      activeTurn?.items
        .filter(item => item.type === 'compaction')
        .map(item => [item.eventId, item.historyEntryId, item.message?.__openclaw?.id]) ?? [];
    const activeTurnHistoryKey = activeTurn
      ? `${activeTurn.runId}:${activeTurn.status}:${[...activeTurn.toolById.keys()].join(
          ',',
        )}:${pendingMessage === null ? 'settled' : 'pending'}:${JSON.stringify(compactionOwners)}:${JSON.stringify(
          sourceActiveTurn?.items.filter(item => item.type === 'terminal').map(item => item.message),
        )}`
      : 'idle';
    if (
      this.projectedActiveHistorySource !== activePersistedMessages ||
      this.projectedActiveTurnKey !== activeTurnHistoryKey
    ) {
      this.projectedActiveHistorySource = activePersistedMessages;
      this.projectedActiveTurnKey = activeTurnHistoryKey;
      this.projectedActiveMessages = projectPersistedMessagesForActiveTurn(
        activePersistedMessages,
        sourceActiveTurn,
        pendingMessage,
        activeTurn,
      );
    }
    let messages = this.projectedActiveMessages;
    if (ctrl) {
      const pending = projectNativePendingInputs(
        ctrl.state,
        messages,
        ctrl.getLoadedMessages() as GatewayMessage[],
        false,
      );
      messages = pending.messages;
      if (pending.suppressOptimistic) pendingMessage = null;
    }
    const persistedMessages = messages;
    this.forkEligibilityMessages = ctrl
      ? this.messagesForPerspective(ctrl.getLoadedMessages() as GatewayMessage[])
      : persistedMessages;
    if (this.actionEligibilitySource !== this.forkEligibilityMessages) {
      this.actionEligibilitySource = this.forkEligibilityMessages;
      this.actionEligibilityIds = planImplementationEntryIds(this.forkEligibilityMessages);
    }
    const isStreaming = ctrl ? ctrl.state.chatSending : this.isStreaming;
    this.userMessageHistoryActionsAvailable = Boolean(
      ctrl &&
      ctrl.state.connected &&
      !isStreaming &&
      !ctrl.state.chatLoading &&
      !ctrl.state.historyLoadingOlder &&
      !ctrl.state.compactionInFlight &&
      ctrl.state.pendingUserMessage === null,
    );
    this.actionableUserEntryId = this.userMessageHistoryActionsAvailable
      ? latestPersistedUserEntryId(
          this.messagesForPerspective(ctrl!.getLoadedMessages() as GatewayMessage[]),
        )
      : null;

    // Merge the optimistic prompt in turn order during session transitions.
    messages = mergePendingUserMessageForDisplay(messages, pendingMessage);

    const activeProjectionVariant = activeTurn
      ? activeTurn.status === 'running'
        ? `${activeTurn.runId}:running:${[...activeTurn.toolById.keys()].join(',')}`
        : `${activeTurn.runId}:${activeTurn.status}:${activeTurn.items
            .filter(item => item.type === 'content')
            .map(item => item.text)
            .join('\n')}`
      : 'idle';
    const currentRunTiming = this.runTimings[this.runTimings.length - 1] ?? null;
    const processFoldOptions = {
      foldUnresolvedTools: true,
      protectTrailingTurn: Boolean(
        activeTurn || isStreaming || currentRunTiming?.state === 'running',
      ),
    };
    const persistedRunTimings = this.runTimings;
    const runTimingSignature = this.runTimings
      .map(
        timing => `${timing.id}:${timing.rootRunId ?? ''}:${timing.state}:${timing.endedAt ?? ''}`,
      )
      .join('|');
    const getHistoryTimeline = () =>
      this.persistedTimelineCache.get(
        {
          sessionKey: ctrl?.state.sessionKey ?? '',
          sessionId: ctrl?.state.currentSessionId ?? null,
          historyGeneration: ctrl?.state.transcript.historyGeneration ?? 0,
          messages: persistedMessages,
          pendingMessage,
          projectionVariant: activeProjectionVariant,
          runTimingSignature,
        },
        () => this.historyProcessIdentity.reconcile(
          coalesceAdjacentProcessSummaries(projectPersistedTimeline(messages, persistedRunTimings)),
          JSON.stringify([ctrl?.state.sessionKey ?? '', ctrl?.state.currentSessionId ?? null,
            ctrl?.state.transcript.historyGeneration ?? 0, ctrl?.state.client?.generation ?? 0]),
        ),
      );

    if (ctrl || activeTurn) {
      const historyTimeline = getHistoryTimeline();
      const activeTimeline = this.projectActiveTimeline(activeTurn);
      traceTimelineProjection(
        ctrl?.state.sessionKey ?? activeTurn?.sessionKey ?? '',
        historyTimeline,
        activeTimeline,
      );
      const activeFooterTiming = selectActiveTurnTiming(
        ctrl?.getCurrentTurnTiming() ?? null,
        currentRunTiming,
        activeTurn !== null,
      );
      // Run receipts can arrive before Gateway history. Keep their metadata
      // attached to visible content instead of rendering an orphan footer.
      const activeTurnFooter =
        historyTimeline.length > 0 || activeTimeline.length > 0
          ? projectActiveTurnFooter(activeFooterTiming)
          : null;
      const timelineView = projectIncrementalTimelineView({
        persisted: this.persistedTimelineRenderCache.get(historyTimeline, processFoldOptions),
        activeTimeline,
        suppressTrailingAssistantFooter: activeTurnFooter !== null || isStreaming,
        foldSettledTurn:
          activeTurn?.status === 'final' && !isStreaming && currentRunTiming?.state !== 'running',
        foldUnresolvedTools: true,
      });
      const hasVisibleInterruptedTerminal = [
        ...timelineView.persistedRows,
        ...(timelineView.seamRow ? [timelineView.seamRow] : []),
        ...timelineView.activeRows,
      ].some(row => row.item.kind === 'terminal' && row.item.item.status === 'aborted');
      const interruptedTerminalFallback = shouldRenderInterruptedTerminalFallback(
        activeTurnFooter,
        hasVisibleInterruptedTerminal,
      )
        ? ({
            kind: 'terminal',
            key: `terminal:aborted:fallback:${activeTurn?.runId ?? currentRunTiming?.id ?? 'run'}`,
            item: {
              id: `terminal:aborted:fallback:${activeTurn?.runId ?? currentRunTiming?.id ?? 'run'}`,
              runId: activeTurn?.runId ?? currentRunTiming?.rootRunId ?? 'run',
              firstSeq: activeTurn?.lastAgentSeq ?? 0,
              lastSeq: activeTurn?.lastAgentSeq ?? 0,
              startedAt: activeTurnFooter?.completedAt ?? Date.now(),
              updatedAt: activeTurnFooter?.completedAt ?? Date.now(),
              type: 'terminal',
              status: 'aborted',
              message: i18nService.t('coworkRunInterruptedMessage'),
            },
          } satisfies ActiveTurnTimelineItem)
        : null;
      this.resolveOpenProcessSummaryKey(
        timelineView.persistedRows,
        [
          ...(timelineView.seamRow ? [timelineView.seamRow.item] : []),
          ...timelineView.activeRows.map(row => row.item),
        ],
        createProcessSummarySessionIdentity({
          sessionKey: ctrl?.state.sessionKey ?? activeTurn?.sessionKey ?? '',
          sessionId:
            ctrl?.state.currentSessionId ??
            ctrl?.state.transcript.sessionId ??
            activeTurn?.sessionId ??
            null,
          historyGeneration: ctrl?.state.transcript.historyGeneration ?? 0,
        }),
      );
      return html`
        <div class="chat-shell">
          ${this.renderMinimap(
            timelineView.minimapPrefix,
            timelineView.minimapTail,
            timelineView.minimapKeySignature,
          )}
          <div
            class="chat-container"
            role="log"
            aria-busy=${activeTurn?.status === 'running' || isStreaming}
          >
            <div class="sr-only" role="status" aria-live="polite">
              ${activeTurn ? i18nService.t(this.activeTurnStatusKey(activeTurn)) : nothing}
            </div>
            ${
              ctrl && nativePendingInputReadFailed(ctrl.state)
                ? html`<div role="status">${i18nService.t('messagePendingInputReadFailed')}</div>`
                : nothing
            }
            ${this.renderPersistedRows(timelineView.persistedRows)}
            ${
              timelineView.seamRow
                ? this.renderVisibleTimelineItem(
                    timelineView.seamRow.item,
                    timelineView.seamRow.showAvatar,
                    timelineView.seamRow.showFooter,
                  )
                : nothing
            }
            ${repeat(
              timelineView.activeRows,
              row => row.item.key,
              row => this.renderVisibleTimelineItem(row.item, row.showAvatar, row.showFooter),
            )}
            ${
              interruptedTerminalFallback
                ? renderTimelineItem(interruptedTerminalFallback)
                : nothing
            }
            ${
              activeTurnFooter
                ? html`
                    <section
                      class="active-turn chat-group chat-group--assistant chat-group--continuation"
                    >
                      <div class="chat-group__avatar" aria-hidden="true"></div>
                      <footer class="active-turn__footer">
                        ${this.activeTurnFooter(
                          activeTurnFooter,
                          messages,
                          activeFooterTiming,
                          activeTimeline.some(
                            item => item.kind === 'waiting' && item.startedAt !== undefined,
                          ),
                        )}
                      </footer>
                    </section>
                  `
                : nothing
            }
            ${
              ctrl
                ? html`
                    <button
                      type="button"
                      class="new-messages-indicator"
                      data-jump-to-latest
                      hidden
                      aria-label=${i18nService.t('coworkJumpToLatest')}
                      title=${i18nService.t('coworkJumpToLatest')}
                      @click=${() => this._controller?.showLatestHistory()}
                    >
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M6 9l6 6 6-6"></path>
                      </svg>
                    </button>
                  `
                : nothing
            }
          </div>
        </div>
      `;
    }

    // Direct-property mode remains for standalone consumers without a controller.
    const stream = this.stream;

    if (!isStreaming && !stream) {
      const historyTimeline = getHistoryTimeline();
      const visibleRows = this.persistedTimelineRenderCache.get(
        historyTimeline,
        processFoldOptions,
      ).rows;
      const minimapEntries = projectChatMinimapEntries(historyTimeline);
      this.resolveOpenProcessSummaryKey(
        visibleRows,
        [],
        'direct',
      );
      return html`
        <div class="chat-shell">
          ${this.renderMinimap(minimapEntries)}
          <div class="chat-container" role="log">${this.renderPersistedRows(visibleRows)}</div>
        </div>
      `;
    }

    const hasAssistantStream = Boolean(stream && stream.trim().length > 0);
    const shouldRenderWaitingStream = isStreaming && !hasAssistantStream;
    // A pending turn without content is rendered explicitly below. Passing an
    // empty string into buildChatItems would create a second waiting bubble.
    const displayStream = shouldRenderWaitingStream ? null : stream;
    const items = this.buildItems(messages, [], [], displayStream);
    const minimapEntries = projectChatMinimapEntries(getHistoryTimeline(), displayStream);
    // Always render the chat container — never show "No messages"
    return html`
      <div class="chat-shell">
        ${this.renderMinimap(minimapEntries)}
        <div class="chat-container" role="log" aria-busy=${isStreaming}>
          <div class="sr-only" role="status" aria-live="polite">
            ${shouldRenderWaitingStream ? i18nService.t('coworkRunStateStarting') : nothing}
          </div>
          ${this.renderItems(items)}
          ${
            shouldRenderWaitingStream
              ? renderStreamingGroup('', this.streamStartedAt ?? Date.now(), null, {
                  showAvatar: !items.some(
                    item => item.kind === 'group' && item.role === 'assistant',
                  ),
                })
              : nothing
          }
        </div>
      </div>
    `;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.unsubscribeMessagePresentation ??= subscribeMessagePresentation(this.handleMessagePresentationChanged);
    if (this._controller && !this._controllerUnsubscribe)
      this.subscribeController(this._controller);
    this.requestUpdate();
    this.addEventListener(NATIVE_WIDGET_CONTEXT_REQUEST, this.handleWidgetContext);
    this.addEventListener(WEBPAGE_EMBED_CONTEXT_REQUEST, this.handleWebpageEmbedContext);
    this.addEventListener(McpAppEvent.ContextRequest, this.handleMcpAppContext);
    this.addEventListener(TOOL_OUTPUT_REQUEST, this.handleToolOutputRequest);
    this.messageThemeObserver = new MutationObserver(() => {
      this.renderRoot
        .querySelectorAll<HTMLElement>('.mermaid-block')
        .forEach(block => delete block.dataset.mermaidRendered);
      void this.renderMermaidDiagrams();
    });
    this.messageThemeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    this.chatScrollController.connect(this);
    this.renderRoot?.addEventListener('click', this.handleMarkdownClick);
    this.renderRoot?.addEventListener('contextmenu', this.handleInlineImageContextMenu);
    this.renderRoot?.addEventListener('keydown', this.handleTimelineKeyDown);
    this.renderRoot?.addEventListener('toggle', this.handleEditDiffToggle, true);
    this.addEventListener('scroll', this.handleMermaidVisibilityScroll, { passive: true });
    this.addEventListener('scroll', this.handleMinimapScroll, { passive: true });
    window.addEventListener('config-updated', this.handleSpeechConfigUpdated);
    this.unsubscribeLocalSpeechModels =
      window.electron?.localSpeechModels?.onChanged?.(status => {
        if (status.kind === LocalSpeechModelKind.Tts) void this.refreshLocalTtsStatus();
      }) ?? null;
    void this.refreshLocalTtsStatus();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribeMessagePresentation?.();
    this.unsubscribeMessagePresentation = null;
    this.removeEventListener(NATIVE_WIDGET_CONTEXT_REQUEST, this.handleWidgetContext);
    this.removeEventListener(WEBPAGE_EMBED_CONTEXT_REQUEST, this.handleWebpageEmbedContext);
    getWebpageEmbedPresentations(this.ownerDocument).refresh(this);
    getNativeWidgetPresentations(this.ownerDocument).refresh(this);
    this.removeEventListener(McpAppEvent.ContextRequest, this.handleMcpAppContext);
    this.richMessageControls?.dispose();
    this.richMessageControls = null;
    this.removeEventListener(TOOL_OUTPUT_REQUEST, this.handleToolOutputRequest);
    this.messageThemeObserver?.disconnect();
    this.messageThemeObserver = null;
    this.chatScrollController.disconnect();
    this.scrollbarRenderDeferred = false;
    this.scrollbarDeferredProperties.clear();
    for (const resolve of this.scrollbarRenderWaiters.splice(0)) resolve();
    this.streamRenderScheduler.dispose();
    this.persistedTimelineCache.clear();
    this.persistedTimelineRenderCache.clear();
    this.historyRenderScheduler.clear();
    this.historyDisclosureState.reset(null);
    this.completedProcessMotion.reset(null);
    this.messageDisclosureState.reset(null);
    this.thinkingContentPresentation.reset(null);
    this.processSummaryTakeoverTracker.clear();
    this.collapsedProcessSummaryTakeoverTracker.clear();
    this.stopSpeech();
    this.processSummarySessionIdentity = null;
    this.renderedOpenProcessSummaryKey = null;
    this.renderedCollapsedProcessSummaryKeys = new Set();
    this.renderRoot?.removeEventListener('click', this.handleMarkdownClick);
    this.renderRoot?.removeEventListener('contextmenu', this.handleInlineImageContextMenu);
    this.renderRoot?.removeEventListener('keydown', this.handleTimelineKeyDown);
    this.renderRoot?.removeEventListener('toggle', this.handleEditDiffToggle, true);
    this.removeEventListener('scroll', this.handleMermaidVisibilityScroll);
    this.removeEventListener('scroll', this.handleMinimapScroll);
    window.removeEventListener('config-updated', this.handleSpeechConfigUpdated);
    this.unsubscribeLocalSpeechModels?.();
    this.unsubscribeLocalSpeechModels = null;
    if (this.mermaidScrollFrame !== null)
      this.animationWindow.cancelAnimationFrame(this.mermaidScrollFrame);
    this.mermaidScrollFrame = null;
    if (this.minimapScrollFrame !== null)
      this.animationWindow.cancelAnimationFrame(this.minimapScrollFrame);
    this.minimapScrollFrame = null;
    if (this.editDiffMonacoFrame !== null)
      this.animationWindow.cancelAnimationFrame(this.editDiffMonacoFrame);
    this.editDiffMonacoFrame = null;
    this.editDiffMonacoController.dispose();
    this.stopActiveTurnClock();
    this.unsubscribeController();
  }

  protected firstUpdated(): void {
    this.scheduleMinimapSync();
    this.animationWindow.requestAnimationFrame(() => void this.renderMermaidDiagrams());
  }

  protected shouldUpdate(changedProperties: Map<string | number | symbol, unknown>): boolean {
    if (!this.isConnected) return false;
    if (this.chatScrollController.isDraggingScrollbar) {
      this.scrollbarRenderDeferred = true;
      for (const [key, value] of changedProperties) {
        if (!this.scrollbarDeferredProperties.has(key))
          this.scrollbarDeferredProperties.set(key, value);
      }
      return false;
    }
    for (const [key, value] of this.scrollbarDeferredProperties) {
      if (!changedProperties.has(key)) changedProperties.set(key, value);
    }
    this.scrollbarDeferredProperties.clear();
    this.scrollbarRenderDeferred = false;
    return true;
  }

  protected willUpdate(changedProperties: Map<string | number | symbol, unknown>): void {
    this.renderStartedAt = performance.now();
    this.historyDisclosureState.capture(this.renderRoot);
    this.completedProcessMotion.capture(this.renderRoot);
    this.messageDisclosureState.capture(this.renderRoot as ShadowRoot);
    // Native details changes open synchronously; its toggle event is queued.
    // Capture before a stream/page commit can restore an older preference.
    this.renderRoot
      .querySelectorAll<HTMLDetailsElement>('details[data-tool-identity]')
      .forEach(details => this.richMessageControls?.rememberTool(details));
    // Stream/clock ticks only change the live lane. Any presentation property
    // change invalidates the retained history templates, including search/TTS.
    if (
      [...changedProperties.keys()].some(
        key =>
          ![
            'activeTurn',
            'stream',
            'streamStartedAt',
            'isStreaming',
            'currentMinimapKey',
            'hoveredMinimapKey',
            'openProcessSummaryKey',
            'collapsedProcessSummaryKeys',
            'processSummariesExpanded',
          ].includes(String(key)),
      )
    ) {
      this.persistedRenderRevision += 1;
    }
    const focusedKey =
      this.renderRoot?.querySelector<HTMLElement>('[data-process-summary-key]:focus')?.dataset
        .processSummaryKey ?? null;
    this.focusedProcessSummaryKeyBeforeRender =
      focusedKey === this.openProcessSummaryKey ? focusedKey : null;
    if (changedProperties.has('processSummariesExpanded')) {
      this.completedProcessMotion.reset(null);
      this.historyDisclosureState.clear();
      this.openProcessSummaryKey = null;
      this.renderedOpenProcessSummaryKey = null;
      this.collapsedProcessSummaryKeys = new Set();
      this.renderedCollapsedProcessSummaryKeys = new Set();
      this.processSummaryTakeoverTracker.clear();
      this.collapsedProcessSummaryTakeoverTracker.clear();
    }
    this.chatScrollController.beforeRender();
  }

  protected updated(changedProperties?: Map<string | number | symbol, unknown>): void {
    this.syncWidgetContexts();
    traceTimelineDom(this._controller?.state.sessionKey ?? '', this.shadowRoot);
    this.syncActiveTurnClock();
    if (
      this.focusedProcessSummaryKeyBeforeRender !== null &&
      this.focusedProcessSummaryKeyBeforeRender !== this.renderedOpenProcessSummaryKey &&
      this.renderedOpenProcessSummaryKey !== null
    ) {
      Array.from(this.renderRoot.querySelectorAll<HTMLElement>('[data-process-summary-key]'))
        .find(element => element.dataset.processSummaryKey === this.renderedOpenProcessSummaryKey)
        ?.focus({ preventScroll: true });
    }
    this.focusedProcessSummaryKeyBeforeRender = null;
    const transcriptRevision =
      this._controller?.state.transcript.revision ??
      this.messages.length + (this.stream?.length ?? 0) + (this.activeTurn?.lastAgentSeq ?? 0);
    const displayActiveTurn = this.activeTurnForDisplay(this._controller);
    const activeContentDisplaySignature = this.searchQuery.trim()
      ? (displayActiveTurn?.items
          .filter(item => item.type === 'content')
          .map(item => `${item.id}:${item.text.length}`)
          .join('|') ?? '')
      : '';
    this.richMessageControls ??= new RichMessageControls(this.renderRoot as ShadowRoot, element =>
      this.chatScrollController.preserveAnchorForInteraction(element),
    );
    this.richMessageControls.reset(
      this._controller?.state.sessionKey ?? '',
      this.processSummarySessionIdentity ?? '',
    );
    this.richMessageControls.onQuote = this.onMessageQuote;
    this.messageDisclosureState.reset(this.processSummarySessionIdentity ?? 'direct');
    this.messageDisclosureState.restore(this.renderRoot as ShadowRoot);
    this.richMessageControls.sync();
    this.syncReturningProcessSummaries();
    this.completedProcessMotion.afterRender();
    this.chatScrollController.afterRender(transcriptRevision);
    this.syncScrollIndicator();
    this.scheduleEditDiffMonacoSync();
    if (changedProperties?.has('searchQuery') || changedProperties?.has('searchCaseSensitive')) {
      this.activeSearchIndex = -1;
      this.clearSearchMarks();
    }
    const searchEnhancementKey = `${this.searchQuery}:${this.searchCaseSensitive}:${transcriptRevision}:${activeContentDisplaySignature}`;
    if (searchEnhancementKey !== this.lastSearchEnhancementKey) {
      this.lastSearchEnhancementKey = searchEnhancementKey;
      this.animationWindow.requestAnimationFrame(() => this.emitSearchMatchCount());
    }
    const completedContent =
      displayActiveTurn?.items.filter(
        item => item.type === 'content' && item.status !== 'streaming',
      ) ?? [];
    const completedContentKey = completedContent
      .map(item => `${item.id}:${item.lastSeq}`)
      .join('|');
    const outputReadContext = [
      this._controller?.state.client,
      this._controller?.state.hello,
      this._controller?.state.connected,
      this._controller?.state.sessionKey,
      this._controller?.state.currentSessionId,
    ];
    if (outputReadContext.some((value, index) => value !== this.outputReadContext[index])) {
      this.renderRoot
        .querySelectorAll<ToolOutput>('justdo-tool-output')
        .forEach(output => output.cancelLoad());
      this.outputReadContext = outputReadContext;
    }
    const mermaidEnhancementKey = `${this.persistedTimelineCache.revision}:${completedContentKey}`;
    if (mermaidEnhancementKey !== this.lastMermaidEnhancementKey) {
      this.lastMermaidEnhancementKey = mermaidEnhancementKey;
      this.animationWindow.requestAnimationFrame(() => void this.renderMermaidDiagrams());
    }
    const minimapSyncKey = `${this.persistedTimelineCache.revision}:${this.persistedTimelineRenderCache.revision}:${this.minimapEntriesSignature}`;
    if (minimapSyncKey !== this.lastMinimapSyncKey) {
      this.lastMinimapSyncKey = minimapSyncKey;
      this.scheduleMinimapSync();
    }
    this.historyRenderScheduler.afterCommit(performance.now() - this.renderStartedAt);
    for (const resolve of this.scrollbarRenderWaiters.splice(0)) resolve();
  }

  private syncScrollIndicator(): void {
    this.thinkingContentPresentation.syncScrollMode();
    // Layout-dependent scroll state only changes this control, not the transcript.
    const indicator = this.renderRoot?.querySelector<HTMLButtonElement>('[data-jump-to-latest]');
    if (!indicator) return;
    indicator.hidden =
      this.chatScrollController.state.mode !== 'paused' || !this.chatScrollController.canScrollDown;
  }

  private syncActiveTurnClock(): void {
    const isRunning =
      this._controller?.state.runActivity != null ||
      this.runTimings[this.runTimings.length - 1]?.state === 'running' ||
      (this.runTimings.length === 0 &&
        (this._controller?.getCurrentTurnTiming()?.status === 'running' ||
          this.activeTurn?.status === 'running')) ||
      this._controller?.state.compactionInFlight === true;
    if (isRunning && this.activeTurnClockTimer === null) {
      this.activeTurnClockTimer = setInterval(() => this.requestUpdate(), 1_000);
      return;
    }
    if (!isRunning) this.stopActiveTurnClock();
  }

  private stopActiveTurnClock(): void {
    if (this.activeTurnClockTimer === null) return;
    clearInterval(this.activeTurnClockTimer);
    this.activeTurnClockTimer = null;
  }

  private resolveOpenProcessSummaryKey(
    rows: readonly VisibleTimelineRow[],
    activeItems: readonly VisibleTimelineItem[],
    sessionIdentity: string,
  ): void {
    this.completedProcessMotion.reset(JSON.stringify([
      sessionIdentity,
      this._controller?.state.client?.generation ?? 0,
      this.historyOwnerRevision,
    ]));
    let persisted = this.persistedProcessSummaries.get(rows);
    if (!persisted) {
      persisted = unfoldProcessItems(rows.map(row => row.item))
        .filter((item): item is ProcessSummaryTimelineItem => item.kind === 'process-summary');
      this.persistedProcessSummaries.set(rows, persisted);
    }
    const active = unfoldProcessItems(activeItems)
      .filter((item): item is ProcessSummaryTimelineItem => item.kind === 'process-summary');
    const signature = JSON.stringify(active.map(item => [item.key, item.runId,
      item.items.map(process => [process.id, process.lastSeq])]));
    const previous = this.processResolution;
    if (previous?.persisted === persisted && previous.active === signature &&
      previous.scope === sessionIdentity && previous.open === this.openProcessSummaryKey &&
      previous.collapsed === this.collapsedProcessSummaryKeys &&
      previous.expanded === this.processSummariesExpanded) return;
    if (this.processSummarySessionIdentity !== sessionIdentity) {
      this.historyDisclosureState.reset(sessionIdentity);
      this.thinkingContentPresentation.reset(sessionIdentity);
      this.processSummaryTakeoverTracker.clear();
      this.collapsedProcessSummaryTakeoverTracker.clear();
      this.processSummarySessionIdentity = sessionIdentity;
      this.renderedOpenProcessSummaryKey = null;
      this.renderedCollapsedProcessSummaryKeys = new Set();
    } else {
      const sourceItems = [...persisted, ...active];
      this.renderedOpenProcessSummaryKey = this.processSummaryTakeoverTracker.resolve(
        this.openProcessSummaryKey,
        sourceItems,
      );
      let collapsed: ReadonlySet<string> = this.processSummariesExpanded
        ? this.collapsedProcessSummaryTakeoverTracker.resolve(
            this.collapsedProcessSummaryKeys,
            sourceItems,
          )
        : new Set();
      if (
        collapsed.size !== this.renderedCollapsedProcessSummaryKeys.size ||
        [...collapsed].some(key => !this.renderedCollapsedProcessSummaryKeys.has(key))
      ) {
        this.renderedCollapsedProcessSummaryKeys = collapsed;
      }
    }
    // Reconcile while rendering so Lit consumes the derived state in this update.
    this.openProcessSummaryKey = this.renderedOpenProcessSummaryKey;
    if (
      this.collapsedProcessSummaryKeys.size !== this.renderedCollapsedProcessSummaryKeys.size ||
      [...this.collapsedProcessSummaryKeys].some(
        key => !this.renderedCollapsedProcessSummaryKeys.has(key),
      )
    ) {
      this.collapsedProcessSummaryKeys = this.renderedCollapsedProcessSummaryKeys;
    }
    this.processResolution = { persisted, active: signature, scope: sessionIdentity,
      open: this.openProcessSummaryKey, collapsed: this.collapsedProcessSummaryKeys,
      expanded: this.processSummariesExpanded };
  }

  private syncReturningProcessSummaries(): void {
    const returning = this.historyDisclosureState.returningSummaries(
      [...this.renderRoot.querySelectorAll<HTMLElement>('[data-process-summary-key]')]
        .map(element => element.dataset.processSummaryKey!),
    );
    if (!this.processSummariesExpanded && returning.open) {
      this.renderedOpenProcessSummaryKey = returning.open;
      this.openProcessSummaryKey = returning.open;
    }
    if (this.processSummariesExpanded && returning.collapsed.length > 0) {
      const collapsed = new Set([...this.renderedCollapsedProcessSummaryKeys, ...returning.collapsed]);
      this.renderedCollapsedProcessSummaryKeys = collapsed;
      this.collapsedProcessSummaryKeys = collapsed;
    }
  }

  private readonly handleMarkdownClick = (event: Event): void => {
    if (handleMessageImageClick(event)) return;
    if (handleMessageLinkClick(event, this.workingDirectory, this.onOpenFile)) return;
    const element = event.composedPath().find(node => isDomHTMLElement(node)) as
      HTMLElement | undefined;
    const disclosureSummary = element?.closest<HTMLElement>(
      '.completed-process > summary, [data-message-disclosure-owner] details.markdown-disclosure > summary',
    );
    if (disclosureSummary) {
      if (disclosureSummary.parentElement?.matches('.completed-process')) {
        this.completedProcessMotion.cancel(disclosureSummary.parentElement as HTMLDetailsElement);
      }
      this.chatScrollController.preserveAnchorForInteraction(disclosureSummary);
      return;
    }
    const summaryButton = element?.closest<HTMLElement>('[data-process-summary-key]');
    if (summaryButton) {
      const summaryKey = summaryButton.dataset.processSummaryKey ?? null;
      this.chatScrollController.preserveAnchorForInteraction(summaryButton);
      if (this.processSummariesExpanded && summaryKey) {
        const collapsedKeys = new Set(this.renderedCollapsedProcessSummaryKeys);
        if (collapsedKeys.has(summaryKey)) {
          collapsedKeys.delete(summaryKey);
        } else {
          collapsedKeys.add(summaryKey);
        }
        this.collapsedProcessSummaryKeys = collapsedKeys;
        return;
      }
      this.openProcessSummaryKey =
        this.renderedOpenProcessSummaryKey === summaryKey ? null : summaryKey;
      return;
    }
    if (element?.closest('[data-jump-to-latest]')) {
      const latest = this.historyPresentationRows[this.historyPresentationRows.length - 1];
      if (latest) this.historyViewports.get('history')?.reveal(latest.item.key);
      this.chatScrollController.jumpToLatest();
      return;
    }
    const copyTarget = event
      .composedPath()
      .find(node => isDomHTMLElement(node) && node.classList.contains('code-block-copy')) as
      HTMLButtonElement | undefined;
    if (copyTarget) {
      event.preventDefault();
      event.stopPropagation();
      const code = copyTarget.dataset.code;
      if (code === undefined) return;
      void this.copyCodeBlock(copyTarget, code);
      return;
    }

    handleMessageDiagramToggle(event);
  };

  private readonly handleInlineImageContextMenu = handleMessageImageContextMenu;

  private readonly handleTimelineKeyDown = (event: Event): void => {
    const keyboardEvent = event as KeyboardEvent;
    if (keyboardEvent.key === 'Escape' && this.richMessageControls?.close()) {
      keyboardEvent.preventDefault();
      keyboardEvent.stopPropagation();
      return;
    }
    if (keyboardEvent.key !== 'Escape' || !this.openProcessSummaryKey) return;
    keyboardEvent.preventDefault();
    const summaryKey = this.openProcessSummaryKey;
    this.openProcessSummaryKey = null;
    void this.updateComplete.then(() => {
      this.shadowRoot
        ?.querySelector<HTMLElement>(`[data-process-summary-key="${CSS.escape(summaryKey)}"]`)
        ?.focus();
    });
  };

  private readonly handleEditDiffModeChange = (toolId: string, mode: EditDiffMode): void => {
    if (this.editDiffModes.get(toolId) === mode) return;
    const nextModes = new Map(this.editDiffModes);
    nextModes.set(toolId, mode);
    this.editDiffModes = nextModes;
  };

  private readonly handleEditDiffToggle = (event: Event): void => {
    if (isDomHTMLElement(event.target) && event.target.tagName === 'DETAILS') {
      this.richMessageControls?.rememberTool(event.target as HTMLDetailsElement);
      if (!(event.target as HTMLDetailsElement).open)
        event.target
          .querySelectorAll<ToolOutput>('justdo-tool-output')
          .forEach(output => output.cancelLoad());
      else {
        this.handleMermaidVisibilityScroll();
        // Lazy disclosure bodies commit in the target's toggle listener,
        // after this capture listener. Enhance their newly mounted content.
        queueMicrotask(() => {
          if (this.isConnected) this.richMessageControls?.sync();
        });
      }
    }
    this.scheduleEditDiffMonacoSync();
  };

  private scheduleEditDiffMonacoSync(): void {
    if (this.editDiffMonacoFrame !== null) return;
    this.editDiffMonacoFrame = this.animationWindow.requestAnimationFrame(() => {
      this.editDiffMonacoFrame = null;
      void this.editDiffMonacoController.sync(this.renderRoot);
    });
  }

  private readonly handleMermaidVisibilityScroll = (): void => {
    if (this.mermaidScrollFrame !== null) return;
    this.mermaidScrollFrame = this.animationWindow.requestAnimationFrame(() => {
      this.mermaidScrollFrame = null;
      void this.renderMermaidDiagrams();
    });
  };

  private readonly handleToolOutputRequest = (event: Event): void => {
    const detail = (
      event as CustomEvent<{
        runId: string;
        toolCallId: string;
        messageId: string;
        isCurrent: () => boolean;
        complete: (text: string | null) => void;
      }>
    ).detail;
    const controller = this._controller;
    const client = controller?.state.client;
    const sessionKey = controller?.state.sessionKey;
    const sessionId = controller?.state.currentSessionId;
    const hello = controller?.state.hello;
    if (!client || !sessionKey || !controller.state.connected) {
      detail.complete(null);
      return;
    }
    const isCurrent = () =>
      detail.isCurrent() &&
      this._controller === controller &&
      controller.state.client === client &&
      controller.state.connected &&
      controller.state.hello === hello &&
      controller.state.currentSessionId === sessionId &&
      controller.state.sessionKey === sessionKey;
    void (async () => {
      try {
        const message = await readCompleteHistoryMessage(
          client,
          sessionKey,
          detail.messageId,
          isCurrent,
          true,
          sessionId,
        );
        if (isCurrent()) detail.complete(resolveFullToolOutput(message, detail));
      } catch {
        if (isCurrent()) detail.complete(null);
      }
    })();
  };

  private async copyCodeBlock(button: HTMLButtonElement, code: string): Promise<void> {
    try {
      await this.animationWindow.navigator.clipboard.writeText(code);
      const activeTimer = this.codeCopyFeedbackTimers.get(button);
      if (activeTimer !== undefined) window.clearTimeout(activeTimer);
      const copiedLabel = i18nService.t('copied');
      const copyLabel = i18nService.t('copyToClipboard');
      button.classList.add('copied');
      button.setAttribute('aria-label', copiedLabel);
      button.title = copiedLabel;
      const timer = window.setTimeout(() => {
        button.classList.remove('copied');
        button.setAttribute('aria-label', copyLabel);
        button.title = copyLabel;
        this.codeCopyFeedbackTimers.delete(button);
      }, 1500);
      this.codeCopyFeedbackTimers.set(button, timer);
    } catch (error) {
      button.classList.remove('copied');
      button.title = i18nService.t('messageCopyFailed');
      button.setAttribute('aria-label', i18nService.t('messageCopyFailed'));
      void error;
    }
  }

  private async renderMermaidDiagrams(): Promise<void> {
    const blocks = this.renderRoot.querySelectorAll<HTMLElement>(
      '.mermaid-block:not([data-mermaid-rendered])',
    );
    for (const block of blocks) {
      if (!this.isConnected || !block.isConnected) return;
      if (block.closest('details:not([open])')) continue;
      const hostRect = this.getBoundingClientRect();
      const blockRect = block.getBoundingClientRect();
      if (blockRect.bottom < hostRect.top || blockRect.top > hostRect.bottom) continue;
      await renderMessageDiagram(block);
      const preview = block.querySelector<HTMLElement>('.mermaid-preview');
      if (preview && block.isConnected) this.resizeMermaidBubble(block, preview);
    }
  }

  private resizeMermaidBubble(block: HTMLElement, preview: HTMLElement): void {
    const svg = preview.querySelector<SVGSVGElement>('svg');
    const bubble = block.closest<HTMLElement>('.chat-bubble--assistant');
    if (!svg || !bubble) return;

    const diagramWidth = svg.viewBox.baseVal.width || svg.getBoundingClientRect().width;
    const preferredWidth = Math.min(
      MERMAID_BUBBLE_MAX_WIDTH,
      Math.max(MERMAID_BUBBLE_MIN_WIDTH, diagramWidth + MERMAID_BUBBLE_HORIZONTAL_PADDING),
    );
    const currentWidth = Number.parseFloat(bubble.style.width) || 0;
    bubble.style.width = `${Math.max(currentWidth, preferredWidth)}px`;
  }

  private widgetContext(): NativeWidgetContext | undefined {
    if (this.captureWidgetContext) {
      const capture = this.captureWidgetContext;
      const context = capture();
      if (!context) return;
      const isCurrent = () =>
        this.isConnected && this.captureWidgetContext === capture && context.isCurrent();
      return {
        ...context,
        presentationOwner: this,
        isCurrent,
        canDraft: () => isCurrent() && context.canDraft(),
        addDraft: context.addDraft
          ? text => (isCurrent() ? context.addDraft!(text) : false)
          : undefined,
        openLink: context.openLink
          ? url => {
              if (isCurrent()) context.openLink!(url);
            }
          : undefined,
      };
    }
    const controller = this._controller;
    const client = controller?.state.client;
    const sessionKey = controller?.state.sessionKey;
    if (!controller?.state.connected || !client || !sessionKey) return;
    const generation = client.generation;
    const sessionId = controller.state.currentSessionId ?? undefined;
    const openWidgetLink = this.openWidgetLink;
    const isCurrent = () =>
      this.isConnected &&
      this._controller === controller &&
      controller.state.client === client &&
      controller.state.connected &&
      controller.state.sessionKey === sessionKey &&
      (controller.state.currentSessionId ?? undefined) === sessionId &&
      this.openWidgetLink === openWidgetLink &&
      client.generation === generation;
    return {
      client,
      sessionKey,
      generation,
      sessionId,
      agentId: /^agent:([^:]+):/.exec(sessionKey)?.[1],
      presentationOwner: this,
      boardExecutionOwner: controller,
      canDraft: () => this.canDraftWidget?.() === true,
      isCurrent,
      addDraft: text => {
        if (
          !isCurrent() ||
          this.canDraftWidget?.() !== true ||
          typeof text !== 'string' ||
          !text.trim() ||
          text.length > 4000 ||
          /^\s*[!/]/.test(text)
        )
          return false;
        return this.dispatchEvent(
          new CustomEvent(NATIVE_WIDGET_DRAFT_EVENT, {
            bubbles: true,
            composed: true,
            detail: { sessionKey, text },
          }),
        );
      },
      openLink: url => {
        if (isCurrent()) openWidgetLink?.(sessionKey, url);
      },
    };
  }

  private readonly handleWidgetContext = (event: Event): void => {
    const widget = event.composedPath()[0];
    if (
      !(widget instanceof NativeWidgetView || widget instanceof NativeWidgetAnchor) ||
      !this.renderRoot.contains(widget)
    )
      return;
    event.stopPropagation();
    widget.context = this.widgetContext();
  };

  private webpageEmbedContext(): WebpageEmbedContext | undefined {
    const binding = this.widgetContext();
    if (!binding) return;
    return {
      sessionKey: binding.sessionKey,
      sessionId: binding.sessionId,
      presentationScope: binding.presentationScope,
      presentationOwner: this,
      isCurrent: binding.isCurrent,
      openLink: binding.openLink,
    };
  }

  private readonly handleWebpageEmbedContext = (event: Event): void => {
    const anchor = event.composedPath()[0];
    if (!(anchor instanceof WebpageEmbedAnchor) || !this.renderRoot.contains(anchor)) return;
    event.stopPropagation();
    anchor.context = this.webpageEmbedContext();
  };

  private syncWidgetContexts(): void {
    const webpageContext = this.webpageEmbedContext();
    getWebpageEmbedPresentations(this.ownerDocument).refresh(this, webpageContext);
    this.renderRoot?.querySelectorAll<WebpageEmbedAnchor>('webpage-embed').forEach(anchor => {
      anchor.context = webpageContext;
    });
    const context = this.widgetContext();
    getNativeWidgetPresentations(this.ownerDocument).refresh(this, context);
    this.renderRoot
      ?.querySelectorAll<NativeWidgetView | NativeWidgetAnchor>(
        'justdo-native-widget, native-widget-anchor',
      )
      .forEach(widget => {
        widget.context = context;
      });
    this.renderRoot
      ?.querySelectorAll<McpAppView | McpAppAnchor>('mcp-app-view, mcp-app-anchor')
      .forEach(view => {
        view.context = this.mcpAppContext();
      });
  }

  private mcpAppContext(): McpAppViewContext | undefined {
    if (this.captureMcpAppContext) return this.captureMcpAppContext();
    const native = this.widgetContext();
    const controller = this._controller;
    if (!native || !controller) return;
    const sessionId = controller.state.currentSessionId;
    return {
      apps: controller.mcpApps,
      sessionKey: native.sessionKey,
      isCurrent: () => native.isCurrent() && controller.state.currentSessionId === sessionId,
      canDraft: native.canDraft,
      addDraft: text => this.addMcpAppDraft?.(text) ?? Promise.resolve(false),
      addNewDraft: (text, content) =>
        this.addNewMcpAppDraft?.(text, content) ?? Promise.resolve(false),
      openFile: this.openMcpAppFile,
    };
  }

  private readonly handleMcpAppContext = (event: Event): void => {
    const view = event.composedPath()[0];
    if (
      !(view instanceof McpAppView || view instanceof McpAppAnchor) ||
      !this.renderRoot.contains(view)
    )
      return;
    event.stopPropagation();
    view.context = this.mcpAppContext();
  };

  private subscribeController(ctrl: ChatController): void {
    this._controllerUnsubscribe = ctrl.subscribe(() => {
      this.syncWidgetContexts();
      this.requestUpdate();
    });
    this._streamUnsubscribe = ctrl.onStream(kind => {
      if (kind === 'tool-partial') {
        this.streamRenderScheduler.scheduleToolPartial();
      } else if (kind === 'terminal') {
        this.streamRenderScheduler.flush();
      } else {
        this.streamRenderScheduler.schedule();
      }
    });
  }

  private unsubscribeController(): void {
    this._controllerUnsubscribe?.();
    this._streamUnsubscribe?.();
    this._controllerUnsubscribe = null;
    this._streamUnsubscribe = null;
  }

  private publishStreamFrame(): void {
    this.historyRenderScheduler.beginFrame();
    this.requestUpdate();
  }

  public getSearchMatchCount(): number {
    return this.historySearchMatches().length + this.collectSearchMatches(undefined, true).length;
  }

  public navigateSearch(direction: 1 | -1): { index: number; total: number } {
    this.clearSearchMarks();
    this.flushHistoryRender();
    const history = this.historySearchMatches();
    const live = this.collectSearchMatches(undefined, true);
    const total = history.length + live.length;
    if (total === 0) {
      this.activeSearchIndex = -1;
      this.clearSearchMarks();
      return { index: -1, total: 0 };
    }

    this.activeSearchIndex =
      this.activeSearchIndex < 0
        ? direction === 1
          ? 0
          : total - 1
        : (this.activeSearchIndex + direction + total) % total;

    const match = history[this.activeSearchIndex];
    if (match) {
      const target = this.revealHistorySearchMatch(match);
      const matches = target
        ? match.editDiff ? this.collectEditDiffSearchMatches(target.element) : this.collectSearchMatches(target.element)
        : [];
      this.highlightSearchMatch(target ? matches[target.occurrence] : undefined);
      if (target && !matches[target.occurrence]) this.chatScrollController.navigateToElement(target.element, 'smooth');
    } else {
      this.highlightSearchMatch(live[this.activeSearchIndex - history.length]);
    }
    return { index: this.activeSearchIndex, total };
  }

  public revealMessage(entryId: string): boolean {
    const normalizedEntryId = entryId.trim();
    if (!normalizedEntryId) return false;
    this.flushHistoryRender();
    this.revealHistoryPresentation(item =>
      item.kind === 'history-message' && openClawEntryId(item.message) === normalizedEntryId,
    );
    materializeDisclosureContents(this.renderRoot);
    const rows = this.renderRoot.querySelectorAll<HTMLElement>('.chat-history-row[data-entry-id]');
    const target = [...rows].find(row => row.dataset.entryId === normalizedEntryId);
    if (!target) return false;
    this.expandSearchMatchContainers(target);
    target.classList.remove('chat-history-row--revealed');
    this.chatScrollController.navigateToElement(target, 'smooth');
    this.animationWindow.requestAnimationFrame(() =>
      target.classList.add('chat-history-row--revealed'),
    );
    window.setTimeout(() => target.classList.remove('chat-history-row--revealed'), 1_900);
    return true;
  }

  private emitSearchMatchCount(): void {
    if (!this.isConnected) return;
    const total = this.getSearchMatchCount();
    if (this.activeSearchIndex >= total) {
      this.activeSearchIndex = total > 0 ? total - 1 : -1;
    }
    this.dispatchEvent(
      new CustomEvent('search-match-count-change', {
        detail: { total, index: this.activeSearchIndex },
      }),
    );
  }

  private historySearchMatches(): readonly HistorySearchMatch[] {
    return this.historySearchIndex.find(this.historyPresentationRows, this.searchQuery, this.searchCaseSensitive);
  }

  private revealHistorySearchMatch(match: HistorySearchMatch): {
    element: HTMLElement;
    occurrence: number;
  } | null {
    let target: HTMLElement | null = null;
    for (let index = 0; index < match.path.length; index += 1) {
      const key = match.path[index];
      const viewport = index === 0 ? 'history' : `completed:${match.path[index - 1]}`;
      this.historyViewports.get(viewport)?.reveal(key);
      target = [...this.renderRoot.querySelectorAll<HTMLElement>('.history-viewport-row')]
        .find(row => row.dataset.historyKey === key) ?? null;
      if (!target) return null;
      materializeDisclosureContents(target);
    }
    if (match.processId) {
      this.historyViewports.get(`process:${match.path[match.path.length - 1]}`)?.reveal(match.processId);
      target = [...(target?.querySelectorAll<HTMLElement>('[data-inline-process-id]') ?? [])]
        .find(row => row.dataset.inlineProcessId === match.processId) ?? target;
    }
    if (match.editDiff && target) {
      return { element: target.querySelector<HTMLElement>('.edit-diff') ?? target, occurrence: match.occurrence };
    }
    if (match.processId && target) {
      let occurrence = match.occurrence;
      for (const reader of target.querySelectorAll<ToolOutput>('justdo-tool-output')) {
        const result = reader.prepareSearch(this.searchQuery, this.searchCaseSensitive, occurrence);
        if (result.occurrence !== null) return { element: reader, occurrence: result.occurrence };
        occurrence -= result.count;
      }
    }
    return target ? { element: target, occurrence: match.occurrence } : null;
  }

  private collectEditDiffSearchMatches(target: HTMLElement): SearchDomMatch[] {
    const matches: SearchDomMatch[] = [];
    for (const host of target.querySelectorAll<HTMLElement>('[data-edit-diff-monaco]')) {
      const rows = new Map<number, HTMLElement>();
      for (const row of host.querySelectorAll<HTMLElement>('[data-edit-diff-line-index]')) {
        const index = Number(row.dataset.editDiffLineIndex);
        const code = row.querySelector<HTMLElement>('code');
        if (code && !rows.has(index)) rows.set(index, code);
      }
      for (const [lineIndex, code] of [...rows].sort(([left], [right]) => left - right)) {
        matches.push(...this.collectSearchMatches(code)
          .map(match => ({ ...match, editDiff: { host, lineIndex } })));
      }
    }
    return matches;
  }

  private collectSearchMatches(
    container?: Element,
    excludeHistory = false,
  ): SearchDomMatch[] {
    const query = this.searchQuery.trim();
    const root = container ?? this.shadowRoot?.querySelector('.chat-container');
    if (!query || !root) return [];
    materializeDisclosureContents(root);

    const matcher = new RegExp(this.escapeRegExp(query), this.searchCaseSensitive ? 'g' : 'gi');
    const walker = this.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || !node.nodeValue) return NodeFilter.FILTER_REJECT;
        if (parent.closest(
          '.chat-group__footer, button, input, textarea, select, script, style, template, ' +
          '.process-summary, .process-summary__item-heading, .process-summary__tool-title, ' +
          '.process-summary__detail-label, .code-block-header, .message-reader-actions',
        )) {
          return NodeFilter.FILTER_REJECT;
        }
        if (excludeHistory && parent.closest('.chat-container > .history-viewport-row')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const matches: SearchDomMatch[] = [];
    let block: Element | null = null;
    let nodes: Text[] = [];
    const flush = () => {
      const text = nodes.map(node => node.nodeValue ?? '').join('');
      matcher.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = matcher.exec(text))) {
        const start = match.index;
        const end = start + match[0].length;
        let offset = 0;
        let first: { node: Text; offset: number } | null = null;
        for (const node of nodes) {
          const next = offset + (node.nodeValue?.length ?? 0);
          if (!first && start < next) first = { node, offset: start - offset };
          if (first && end <= next) {
            matches.push({ node: first.node, start: first.offset, endNode: node, end: end - offset });
            break;
          }
          offset = next;
        }
      }
      nodes = [];
    };
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const parentBlock = node.parentElement?.closest('p, pre, li, td, th, h1, h2, h3, h4, h5, h6, summary, .chat-bubble__text, .markdown-content') ?? node.parentElement;
      if (block !== parentBlock) flush();
      block = parentBlock;
      nodes.push(node);
    }
    flush();
    return matches;
  }

  private highlightSearchMatch(
    match: SearchDomMatch | undefined,
  ): void {
    this.clearSearchMarks(false);
    if (!match) return;

    const editor = match.editDiff && this.editDiffMonacoController.revealSearch(
      match.editDiff.host, match.editDiff.lineIndex, match.start, match.end - match.start,
    );
    if (editor?.native) {
      this.expandSearchMatchContainers(editor.container);
      this.chatScrollController.navigateToElement(editor.container, 'smooth');
      return;
    }

    const range = this.ownerDocument.createRange();
    range.setStart(match.node, match.start);
    range.setEnd(match.endNode, match.end);

    const mark = this.ownerDocument.createElement('span');
    mark.className = 'chat-search-mark';
    mark.dataset.justdoSearchMark = 'true';
    mark.append(range.extractContents());
    range.insertNode(mark);
    this.expandSearchMatchContainers(mark);
    this.chatScrollController.navigateToElement(mark, 'smooth');
  }

  private expandSearchMatchContainers(mark: HTMLElement): void {
    mark.closest<TerminalErrorMessage>('chat-terminal-error')?.revealText();
    revealThinkingContent(mark);
    let current: HTMLElement | null = mark;
    while (current) {
      const details: HTMLDetailsElement | null = current.closest('details');
      if (!details) return;
      this.completedProcessMotion.cancel(details);
      details.open = true;
      current = details.parentElement;
    }
  }

  private clearSearchMarks(resetReaders = true): void {
    this.editDiffMonacoController.clearSearch();
    const root = this.shadowRoot;
    if (!root) return;
    root.querySelectorAll<HTMLElement>('[data-justdo-search-mark="true"]').forEach(mark => {
      const parent = mark.parentNode;
      if (!parent) return;
      mark.replaceWith(...mark.childNodes);
      parent.normalize();
    });
    if (resetReaders) root.querySelectorAll<ToolOutput>('justdo-tool-output')
      .forEach(reader => reader.clearSearch());
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private buildItems(
    messages?: unknown[],
    toolMessages?: unknown[],
    streamSegments?: Array<{ text: string; ts: number }>,
    stream?: string | null,
  ): Array<ChatItem | MessageGroup> {
    const msgs = messages ?? this.messages ?? [];

    try {
      const result = buildChatItems({
        sessionKey: '',
        messages: msgs,
        toolMessages: toolMessages ?? [],
        stream: stream ?? this.stream,
        streamStartedAt: this.streamStartedAt,
        streamSegments: streamSegments ?? [],
        queue: [],
        showToolCalls: true,
        peerPerspective: this.peerPerspective,
      });
      return result ?? [];
    } catch (err) {
      console.error('[justdo-chat] buildChatItems error:', err);
      return [];
    }
  }

  private activeTurnStatusKey(turn: AssistantTurn): string {
    if (turn.status === 'final') return 'coworkRunStateDone';
    if (turn.status === 'aborted' || turn.status === 'error') {
      return 'coworkRunStateInterrupted';
    }
    const last = turn.items[turn.items.length - 1];
    if (last?.type === 'thinking' && last.status === 'running') {
      return 'coworkRunStateThinking';
    }
    if (last?.type === 'thinking') {
      for (let index = turn.items.length - 2; index >= 0; index -= 1) {
        const item = turn.items[index];
        if (item.type === 'thinking') continue;
        if (
          item.type === 'content' &&
          item.assistantItemId !== undefined &&
          (item.lastTextSeq ?? -1) >= last.lastSeq
        )
          return 'coworkRunStateResponding';
        break;
      }
    }
    if (last?.type === 'tool' && last.status === 'running') return 'coworkRunStateTool';
    if (last?.type === 'content' && last.status === 'streaming') {
      return 'coworkRunStateResponding';
    }
    return 'coworkRunStateStarting';
  }

  private activeTurnFooter(
    footer: ActiveTurnFooter,
    persistedMessages: GatewayMessage[],
    timing: AssistantTurnTiming | SessionRunTiming | null,
    hasWorkingTimer = false,
  ): TemplateResult | typeof nothing {
    const model = resolveActiveTurnModel(persistedMessages, footer.modelRef);
    const timingRunIds = new Set(
      timing
        ? [
            'runId' in timing ? timing.runId : undefined,
            'rootRunId' in timing ? timing.rootRunId : undefined,
            'clientTurnId' in timing ? timing.clientTurnId : undefined,
          ].filter((value): value is string => typeof value === 'string' && value.length > 0)
        : [],
    );
    const matchingAssistant = [...this.forkEligibilityMessages]
      .reverse()
      .find(
        message =>
          message.role?.toLowerCase() === 'assistant' &&
          timingRunIds.has(gatewayMessageRunId(message) ?? ''),
      );
    const forkPoint =
      footer.status === 'completed' &&
      !footer.running &&
      this.userMessageHistoryActionsAvailable &&
      this.onAssistantMessageFork
        ? this.assistantForkPoint(openClawEntryId(matchingAssistant))
        : null;
    return this.renderRunFooter({
      status: footer.status,
      running: footer.running,
      model,
      completedAt: footer.completedAt,
      durationMs: footer.running && hasWorkingTimer ? undefined : footer.durationMs,
      forkPoint,
    });
  }

  private failedRunFooter(
    item: Extract<PersistedTimelineItem, { kind: 'history-message' }>,
  ): TemplateResult | typeof nothing {
    return this.renderRunFooter({
      status: 'failed',
      running: false,
      model: item.modelRef ?? readFailedRunMessageModelRef(item.message),
      completedAt: item.completedAt ?? readFailedRunMessageTimestamp(item.message),
      durationMs: item.durationMs,
    });
  }

  /**
   * Allows only entries on the implementation side of the latest Plan reset.
   * The Gateway validates and includes the selected assistant entry atomically.
   */
  private assistantForkPoint(entryId: string | null): { entryId: string } | null {
    if (!entryId || !this.actionEligibilityIds.has(entryId)) {
      return null;
    }
    return { entryId };
  }

  private renderRunFooter(details: {
    status: ActiveTurnFooter['status'];
    running: boolean;
    model?: string;
    completedAt?: number | null;
    durationMs?: number;
    forkPoint?: { entryId: string } | null;
  }): TemplateResult | typeof nothing {
    const model = details.model?.trim() ?? '';
    const completedDateCandidate =
      typeof details.completedAt === 'number' && Number.isFinite(details.completedAt)
        ? new Date(details.completedAt)
        : null;
    const completedDate =
      completedDateCandidate && Number.isFinite(completedDateCandidate.getTime())
        ? completedDateCandidate
        : null;
    const durationKey = details.running
      ? 'coworkRunWorkingDuration'
      : details.status === 'failed'
        ? 'coworkRunFailedDuration'
        : details.status === 'aborted'
          ? 'coworkRunAbortedDuration'
          : 'coworkRunWorkedDuration';
    const durationLabel =
      typeof details.durationMs === 'number' && Number.isFinite(details.durationMs)
        ? i18nService
            .t(durationKey)
            .replace('{duration}', formatActiveTurnDuration(details.durationMs))
        : '';
    if (!model && !completedDate && !durationLabel) return nothing;
    return html`
      ${model ? html`<span>${model}</span>` : nothing}
      ${
        completedDate
          ? html`
              ${
                model
                  ? html`<span class="active-turn__footer-separator" aria-hidden="true">·</span>`
                  : nothing
              }
              <time datetime=${completedDate.toISOString()}
                >${formatActiveTurnTimestamp(completedDate)}</time
              >
            `
          : nothing
      }
      ${
        durationLabel && (model || completedDate)
          ? html`<span class="active-turn__footer-separator" aria-hidden="true">·</span>`
          : nothing
      }
      ${durationLabel ? html`<span>${durationLabel}</span>` : nothing}
      ${
        details.forkPoint
          ? html`
              <button
                type="button"
                class="assistant-message-action assistant-message-action--fork"
                aria-label=${i18nService.t('coworkForkFromMessage')}
                title=${i18nService.t('coworkForkFromMessage')}
                @click=${(event: Event) => {
                  event.stopPropagation();
                  void this.onAssistantMessageFork?.(details.forkPoint!.entryId);
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width="1.8"
                    d="M7 4v4a4 4 0 0 0 4 4h6m0 0-3-3m3 3-3 3M7 20v-4"
                  ></path>
                </svg>
              </button>
            `
          : nothing
      }
    `;
  }

  private get mediaSessionKey(): string {
    return this._controller?.state.sessionKey ?? this.activeTurn?.sessionKey ?? '';
  }

  private renderPersistedRows(rows: readonly VisibleTimelineRow[]) {
    this.historyPresentationRows = rows;
    const renderedRows = this.historyRenderScheduler.select(
      rows,
      this.processSummarySessionIdentity ?? 'direct',
      Boolean(this.searchQuery.trim()),
    );
    return guard(
      [
        renderedRows,
        this.persistedRenderRevision,
        this.mediaSessionKey,
        this.userMessageHistoryActionsAvailable,
        this.actionableUserEntryId,
        this.forkEligibilityMessages,
        this.renderedOpenProcessSummaryKey,
        this.renderedCollapsedProcessSummaryKeys,
        this.processSummariesExpanded,
      ],
      () =>
        this.renderHistoryViewport(
          'history',
          renderedRows,
          row => row.item.key,
          row => {
            const item = row.item;
            return item.kind === 'history-message'
              ? guard(
                  [
                    item.message,
                    item.durationMs,
                    item.completedAt,
                    item.modelRef,
                    item.runState,
                    row.showAvatar,
                    row.showFooter,
                    this.persistedRenderRevision,
                    this.mediaSessionKey,
                    this.historyMessageActionsKey(item, row.showFooter),
                  ],
                  () => this.renderVisibleTimelineItem(item, row.showAvatar, row.showFooter),
                )
              : this.renderVisibleTimelineItem(item, row.showAvatar, row.showFooter);
          },
        ),
    );
  }

  private renderHistoryViewport<T>(
    name: string,
    items: readonly T[],
    key: (item: T) => string,
    render: (item: T, index: number) => unknown,
  ) {
    return historyViewport({
      items,
      key,
      render,
      host: this,
      scope: JSON.stringify([this.processSummarySessionIdentity ?? 'direct',
        this._controller?.state.client?.generation ?? 0, this.historyOwnerRevision, name]),
      follow: () => name === 'history' && this.chatScrollController.state.mode === 'follow',
      defer: () => this.chatScrollController.isDraggingScrollbar,
      beforeCommit: () => {
        this.historyDisclosureState.capture(this.renderRoot);
        this.completedProcessMotion.capture(this.renderRoot);
        this.messageDisclosureState.capture(this.renderRoot as ShadowRoot);
        this.chatScrollController.beforeRender();
      },
      afterCommit: () => {
        if (!this.isConnected) return;
        this.messageDisclosureState.restore(this.renderRoot as ShadowRoot);
        this.richMessageControls?.sync();
        this.syncReturningProcessSummaries();
        this.completedProcessMotion.afterRender();
        this.chatScrollController.afterRender(this._controller?.state.transcript.revision ?? 0);
        this.syncWidgetContexts();
        this.scheduleEditDiffMonacoSync();
        this.scheduleMinimapSync();
        this.animationWindow.requestAnimationFrame(() => void this.renderMermaidDiagrams());
      },
      ref: viewport => {
        if (viewport) this.historyViewports.set(name, viewport);
        else this.historyViewports.delete(name);
      },
    });
  }

  private historyMessageActionsKey(
    item: Extract<VisibleTimelineItem, { kind: 'history-message' }>,
    showFooter: boolean,
  ): boolean {
    if (!this.userMessageHistoryActionsAvailable) return false;
    const entryId = openClawEntryId(item.message);
    if (!entryId || !this.actionEligibilityIds.has(entryId)) return false;
    return item.message.role?.toLowerCase() === 'user'
      ? entryId === this.actionableUserEntryId && Boolean(this.onLastUserMessageAction)
      : item.message.role?.toLowerCase() === 'assistant' &&
          showFooter &&
          item.durationMs !== undefined &&
          item.runState === 'completed' &&
          Boolean(this.onAssistantMessageFork);
  }

  private renderVisibleTimelineItem(
    item: VisibleTimelineItem,
    showAvatar: boolean,
    showFooter: boolean,
  ): TemplateResult | typeof nothing {
    if (item.kind === 'compaction') {
      return item.item.message
        ? this.renderVisibleTimelineItem(
            { kind: 'history-message', key: item.key, message: item.item.message },
            false,
            false,
          )
        : nothing;
    }
    if (item.kind === 'completed-process') {
      const expanded = this.historyDisclosureState.expanded(
        item.key,
        this.processSummariesExpanded,
        item.items.flatMap(child => [
          child.key,
          ...(child.kind === 'process-summary'
            ? child.items.map(process => `process:${process.id}`)
            : []),
        ]),
      );
      return renderCompletedProcess(item, {
        sessionIdentity: this.processSummarySessionIdentity,
        showAvatar,
        expanded,
        onRender: this.completedProcessMotion.ref(item, expanded),
        assistantAvatar: this.assistantAvatar,
        renderItem: (child, childShowsAvatar) =>
          this.renderVisibleTimelineItem(child, childShowsAvatar, false),
        renderItems: render => this.renderHistoryViewport(
          `completed:${item.key}`,
          item.items,
          child => child.key,
          render,
        ),
      });
    }
    if (item.kind === 'phase-boundary') {
      return html`
        <div class="phase-boundary" data-history-key=${item.key} role="separator">
          <span>${item.label || i18nService.t('planModeImplementationDivider')}</span>
        </div>
      `;
    }
    if (item.kind === 'history-message') {
      if (isFailedRunMessage(item.message)) {
        return html`
          <div
            class="chat-history-row"
            data-history-key=${item.key}
            data-minimap-anchor=${item.key}
          >
            ${renderTerminalTimelineMessage(
              readFailedRunMessageText(item.message),
              'error',
              showAvatar,
              showFooter ? this.failedRunFooter(item) : nothing,
            )}
          </div>
        `;
      }
      const historyItems = this.buildItems([item.message], [], [], null).map(historyItem =>
        historyItem.kind === 'group' &&
        historyItem.role === 'assistant' &&
        item.durationMs !== undefined
          ? {
              ...historyItem,
              durationMs: item.durationMs,
              ...(item.completedAt !== undefined ? { timestamp: item.completedAt } : {}),
            }
          : historyItem,
      );
      const entryId = openClawEntryId(item.message);
      const pendingInputState = nativePendingInputState(item.message);
      const isPersistedUserMessage =
        !pendingInputState && item.message.role?.toLowerCase() === 'user' && entryId;
      const canEditOrWithdraw =
        isPersistedUserMessage &&
        entryId === this.actionableUserEntryId &&
        this.actionEligibilityIds.has(entryId) &&
        Boolean(this.onLastUserMessageAction);
      const userMessageActions =
        entryId && canEditOrWithdraw
          ? {
              entryId,
              canEdit: canEditOrWithdraw,
              canWithdraw: canEditOrWithdraw,
              onAction: (action: UserMessageHistoryAction, targetEntryId: string) => {
                if (action === 'edit') {
                  this.userMessageEditor = {
                    entryId: targetEntryId,
                    value: extractTextCached(item.message) ?? '',
                    submitting: false,
                  };
                  void this.updateComplete.then(() => {
                    this.renderRoot
                      .querySelector<HTMLTextAreaElement>('.user-message-editor__input')
                      ?.focus();
                  });
                  return;
                }
                this.onLastUserMessageAction?.(action, targetEntryId);
              },
              ...(canEditOrWithdraw && this.userMessageEditor?.entryId === entryId
                ? {
                    editor: {
                      value: this.userMessageEditor.value,
                      submitting: this.userMessageEditor.submitting,
                      onChange: (value: string) => {
                        if (!this.userMessageEditor || this.userMessageEditor.entryId !== entryId)
                          return;
                        this.userMessageEditor = { ...this.userMessageEditor, value };
                      },
                      onCancel: () => {
                        if (!this.userMessageEditor?.submitting) this.userMessageEditor = null;
                      },
                      onSubmit: async () => {
                        if (!this.userMessageEditor || this.userMessageEditor.submitting) return;
                        const value = this.userMessageEditor.value;
                        this.userMessageEditor = { ...this.userMessageEditor, submitting: true };
                        const completed = await this.onLastUserMessageAction?.(
                          'edit',
                          entryId,
                          value,
                        );
                        if (completed) {
                          this.userMessageEditor = null;
                        } else if (this.userMessageEditor?.entryId === entryId) {
                          this.userMessageEditor = { ...this.userMessageEditor, submitting: false };
                        }
                      },
                    },
                  }
                : {}),
            }
          : undefined;
      const assistantForkPoint =
        item.message.role?.toLowerCase() === 'assistant' &&
        showFooter &&
        item.durationMs !== undefined &&
        item.runState === 'completed' &&
        this.userMessageHistoryActionsAvailable &&
        this.onAssistantMessageFork
          ? this.assistantForkPoint(entryId)
          : null;
      const assistantMessageFork = assistantForkPoint
        ? {
            ...assistantForkPoint,
            onFork: (sourceEntryId: string) => {
              void this.onAssistantMessageFork?.(sourceEntryId);
            },
          }
        : undefined;
      return html`
        <div
          class="chat-history-row"
          data-history-key=${item.key}
          data-minimap-anchor=${item.key}
          data-entry-id=${entryId ?? nothing}
        >
          ${this.renderItems(
            historyItems,
            null,
            showAvatar,
            showFooter,
            userMessageActions,
            assistantMessageFork,
            item.key,
          )}
          ${
            pendingInputState && pendingInputState !== 'queued'
              ? html`<div class="active-turn__footer" data-pending-input-state=${pendingInputState}>
                  ${i18nService.t(pendingInputState === 'cancelled' ? 'messagePendingInputCancelled' : 'messagePendingInputInterrupted')}
                </div>`
              : nothing
          }
        </div>
      `;
    }
    let expanded = item.kind === 'process-summary' &&
      ((this.processSummariesExpanded && !this.renderedCollapsedProcessSummaryKeys.has(item.key)) ||
        this.renderedOpenProcessSummaryKey === item.key);
    if (item.kind === 'process-summary' &&
      ![...this.renderRoot.querySelectorAll<HTMLElement>('[data-process-summary-key]')]
        .some(element => element.dataset.processSummaryKey === item.key)) {
      expanded = this.historyDisclosureState.expanded(item.key, expanded);
    }
    return renderTimelineItem(
      item,
      Date.now(),
      expanded,
      showAvatar,
      this.editDiffModes,
      this.handleEditDiffModeChange,
      this.localTtsAvailable
        ? {
            state: this.getSpeechState(item.key),
            onSpeak: this.handleSpeak,
          }
        : undefined,
      this.assistantAvatar,
      process => this.thinkingContentPresentation.render(process),
      {
        workingDirectory: this.workingDirectory,
        onOpenFile: this.onOpenFile,
        sessionKey: this.mediaSessionKey,
      },
      item.kind === 'process-summary'
        ? render => this.renderHistoryViewport(
            `process:${item.key}`,
            item.items,
            process => process.id,
            render,
          )
        : undefined,
    );
  }

  private renderMinimap(
    entries: readonly ChatMinimapEntry[],
    tail: ChatMinimapEntry | null = null,
    keySignature?: string,
  ): TemplateResult | typeof nothing {
    this.latestMinimapPrefix = entries;
    this.latestMinimapTail = tail;
    this.minimapEntriesSignature =
      keySignature ?? [...entries.map(entry => entry.key), ...(tail ? [tail.key] : [])].join('|');
    if (entries.length + (tail ? 1 : 0) < MINIMAP_VISIBLE_ENTRY_THRESHOLD) return nothing;

    const hoveredEntry =
      (tail?.key === this.hoveredMinimapKey ? tail : null) ??
      entries.find(entry => entry.key === this.hoveredMinimapKey) ??
      null;
    const count = entries.length + (tail ? 1 : 0);
    const activeIndex = this.currentMinimapKey === tail?.key
      ? entries.length
      : entries.findIndex(entry => entry.key === this.currentMinimapKey);
    const center = activeIndex >= 0 ? activeIndex : count - 1;
    const start = Math.max(0, Math.min(count - MINIMAP_RENDER_LIMIT,
      center - Math.floor(MINIMAP_RENDER_LIMIT / 2)));
    const end = start + MINIMAP_RENDER_LIMIT;
    return html`
      <nav
        class="chat-minimap"
        aria-label=${i18nService.t('coworkMinimapLabel')}
        @mouseleave=${() => {
          this.hoveredMinimapKey = null;
        }}
      >
        <div class="chat-minimap__track">
          ${repeat(
            entries.slice(start, end),
            entry => entry.key,
            entry => this.renderMinimapEntry(entry),
          )}
          ${tail && entries.length < end ? this.renderMinimapEntry(tail) : nothing}
        </div>
        ${
          hoveredEntry
            ? html`
                <div
                  class="chat-minimap__preview"
                  style=${`top: ${this.minimapPreviewTop}px`}
                  aria-hidden="true"
                >
                  <div class="chat-minimap__preview-user">
                    ${hoveredEntry.userText || i18nService.t('coworkMinimapUserMessage')}
                  </div>
                  ${
                    hoveredEntry.assistantText
                      ? html`
                          <div class="chat-minimap__preview-assistant">
                            ${hoveredEntry.assistantText}
                          </div>
                        `
                      : nothing
                  }
                </div>
              `
            : nothing
        }
      </nav>
    `;
  }

  private renderMinimapEntry(entry: ChatMinimapEntry): TemplateResult {
    const active = entry.key === this.currentMinimapKey;
    const lineWidth = Math.min(
      8,
      3 + Math.ceil((entry.userText.length + entry.assistantText.length) / 96),
    );
    return html`
      <button
        type="button"
        class=${`chat-minimap__item${active ? ' chat-minimap__item--active' : ''}`}
        aria-current=${active ? 'true' : nothing}
        aria-label=${entry.userText || i18nService.t('coworkMinimapUserMessage')}
        @click=${() => this.scrollToMinimapEntry(entry)}
        @mouseenter=${(event: MouseEvent) => this.showMinimapPreview(entry, event)}
        @focus=${(event: FocusEvent) => this.showMinimapPreview(entry, event)}
        @blur=${() => {
          this.hoveredMinimapKey = null;
        }}
      >
        <span
          class="chat-minimap__line"
          style=${`--minimap-line-width: ${lineWidth}px`}
          aria-hidden="true"
        ></span>
      </button>
    `;
  }

  private minimapEntryCount(): number {
    return this.latestMinimapPrefix.length + (this.latestMinimapTail ? 1 : 0);
  }

  private minimapEntryAt(index: number): ChatMinimapEntry | null {
    if (index < this.latestMinimapPrefix.length) {
      return this.latestMinimapPrefix[index] ?? null;
    }
    return index === this.latestMinimapPrefix.length ? this.latestMinimapTail : null;
  }

  private scrollToMinimapEntry(entry: ChatMinimapEntry): void {
    this.flushHistoryRender();
    this.revealHistoryPresentation(item => item.key === entry.anchorKey);
    let entryIndex = this.latestMinimapPrefix.findIndex(candidate => candidate.key === entry.key);
    if (entryIndex < 0 && this.latestMinimapTail?.key === entry.key) {
      entryIndex = this.latestMinimapPrefix.length;
    }
    const target = this.resolveMinimapAnchor(entry, entryIndex);
    if (!target) return;

    const hostTop = this.getBoundingClientRect().top;
    const targetTop = target.getBoundingClientRect().top;
    const nextScrollTop = Math.max(0, this.scrollTop + targetTop - hostTop - 16);
    this.currentMinimapKey = entry.key;
    this.chatScrollController.navigateTo(nextScrollTop, 'smooth');
  }

  private flushHistoryRender(): void {
    if (!this.historyRenderScheduler.isPending) return;
    this.historyRenderScheduler.flush();
    this.requestUpdate();
    this.performUpdate();
  }

  private revealHistoryPresentation(matches: (item: VisibleTimelineItem) => boolean): boolean {
    for (const row of this.historyPresentationRows) {
      const item = row.item;
      if (matches(item)) return this.historyViewports.get('history')?.reveal(item.key) ?? false;
      if (item.kind !== 'completed-process') continue;
      const child = item.items.find(matches);
      if (!child) continue;
      this.historyViewports.get('history')?.reveal(item.key);
      materializeDisclosureContents(this.renderRoot);
      return this.historyViewports.get(`completed:${item.key}`)?.reveal(child.key) ?? false;
    }
    return false;
  }

  private readonly handleMinimapScroll = (): void => {
    this.scheduleMinimapSync();
  };

  private scheduleMinimapSync(): void {
    if (this.minimapScrollFrame !== null) return;
    this.minimapScrollFrame = this.animationWindow.requestAnimationFrame(() => {
      this.minimapScrollFrame = null;
      this.updateCurrentMinimapEntry();
    });
  }

  private updateCurrentMinimapEntry(): void {
    const entryCount = this.minimapEntryCount();
    if (entryCount < MINIMAP_VISIBLE_ENTRY_THRESHOLD) {
      if (this.currentMinimapKey !== null) this.currentMinimapKey = null;
      return;
    }

    const hostRect = this.getBoundingClientRect();
    const activationTop = hostRect.top + Math.min(120, Math.max(48, this.clientHeight * 0.18));
    const keyedAnchors = new Map<string, HTMLElement>();
    this.renderRoot
      .querySelectorAll<HTMLElement>('[data-minimap-anchor]')
      .forEach(anchor => keyedAnchors.set(anchor.dataset.minimapAnchor ?? '', anchor));
    const fallbackAnchors = this.renderRoot.querySelectorAll<HTMLElement>(
      '.chat-container .chat-group--user',
    );
    const resolvedEntries: Array<{ entry: ChatMinimapEntry; anchor: HTMLElement }> = [];
    for (let index = 0; index < entryCount; index += 1) {
      const entry = this.minimapEntryAt(index);
      if (!entry) continue;
      const anchor = keyedAnchors.get(entry.anchorKey) ??
        (!this._controller && keyedAnchors.size === 0 ? fallbackAnchors[index] : undefined);
      if (anchor) resolvedEntries.push({ entry, anchor });
    }
    if (resolvedEntries.length === 0) return;

    let low = 0;
    let high = resolvedEntries.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (resolvedEntries[middle].anchor.getBoundingClientRect().top <= activationTop) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    let current = resolvedEntries[Math.max(0, low - 1)].entry;
    if (this.scrollHeight - this.scrollTop - this.clientHeight <= 1) {
      current = resolvedEntries[resolvedEntries.length - 1].entry;
    }
    const nextKey = current.key;
    if (nextKey !== this.currentMinimapKey) this.currentMinimapKey = nextKey;
  }

  private resolveMinimapAnchor(entry: ChatMinimapEntry, entryIndex: number): HTMLElement | null {
    const keyedAnchor = this.renderRoot.querySelector<HTMLElement>(
      `[data-minimap-anchor="${CSS.escape(entry.anchorKey)}"]`,
    );
    if (keyedAnchor) return keyedAnchor;
    if (entryIndex < 0) return null;
    return (
      this.renderRoot.querySelectorAll<HTMLElement>('.chat-container .chat-group--user')[
        entryIndex
      ] ?? null
    );
  }

  private showMinimapPreview(entry: ChatMinimapEntry, event: Event): void {
    const target = event.currentTarget as HTMLElement;
    const minimap = target.closest<HTMLElement>('.chat-minimap');
    if (!minimap) return;
    const targetRect = target.getBoundingClientRect();
    const minimapRect = minimap.getBoundingClientRect();
    const targetCenter = targetRect.top + targetRect.height / 2 - minimapRect.top;
    this.minimapPreviewTop = Math.max(28, Math.min(minimapRect.height - 28, targetCenter));
    this.hoveredMinimapKey = entry.key;
  }

  private activeTurnForDisplay(ctrl: ChatController | null): AssistantTurn | null {
    return ctrl ? ctrl.state.transcript.activeTurn : this.activeTurn;
  }

  private projectActiveTimeline(turn: AssistantTurn | null) {
    const waitingStatus = this._controller
      ? projectWaitingStatus({
          activity: this._controller.state.runActivity,
          transportStatus: this._controller.state.transportStatus,
        })
      : null;
    return projectTurnItems(
      turn,
      this._controller?.state.chatSending ?? this.isStreaming,
      waitingStatus,
      this._controller?.state.runActivity ?? null,
    );
  }

  private renderItem(
    item: ChatItem | MessageGroup,
    thinkingStream: string | null = null,
    showAvatar = true,
  ): TemplateResult | typeof nothing {
    if (!item) return nothing;

    if ('kind' in item) {
      if (item.kind === 'group') {
        return renderMessageBlock(item as MessageGroup, {
          searchQuery: this.searchQuery,
          showAvatar,
          assistantName: this.assistantName,
          assistantAvatar: this.assistantAvatar,
          peerColors: this.peerColors,
          peerNames: this.peerNames,
          peerPerspective: this.peerPerspective,
          workingDirectory: this.workingDirectory,
          sessionKey: this.mediaSessionKey,
          onOpenFile: this.onOpenFile,
          speechState: this.getSpeechState(item.key),
          onSpeak: this.localTtsAvailable ? this.handleSpeak : undefined,
        });
      }
      if (item.kind === 'stream') {
        const streamItem = item as {
          kind: 'stream';
          text: string;
          thinkingText?: string | null;
          startedAt: number;
          isStreaming: boolean;
        };
        const thinkingText =
          streamItem.thinkingText ?? (streamItem.isStreaming ? thinkingStream : null);
        return renderStreamingGroup(streamItem.text, streamItem.startedAt, thinkingText, {
          showAvatar,
          onOpenFile: this.onOpenFile,
          workingDirectory: this.workingDirectory,
          sessionKey: this.mediaSessionKey,
        });
      }
      if (item.kind === 'divider') {
        return renderCompactionDivider(item);
      }
      if (item.kind === 'reading-indicator') {
        return nothing;
      }
    }

    return nothing;
  }

  private renderItems(
    items: Array<ChatItem | MessageGroup>,
    thinkingStream: string | null = null,
    initialAssistantAvatar?: boolean,
    allowFooter = true,
    userMessageActions?: {
      entryId: string;
      onAction: (action: UserMessageHistoryAction, entryId: string) => void;
    },
    assistantMessageFork?: {
      entryId: string;
      onFork: (entryId: string) => void;
    },
    disclosureOwner?: string,
  ): Array<TemplateResult | typeof nothing> {
    const rendered: Array<TemplateResult | typeof nothing> = [];

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const prev = items[index - 1];
      const next = items[index + 1];
      if (
        item?.kind === 'group' &&
        item.role === 'assistant' &&
        next?.kind === 'stream' &&
        next.isStreaming
      ) {
        rendered.push(
          renderMessageBlockWithTrailingStream(item, next.text, thinkingStream, {
            disclosureOwner,
            searchQuery: this.searchQuery,
            showAvatar: shouldRenderGroupAvatarByPrevItem(item as MessageGroup, prev),
            workingDirectory: this.workingDirectory,
            sessionKey: this.mediaSessionKey,
            onOpenFile: this.onOpenFile,
            assistantName: this.assistantName,
            assistantAvatar: this.assistantAvatar,
            peerColors: this.peerColors,
            peerNames: this.peerNames,
            peerPerspective: this.peerPerspective,
            speechState: this.getSpeechState(item.key),
            onSpeak: this.localTtsAvailable ? this.handleSpeak : undefined,
          }),
        );
        index += 1;
        continue;
      }

      if (item?.kind === 'group') {
        const showAvatar =
          index === 0 && item.role === 'assistant'
            ? (initialAssistantAvatar ??
              shouldRenderGroupAvatarByPrevItem(item as MessageGroup, prev))
            : shouldRenderGroupAvatarByPrevItem(item as MessageGroup, prev);
        rendered.push(
          renderMessageBlock(item as MessageGroup, {
            disclosureOwner,
            searchQuery: this.searchQuery,
            showFooter:
              allowFooter && shouldRenderGroupFooterByNextItem(item as MessageGroup, next),
            showAvatar,
            assistantName: this.assistantName,
            assistantAvatar: this.assistantAvatar,
            peerColors: this.peerColors,
            peerNames: this.peerNames,
            peerPerspective: this.peerPerspective,
            workingDirectory: this.workingDirectory,
            sessionKey: this.mediaSessionKey,
            onOpenFile: this.onOpenFile,
            speechState: this.getSpeechState(item.key),
            onSpeak: this.localTtsAvailable ? this.handleSpeak : undefined,
            userMessageActions,
            assistantMessageFork,
          }),
        );
        continue;
      }

      const showAvatar =
        item?.kind === 'stream'
          ? !(prev?.kind === 'group' && prev.role === 'assistant') && prev?.kind !== 'stream'
          : true;
      rendered.push(this.renderItem(item, thinkingStream, showAvatar));
    }

    return rendered;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'justdo-chat': JustDoChatElement;
  }
}
