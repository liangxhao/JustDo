/**
 * <justdo-chat> Lit custom element.
 * Renders OpenClaw-style chat messages in a shadow DOM.
 *
 * Can receive messages either:
 * 1. Directly via properties (messages, stream, etc.)
 * 2. Via a ChatController reference (controller property)
 */
import type { SessionRunTiming } from '@shared/cowork/sessionRun';
import { LocalSpeechModelKind } from '@shared/speech/localSpeechModels';
import { normalizeLocalSpeechSettings } from '@shared/speech/localSpeechSettings';
import { html, LitElement, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import mermaid from 'mermaid';

import { IMAGE_PREVIEW_EVENT } from '@/features/cowork/components/preview/imageFilePreview';
import {
  type EditDiffMode,
  renderTerminalTimelineMessage,
  renderTimelineItem,
} from '@/libs/openclaw-chat/components/active-turn-timeline';
import {
  renderMessageBlock,
  renderMessageBlockWithTrailingStream,
  renderStreamingGroup,
  renderStreamingThinkingGroup,
  shouldRenderGroupAvatarByPrevItem,
  shouldRenderGroupFooterByNextItem,
  showImageContextMenu,
} from '@/libs/openclaw-chat/components/message-render';
import {
  AssistantStreamPacer,
  type AssistantStreamSnapshot,
} from '@/libs/openclaw-chat/controllers/assistant-stream-pacer';
import { ChatScrollController } from '@/libs/openclaw-chat/controllers/chat-scroll-controller';
import { StreamRenderScheduler } from '@/libs/openclaw-chat/controllers/stream-render-scheduler';
import type { ChatController } from '@/libs/openclaw-chat/gateway/chat-controller';
import {
  type ActiveTurnFooter,
  formatActiveTurnDuration,
  formatActiveTurnTimestamp,
  projectActiveTurnFooter,
  resolveActiveTurnModel,
  selectActiveTurnTiming,
  shouldRenderInterruptedTerminalFallback,
} from '@/libs/openclaw-chat/model/active-turn-footer';
import {
  type ChatMinimapEntry,
  projectChatMinimapEntries,
} from '@/libs/openclaw-chat/model/chat-minimap';
import {
  traceTimelineDom,
  traceTimelineProjection,
} from '@/libs/openclaw-chat/model/chat-timeline-trace';
import {
  type AssistantTurn,
  type AssistantTurnTiming,
  normalizeTranscriptSessionKey,
} from '@/libs/openclaw-chat/model/chat-transcript-state';
import {
  isFailedRunMessage,
  readFailedRunMessageModelRef,
  readFailedRunMessageText,
  readFailedRunMessageTimestamp,
} from '@/libs/openclaw-chat/model/failed-run-message';
import { projectPersistedMessagesForActiveTurn } from '@/libs/openclaw-chat/model/optimistic-history-tail';
import { mergePendingUserMessageForDisplay } from '@/libs/openclaw-chat/model/optimistic-user-message';
import { PersistedTimelineCache } from '@/libs/openclaw-chat/model/persisted-timeline-cache';
import {
  createProcessSummarySessionIdentity,
  ProcessSummaryTakeoverSetTracker,
  ProcessSummaryTakeoverTracker,
} from '@/libs/openclaw-chat/model/process-summary-takeover';
import {
  type PersistedTimelineItem,
  projectPersistedTimeline,
} from '@/libs/openclaw-chat/model/project-history-timeline';
import {
  type ActiveTurnTimelineItem,
  projectTurnItems,
} from '@/libs/openclaw-chat/model/project-turn-items';
import { projectWaitingStatus } from '@/libs/openclaw-chat/model/run-activity';
import { prepareVisibleTimelineRows } from '@/libs/openclaw-chat/model/timeline-avatar-state';
import {
  PersistedTimelineRenderCache,
  projectIncrementalTimelineView,
} from '@/libs/openclaw-chat/model/timeline-render-cache';
import { isEntryAfterLatestPlanImplementationReset } from '@/libs/openclaw-chat/model/transcript-identity';
import { buildChatItems } from '@/libs/openclaw-chat/pipeline/build-chat-items';
import { extractTextCached } from '@/libs/openclaw-chat/pipeline/message-extract';
import { isTrustedPeerInput } from '@/libs/openclaw-chat/pipeline/message-normalizer';
import type {
  ChatItem,
  GatewayMessage,
  MessageGroup,
  UserMessageHistoryAction,
} from '@/libs/openclaw-chat/types';
import { configService } from '@/services/config';
import { i18nService } from '@/services/i18n';

import { renderChatAvatar } from './chat-avatar';
import { EditDiffMonacoController } from './edit-diff-monaco';
import { chatStyles } from './justdo-chat.styles';
import { renderMermaidSvg } from './mermaidRenderer';

const MERMAID_BUBBLE_MIN_WIDTH = 500;
const MERMAID_BUBBLE_MAX_WIDTH = 820;
const MERMAID_BUBBLE_HORIZONTAL_PADDING = 64;
const MINIMAP_VISIBLE_ENTRY_THRESHOLD = 2;
const MAX_SPEECH_AUDIO_BASE64_LENGTH = 64 * 1024 * 1024;

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

type PacedTerminalProjection = {
  sessionIdentity: string;
  turn: AssistantTurn;
  persistedMessages: GatewayMessage[];
};

@customElement('justdo-chat')
export class JustDoChatElement extends LitElement {
  private readonly streamingThinkingScrollHeights = new WeakMap<HTMLElement, number>();
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
  declare private localTtsAvailable: boolean;

  @state()
  declare private speechLoadingGroupKey: string | null;

  @state()
  declare private speechPlayingGroupKey: string | null;

  private readonly chatScrollController = new ChatScrollController(
    () => this.requestUpdate(),
    () => this._controller?.showOlderHistory() ?? false,
    () => this._controller?.showNewerHistory() ?? false,
  );
  private readonly assistantStreamPacer = new AssistantStreamPacer();
  private readonly streamRenderScheduler = new StreamRenderScheduler(() =>
    this.publishStreamFrame(),
  );
  private readonly persistedTimelineCache = new PersistedTimelineCache();
  private projectedActiveHistorySource: GatewayMessage[] | null = null;
  private projectedActiveTurnKey = '';
  private projectedActiveMessages: GatewayMessage[] = [];
  private peerFilteredHistorySource: GatewayMessage[] | null = null;
  private peerFilteredHistory: GatewayMessage[] = [];
  private peerPerspectiveHistory = new WeakMap<GatewayMessage[], GatewayMessage[]>();
  private readonly persistedTimelineRenderCache = new PersistedTimelineRenderCache();
  private readonly processSummaryTakeoverTracker = new ProcessSummaryTakeoverTracker();
  private readonly collapsedProcessSummaryTakeoverTracker = new ProcessSummaryTakeoverSetTracker();
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
  private mermaidScrollFrame: number | null = null;
  private minimapScrollFrame: number | null = null;
  private editDiffMonacoFrame: number | null = null;
  private activeTurnClockTimer: ReturnType<typeof setInterval> | null = null;
  private assistantStreamSessionIdentity: string | null = null;
  private pacedTerminalProjection: PacedTerminalProjection | null = null;
  private actionableUserEntryId: string | null = null;
  private userMessageHistoryActionsAvailable = false;
  private forkEligibilityMessages: GatewayMessage[] = [];

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
    this.userMessageEditor = null;
    this.openProcessSummaryKey = null;
    this.collapsedProcessSummaryKeys = new Set();
    this.currentMinimapKey = null;
    this.hoveredMinimapKey = null;
    this.editDiffModes = new Map();
    this.localTtsAvailable = false;
    this.speechLoadingGroupKey = null;
    this.speechPlayingGroupKey = null;
  }

  /** ChatController reference (preferred — connects directly to gateway) */
  private _controller: ChatController | null = null;
  private _controllerUnsubscribe: (() => void) | null = null;
  private _streamUnsubscribe: (() => void) | null = null;
  private activeSearchIndex = -1;

  get controller(): ChatController | null {
    return this._controller;
  }

  set controller(ctrl: ChatController | null) {
    if (this._controller === ctrl) return;
    this.stopSpeech();
    this.unsubscribeController();
    this._controller = ctrl;
    this.editDiffModes = new Map();
    if (ctrl) this.subscribeController(ctrl);
    void this.refreshLocalTtsStatus();
    this.requestUpdate();
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

  static styles = chatStyles;

  // ─── Rendering ──────────────────────────────────────────────────────────

  private messagesForPerspective(messages: GatewayMessage[]): GatewayMessage[] {
    if (this.peerPerspective) {
      let projected = this.peerPerspectiveHistory.get(messages);
      if (!projected) {
        // Incoming peer messages can carry the native assistant role. Project
        // their display side before timeline grouping, not only inside bubbles,
        // so they reset the local assistant's consecutive-message avatar slot.
        projected = messages.map(message =>
          isTrustedPeerInput(message) && message.role === 'assistant'
            ? { ...message, role: 'user' }
            : message,
        );
        this.peerPerspectiveHistory.set(messages, projected);
      }
      return projected;
    }
    if (this.peerFilteredHistorySource !== messages) {
      this.peerFilteredHistorySource = messages;
      this.peerFilteredHistory = messages.filter(message => !isTrustedPeerInput(message));
    }
    return this.peerFilteredHistory;
  }

  render(): TemplateResult {
    // Use controller state if available, otherwise use direct properties
    const ctrl = this._controller;
    const activeTurn = this.activeTurnForDisplay(ctrl);
    const terminalProjection =
      ctrl &&
      !ctrl.state.transcript.activeTurn &&
      this.pacedTerminalProjection?.sessionIdentity === this.assistantStreamSessionIdentityFor(ctrl)
        ? this.pacedTerminalProjection
        : null;
    const activePersistedMessages = this.messagesForPerspective(
      ctrl
        ? (terminalProjection?.persistedMessages ??
            (ctrl.state.visibleChatMessages as GatewayMessage[]))
        : this.messages,
    );
    const pendingMessage = (ctrl?.state.pendingUserMessage as GatewayMessage | null) ?? null;
    const activeTurnHistoryKey = activeTurn
      ? `${activeTurn.runId}:${activeTurn.status}:${[...activeTurn.toolById.keys()].join(
          ',',
        )}:${pendingMessage === null ? 'settled' : 'pending'}`
      : 'idle';
    if (
      this.projectedActiveHistorySource !== activePersistedMessages ||
      this.projectedActiveTurnKey !== activeTurnHistoryKey
    ) {
      this.projectedActiveHistorySource = activePersistedMessages;
      this.projectedActiveTurnKey = activeTurnHistoryKey;
      this.projectedActiveMessages = projectPersistedMessagesForActiveTurn(
        activePersistedMessages,
        activeTurn,
        pendingMessage,
      );
    }
    let messages = this.projectedActiveMessages;
    const persistedMessages = messages;
    this.forkEligibilityMessages = ctrl
      ? this.messagesForPerspective(ctrl.getLoadedMessages() as GatewayMessage[])
      : persistedMessages;
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
        () => projectPersistedTimeline(messages, persistedRunTimings),
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
      const activeTurnFooter = projectActiveTurnFooter(activeFooterTiming);
      const timelineView = projectIncrementalTimelineView({
        persisted: this.persistedTimelineRenderCache.get(historyTimeline),
        activeTimeline,
        suppressTrailingAssistantFooter: activeTurnFooter !== null || isStreaming,
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
        [
          ...timelineView.persistedRows.map(row => row.item),
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
            aria-busy=${
              activeTurn?.status === 'running' ||
              isStreaming ||
              this.assistantStreamPacer.hasPending()
            }
          >
            <div class="sr-only" role="status" aria-live="polite">
              ${activeTurn ? i18nService.t(this.activeTurnStatusKey(activeTurn)) : nothing}
            </div>
            ${repeat(
              timelineView.persistedRows,
              row => row.item.key,
              row => this.renderVisibleTimelineItem(row.item, row.showAvatar, row.showFooter),
            )}
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
                        ${this.activeTurnFooter(activeTurnFooter, messages, activeFooterTiming)}
                      </footer>
                    </section>
                  `
                : nothing
            }
            ${
              ctrl &&
              this.chatScrollController.state.mode === 'paused' &&
              this.chatScrollController.canScrollDown
                ? html`
                    <button
                      type="button"
                      class="new-messages-indicator"
                      data-jump-to-latest
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
    const thinkingMessages: unknown[] = [];
    const toolMessages: unknown[] = [];
    const streamSegments: Array<{ text: string; ts: number }> = [];
    const stream = this.stream;
    const thinkingStream = null;

    if (!isStreaming && !stream) {
      const historyTimeline = getHistoryTimeline();
      const visibleRows = prepareVisibleTimelineRows(historyTimeline);
      const minimapEntries = projectChatMinimapEntries(historyTimeline);
      this.resolveOpenProcessSummaryKey(
        visibleRows.map(row => row.item),
        'direct',
      );
      return html`
        <div class="chat-shell">
          ${this.renderMinimap(minimapEntries)}
          <div class="chat-container" role="log">
            ${repeat(
              visibleRows,
              row => row.item.key,
              row => this.renderVisibleTimelineItem(row.item, row.showAvatar, row.showFooter),
            )}
          </div>
        </div>
      `;
    }

    const hasAssistantStream = Boolean(stream && stream.trim().length > 0);
    const shouldKeepThinkingInTimeline = hasAssistantStream && toolMessages.length > 0;
    const thinkingMessagesForTimeline =
      hasAssistantStream && !shouldKeepThinkingInTimeline
        ? thinkingMessages.slice(0, -1)
        : thinkingMessages;
    const committedThinkingForStream =
      hasAssistantStream && !shouldKeepThinkingInTimeline
        ? this.extractThinkingText(thinkingMessages[thinkingMessages.length - 1])
        : null;
    const thinkingForStreamingGroup = thinkingStream ?? committedThinkingForStream;
    const timelineMessages =
      thinkingMessagesForTimeline.length > 0
        ? [...messages, ...(thinkingMessagesForTimeline as GatewayMessage[])]
        : messages;
    const shouldRenderWaitingStream =
      isStreaming &&
      !hasAssistantStream &&
      !thinkingStream &&
      toolMessages.length === 0 &&
      streamSegments.length === 0;
    // A pending turn without content is rendered explicitly below. Passing an
    // empty string into buildChatItems would create a second waiting bubble.
    const displayStream = shouldRenderWaitingStream ? null : stream;
    const items = this.buildItems(timelineMessages, toolMessages, streamSegments, displayStream);
    const hasLiveStreamItem = items.some(item => item.kind === 'stream' && item.isStreaming);
    const minimapEntries = projectChatMinimapEntries(
      getHistoryTimeline(),
      displayStream || thinkingForStreamingGroup,
    );
    // Always render the chat container — never show "No messages"
    return html`
      <div class="chat-shell">
        ${this.renderMinimap(minimapEntries)}
        <div class="chat-container" role="log" aria-busy=${isStreaming}>
          <div class="sr-only" role="status" aria-live="polite">
            ${shouldRenderWaitingStream ? i18nService.t('coworkRunStateStarting') : nothing}
          </div>
          ${this.renderItems(items, thinkingForStreamingGroup)}
          ${
            shouldRenderWaitingStream
              ? renderStreamingGroup('', this.streamStartedAt ?? Date.now(), null, {
                  showAvatar: !items.some(
                    item => item.kind === 'group' && item.role === 'assistant',
                  ),
                })
              : nothing
          }
          ${
            thinkingStream && !hasLiveStreamItem
              ? renderStreamingThinkingGroup(thinkingStream, {
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
    this.chatScrollController.disconnect();
    this.streamRenderScheduler.dispose();
    this.persistedTimelineCache.clear();
    this.persistedTimelineRenderCache.clear();
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
    if (this.mermaidScrollFrame !== null) cancelAnimationFrame(this.mermaidScrollFrame);
    this.mermaidScrollFrame = null;
    if (this.minimapScrollFrame !== null) cancelAnimationFrame(this.minimapScrollFrame);
    this.minimapScrollFrame = null;
    if (this.editDiffMonacoFrame !== null) cancelAnimationFrame(this.editDiffMonacoFrame);
    this.editDiffMonacoFrame = null;
    this.editDiffMonacoController.dispose();
    this.stopActiveTurnClock();
    this.unsubscribeController();
  }

  protected firstUpdated(): void {
    this.scheduleMinimapSync();
    requestAnimationFrame(() => void this.renderMermaidDiagrams());
  }

  protected willUpdate(): void {
    this.focusedProcessSummaryKeyBeforeRender =
      this.renderRoot?.querySelector<HTMLElement>('[data-process-summary-key]:focus')?.dataset
        .processSummaryKey ?? null;
    this.chatScrollController.beforeRender();
  }

  protected updated(changedProperties?: Map<string | number | symbol, unknown>): void {
    traceTimelineDom(this._controller?.state.sessionKey ?? '', this.shadowRoot);
    this.syncActiveTurnClock();
    if (changedProperties?.has('processSummariesExpanded')) {
      this.openProcessSummaryKey = null;
      this.renderedOpenProcessSummaryKey = null;
      this.collapsedProcessSummaryKeys = new Set();
      this.renderedCollapsedProcessSummaryKeys = new Set();
      this.collapsedProcessSummaryTakeoverTracker.clear();
    } else if (
      this.collapsedProcessSummaryKeys.size !== this.renderedCollapsedProcessSummaryKeys.size ||
      [...this.collapsedProcessSummaryKeys].some(
        key => !this.renderedCollapsedProcessSummaryKeys.has(key),
      )
    ) {
      this.collapsedProcessSummaryKeys = new Set(this.renderedCollapsedProcessSummaryKeys);
    }
    if (this.openProcessSummaryKey !== this.renderedOpenProcessSummaryKey) {
      const nextOpenKey = this.renderedOpenProcessSummaryKey;
      const shouldRestoreFocus =
        this.focusedProcessSummaryKeyBeforeRender === this.openProcessSummaryKey &&
        nextOpenKey !== null;
      this.openProcessSummaryKey = nextOpenKey;
      if (shouldRestoreFocus) {
        void this.updateComplete.then(() => {
          this.shadowRoot
            ?.querySelector<HTMLElement>(`[data-process-summary-key="${CSS.escape(nextOpenKey)}"]`)
            ?.focus();
        });
      }
    }
    this.focusedProcessSummaryKeyBeforeRender = null;
    const transcriptRevision =
      this._controller?.state.transcript.revision ??
      this.messages.length + (this.stream?.length ?? 0) + (this.activeTurn?.lastAgentSeq ?? 0);
    const displayActiveTurn = this.activeTurnForDisplay(this._controller);
    const activeContentDisplaySignature = this.searchQuery.trim()
      ? (displayActiveTurn?.items
          .filter(item => item.type === 'content')
          .map(
            item =>
              `${item.id}:${this.assistantStreamPacer.displayText(item.id, item.text).length}`,
          )
          .join('|') ?? '')
      : '';
    this.chatScrollController.afterRender(transcriptRevision);
    this.scrollStreamingThinkingToBottom();
    this.scheduleEditDiffMonacoSync();
    if (changedProperties?.has('searchQuery') || changedProperties?.has('searchCaseSensitive')) {
      this.activeSearchIndex = -1;
      this.clearSearchMarks();
    }
    const searchEnhancementKey = `${this.searchQuery}:${this.searchCaseSensitive}:${transcriptRevision}:${activeContentDisplaySignature}`;
    if (searchEnhancementKey !== this.lastSearchEnhancementKey) {
      this.lastSearchEnhancementKey = searchEnhancementKey;
      requestAnimationFrame(() => this.emitSearchMatchCount());
    }
    const completedContent =
      displayActiveTurn?.items.filter(
        item => item.type === 'content' && item.status !== 'streaming',
      ) ?? [];
    const completedContentKey = completedContent
      .map(item => `${item.id}:${item.lastSeq}`)
      .join('|');
    const completedContentPending = completedContent.some(item =>
      this.assistantStreamPacer.isPending(item.id),
    );
    const mermaidEnhancementKey = `${this.persistedTimelineCache.revision}:${completedContentKey}`;
    if (!completedContentPending && mermaidEnhancementKey !== this.lastMermaidEnhancementKey) {
      this.lastMermaidEnhancementKey = mermaidEnhancementKey;
      requestAnimationFrame(() => void this.renderMermaidDiagrams());
    }
    const minimapSyncKey = `${this.persistedTimelineCache.revision}:${this.persistedTimelineRenderCache.revision}:${this.minimapEntriesSignature}`;
    if (minimapSyncKey !== this.lastMinimapSyncKey) {
      this.lastMinimapSyncKey = minimapSyncKey;
      this.scheduleMinimapSync();
    }
  }

  private scrollStreamingThinkingToBottom(): void {
    const contents = this.renderRoot.querySelectorAll<HTMLElement>(
      '.chat-thinking--streaming .chat-thinking__content',
    );
    for (const content of contents) {
      const previousScrollHeight = this.streamingThinkingScrollHeights.get(content);
      if (previousScrollHeight !== content.scrollHeight) {
        content.scrollTop = content.scrollHeight;
        this.streamingThinkingScrollHeights.set(content, content.scrollHeight);
      }
    }
  }

  private syncActiveTurnClock(): void {
    const isRunning =
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
    items: ReadonlyArray<PersistedTimelineItem | ActiveTurnTimelineItem>,
    sessionIdentity: string,
  ): void {
    if (this.processSummarySessionIdentity !== sessionIdentity) {
      this.processSummaryTakeoverTracker.clear();
      this.collapsedProcessSummaryTakeoverTracker.clear();
      this.processSummarySessionIdentity = sessionIdentity;
      this.renderedOpenProcessSummaryKey = null;
      this.renderedCollapsedProcessSummaryKeys = new Set();
      return;
    }
    this.renderedOpenProcessSummaryKey = this.processSummaryTakeoverTracker.resolve(
      this.openProcessSummaryKey,
      items,
    );
    this.renderedCollapsedProcessSummaryKeys = this.processSummariesExpanded
      ? this.collapsedProcessSummaryTakeoverTracker.resolve(this.collapsedProcessSummaryKeys, items)
      : new Set();
  }

  private handleImageClick(event: Event): boolean {
    const image = event
      .composedPath()
      .find(
        node =>
          node instanceof HTMLImageElement &&
          (node.classList.contains('chat-bubble__image') ||
            node.classList.contains('markdown-inline-image')),
      ) as HTMLImageElement | undefined;
    if (!image) return false;

    event.preventDefault();
    event.stopPropagation();
    const src = image.currentSrc || image.src;
    if (src)
      window.dispatchEvent(
        new CustomEvent(IMAGE_PREVIEW_EVENT, { detail: { src, alt: image.alt } }),
      );
    return true;
  }

  private readonly handleMarkdownClick = (event: Event): void => {
    if (this.handleImageClick(event)) return;
    const element = event.composedPath().find(node => node instanceof HTMLElement) as
      HTMLElement | undefined;
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
      this.chatScrollController.jumpToLatest();
      return;
    }
    const copyTarget = event
      .composedPath()
      .find(node => node instanceof HTMLElement && node.classList.contains('code-block-copy')) as
      HTMLButtonElement | undefined;
    if (copyTarget) {
      event.preventDefault();
      event.stopPropagation();
      const code = copyTarget.dataset.code;
      if (code === undefined) return;
      void this.copyCodeBlock(copyTarget, code);
      return;
    }

    const target = event
      .composedPath()
      .find(node => node instanceof HTMLElement && node.classList.contains('mermaid-toggle')) as
      HTMLButtonElement | undefined;
    if (!target) return;

    const block = target.closest<HTMLElement>('.mermaid-block');
    if (!block) return;
    const showSource = !block.classList.contains('is-source');
    block.classList.toggle('is-source', showSource);
    const preview = block.querySelector<HTMLElement>('.mermaid-preview');
    const source = block.querySelector<HTMLElement>('.mermaid-source');
    const label = block.querySelector<HTMLElement>('.code-block-lang');
    if (preview) preview.hidden = showSource;
    if (source) source.hidden = !showSource;
    if (label) label.textContent = showSource ? 'mermaid' : 'mermaid (rendered)';
    const buttonLabel = i18nService.t(showSource ? 'renderDiagram' : 'showCode');
    target.setAttribute('aria-label', buttonLabel);
    target.title = buttonLabel;
  };

  private readonly handleInlineImageContextMenu = (event: Event): void => {
    const image = event
      .composedPath()
      .find(
        node =>
          node instanceof HTMLImageElement && node.classList.contains('markdown-inline-image'),
      ) as HTMLImageElement | undefined;
    if (!image) return;
    void showImageContextMenu(event, image.currentSrc || image.src);
  };

  private readonly handleTimelineKeyDown = (event: Event): void => {
    const keyboardEvent = event as KeyboardEvent;
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

  private readonly handleEditDiffToggle = (): void => {
    this.scheduleEditDiffMonacoSync();
  };

  private scheduleEditDiffMonacoSync(): void {
    if (this.editDiffMonacoFrame !== null) return;
    this.editDiffMonacoFrame = requestAnimationFrame(() => {
      this.editDiffMonacoFrame = null;
      void this.editDiffMonacoController.sync(this.renderRoot);
    });
  }

  private readonly handleMermaidVisibilityScroll = (): void => {
    if (this.mermaidScrollFrame !== null) return;
    this.mermaidScrollFrame = requestAnimationFrame(() => {
      this.mermaidScrollFrame = null;
      void this.renderMermaidDiagrams();
    });
  };

  private async copyCodeBlock(button: HTMLButtonElement, code: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(code);
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
      console.error('[JustDoChat] Failed to copy code block', error);
    }
  }

  private async renderMermaidDiagrams(): Promise<void> {
    const blocks = this.renderRoot.querySelectorAll<HTMLElement>(
      '.mermaid-block:not([data-mermaid-rendered])',
    );
    for (const block of blocks) {
      const hostRect = this.getBoundingClientRect();
      const blockRect = block.getBoundingClientRect();
      if (blockRect.bottom < hostRect.top || blockRect.top > hostRect.bottom) continue;
      block.dataset.mermaidRendered = 'true';
      const preview = block.querySelector<HTMLElement>('.mermaid-preview');
      const code = block.querySelector<HTMLElement>('.mermaid-source code')?.textContent;
      if (!preview || !code) continue;
      try {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: document.documentElement.classList.contains('dark') ? 'dark' : 'default',
        });
        const id = `justdo-mermaid-${crypto.randomUUID()}`;
        const svg = await renderMermaidSvg(id, code);
        preview.innerHTML = svg;
        this.resizeMermaidBubble(block, preview);
      } catch (error) {
        preview.classList.add('mermaid-error');
        preview.textContent =
          error instanceof Error ? error.message : i18nService.t('mermaidRenderFailed');
      }
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

  private subscribeController(ctrl: ChatController): void {
    this.seedAssistantStreamPacer(ctrl);
    this._controllerUnsubscribe = ctrl.subscribe(() => {
      this.captureAssistantStreamSnapshots(ctrl);
      this.requestUpdate();
      if (this.assistantStreamPacer.hasPending()) this.streamRenderScheduler.schedule();
    });
    this._streamUnsubscribe = ctrl.onStream(kind => {
      this.captureAssistantStreamSnapshots(ctrl);
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
    this.assistantStreamPacer.reset();
    this.assistantStreamSessionIdentity = null;
    this.pacedTerminalProjection = null;
  }

  private assistantStreamSessionIdentityFor(ctrl: ChatController): string {
    return normalizeTranscriptSessionKey(ctrl.state.sessionKey);
  }

  private seedAssistantStreamPacer(ctrl: ChatController): void {
    this.assistantStreamSessionIdentity = this.assistantStreamSessionIdentityFor(ctrl);
    this.pacedTerminalProjection = null;
    this.assistantStreamPacer.seed(this.readAssistantStreamSnapshots(ctrl));
  }

  private readAssistantStreamSnapshots(ctrl: ChatController): AssistantStreamSnapshot[] {
    const turn = ctrl.state.transcript.activeTurn;
    return (turn?.items ?? [])
      .filter(item => item.type === 'content')
      .map(item => ({
        id: item.id,
        text: item.text,
        flush:
          turn?.status !== 'running' ||
          item.status === 'interrupted' ||
          Boolean(item.followingToolCallId) ||
          (item.status === 'completed' && turn?.status === 'running'),
      }));
  }

  private captureAssistantStreamSnapshots(ctrl: ChatController): void {
    const sessionIdentity = this.assistantStreamSessionIdentityFor(ctrl);
    if (sessionIdentity !== this.assistantStreamSessionIdentity) {
      this.seedAssistantStreamPacer(ctrl);
      return;
    }

    const turn = ctrl.state.transcript.activeTurn;
    if (turn && this.pacedTerminalProjection?.turn !== turn) {
      this.pacedTerminalProjection = null;
    }
    if (!turn && this.pacedTerminalProjection && this.assistantStreamPacer.hasPending()) {
      return;
    }

    this.assistantStreamPacer.observe(this.readAssistantStreamSnapshots(ctrl));
    if (turn && turn.status !== 'running' && this.assistantStreamPacer.hasPending()) {
      this.pacedTerminalProjection = {
        sessionIdentity,
        turn,
        persistedMessages: [...(ctrl.state.visibleChatMessages as GatewayMessage[])],
      };
    } else if (!this.assistantStreamPacer.hasPending()) {
      this.pacedTerminalProjection = null;
    }
  }

  private publishStreamFrame(): void {
    let hasPendingAssistantText = false;
    if (typeof requestAnimationFrame === 'function') {
      hasPendingAssistantText = this.assistantStreamPacer.advance();
    } else {
      this.assistantStreamPacer.flushPending();
    }
    if (!hasPendingAssistantText && this.pacedTerminalProjection) {
      this.pacedTerminalProjection = null;
      if (!this._controller?.state.transcript.activeTurn) this.assistantStreamPacer.reset();
    }
    this.requestUpdate();
    if (hasPendingAssistantText) this.streamRenderScheduler.schedule();
  }

  public getSearchMatchCount(): number {
    return this.collectSearchMatches().length;
  }

  public navigateSearch(direction: 1 | -1): { index: number; total: number } {
    this.clearSearchMarks();
    const matches = this.collectSearchMatches();
    const total = matches.length;
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

    this.highlightSearchMatch(matches[this.activeSearchIndex]);
    return { index: this.activeSearchIndex, total };
  }

  public revealMessage(entryId: string): boolean {
    const normalizedEntryId = entryId.trim();
    if (!normalizedEntryId) return false;
    const rows = this.renderRoot.querySelectorAll<HTMLElement>('.chat-history-row[data-entry-id]');
    const target = [...rows].find(row => row.dataset.entryId === normalizedEntryId);
    if (!target) return false;
    target.classList.remove('chat-history-row--revealed');
    target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    requestAnimationFrame(() => target.classList.add('chat-history-row--revealed'));
    window.setTimeout(() => target.classList.remove('chat-history-row--revealed'), 1_900);
    return true;
  }

  private emitSearchMatchCount(): void {
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

  private collectSearchMatches(): Array<{ node: Text; start: number; end: number }> {
    const query = this.searchQuery.trim();
    const root = this.shadowRoot?.querySelector('.chat-container');
    if (!query || !root) return [];

    const matcher = new RegExp(this.escapeRegExp(query), this.searchCaseSensitive ? 'g' : 'gi');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent || !node.nodeValue) return NodeFilter.FILTER_REJECT;
        if (parent.closest('.chat-group__footer, button, input, textarea, select')) {
          return NodeFilter.FILTER_REJECT;
        }
        matcher.lastIndex = 0;
        return matcher.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });

    const matches: Array<{ node: Text; start: number; end: number }> = [];
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const text = node.nodeValue ?? '';
      matcher.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = matcher.exec(text))) {
        matches.push({ node, start: match.index, end: match.index + match[0].length });
        if (match[0].length === 0) matcher.lastIndex += 1;
      }
    }
    return matches;
  }

  private highlightSearchMatch(
    match: { node: Text; start: number; end: number } | undefined,
  ): void {
    this.clearSearchMarks();
    if (!match) return;

    const range = document.createRange();
    range.setStart(match.node, match.start);
    range.setEnd(match.node, match.end);

    const mark = document.createElement('span');
    mark.className = 'chat-search-mark';
    mark.dataset.justdoSearchMark = 'true';
    range.surroundContents(mark);
    this.expandSearchMatchContainers(mark);
    mark.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  }

  private expandSearchMatchContainers(mark: HTMLElement): void {
    let current: HTMLElement | null = mark;
    while (current) {
      const details: HTMLDetailsElement | null = current.closest('details');
      if (!details) return;
      details.open = true;
      current = details.parentElement;
    }
  }

  private clearSearchMarks(): void {
    const root = this.shadowRoot;
    if (!root) return;
    root.querySelectorAll<HTMLElement>('[data-justdo-search-mark="true"]').forEach(mark => {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark);
      parent.normalize();
    });
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
      durationMs: footer.durationMs,
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
    if (
      !entryId ||
      !isEntryAfterLatestPlanImplementationReset(this.forkEligibilityMessages, entryId)
    ) {
      return null;
    }
    return this.forkEligibilityMessages.some(message => openClawEntryId(message) === entryId)
      ? { entryId }
      : null;
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

  private renderVisibleTimelineItem(
    item: PersistedTimelineItem | ActiveTurnTimelineItem,
    showAvatar: boolean,
    showFooter: boolean,
  ): TemplateResult | typeof nothing {
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
      const isPersistedUserMessage = item.message.role?.toLowerCase() === 'user' && entryId;
      const canEditOrWithdraw =
        isPersistedUserMessage &&
        entryId === this.actionableUserEntryId &&
        isEntryAfterLatestPlanImplementationReset(this.forkEligibilityMessages, entryId) &&
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
          )}
        </div>
      `;
    }
    return renderTimelineItem(
      item,
      Date.now(),
      item.kind === 'process-summary' &&
        ((this.processSummariesExpanded &&
          !this.renderedCollapsedProcessSummaryKeys.has(item.key)) ||
          this.renderedOpenProcessSummaryKey === item.key),
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
            entries,
            entry => entry.key,
            entry => this.renderMinimapEntry(entry),
          )}
          ${tail ? this.renderMinimapEntry(tail) : nothing}
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
      12,
      5 + Math.ceil((entry.userText.length + entry.assistantText.length) / 64),
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

  private readonly handleMinimapScroll = (): void => {
    this.scheduleMinimapSync();
  };

  private scheduleMinimapSync(): void {
    if (this.minimapScrollFrame !== null) return;
    this.minimapScrollFrame = requestAnimationFrame(() => {
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
      const anchor = keyedAnchors.get(entry.anchorKey) ?? fallbackAnchors[index];
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
    if (!ctrl) return this.activeTurn;
    if (ctrl.state.transcript.activeTurn) return ctrl.state.transcript.activeTurn;
    if (
      this.pacedTerminalProjection?.sessionIdentity === this.assistantStreamSessionIdentityFor(ctrl)
    ) {
      return this.pacedTerminalProjection.turn;
    }
    return null;
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
    ).map(timelineItem => {
      if (timelineItem.kind !== 'content') return timelineItem;
      const visuallyStreaming = this.assistantStreamPacer.isPending(timelineItem.item.id);
      const text = this.assistantStreamPacer.displayText(
        timelineItem.item.id,
        timelineItem.item.text,
      );
      if (text === timelineItem.item.text && !visuallyStreaming) return timelineItem;
      return {
        ...timelineItem,
        item: {
          ...timelineItem.item,
          text,
          ...(visuallyStreaming ? { status: 'streaming' as const } : {}),
        },
      };
    });
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
        });
      }
      if (item.kind === 'divider') {
        const label = item.inProgress
          ? `${item.label} · ${formatActiveTurnDuration(Date.now() - item.timestamp)}`
          : item.label;
        if (item.expandable === false) {
          return html`
            <div class="chat-divider">
              <span class="chat-divider__summary" title=${item.description ?? label}>
                ${label}
              </span>
            </div>
          `;
        }
        const summary = item.summary?.trim() || i18nService.t('coworkCompactSummaryUnavailable');
        return html`
          <div class="chat-divider">
            <details class="chat-divider__details">
              <summary class="chat-divider__summary" title=${i18nService.t('coworkCompactDetails')}>
                ${label}
              </summary>
              <div class="chat-divider__content">${summary}</div>
            </details>
          </div>
        `;
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
            searchQuery: this.searchQuery,
            showAvatar: shouldRenderGroupAvatarByPrevItem(item as MessageGroup, prev),
            workingDirectory: this.workingDirectory,
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

  private extractThinkingText(message: unknown): string | null {
    const content = (message as Record<string, unknown> | undefined)?.content;
    if (!Array.isArray(content)) return null;

    const text = content
      .map(item => (item as Record<string, unknown> | undefined)?.thinking)
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n')
      .trim();
    return text || null;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'justdo-chat': JustDoChatElement;
  }
}
