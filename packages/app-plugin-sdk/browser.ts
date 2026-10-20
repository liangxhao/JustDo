import type { ComponentType, ReactNode } from 'react';

import type { AppPluginBridge, AppPluginSnapshot } from './contracts';
import type { AppServices, CoworkSessionSummary } from './application';

/** A mounted native view exposes guarded effects, never its controller or credentials. */
export interface AppNativeHistoryState {
  connected: boolean;
  sessionKey: string;
  nativeSessionId?: string;
  runId?: string;
  running: boolean;
  canStop?: boolean;
  ready?: boolean;
  supportsImages?(): boolean;
  readCurrent?(): AppNativeHistoryState | undefined;
  send?(input: {
    message: string;
    images: import('./application').CoworkAttachmentPayload[];
    clientTurnId: string;
    assertCurrent(): void;
    beforeSend(): Promise<void>;
  }): Promise<'accepted' | 'unknown'>;
}

export interface AppViewContext {
  session?: { id: string; title: string; cwd: string; agentId: string; status: string };
  sessionSummary?: CoworkSessionSummary;
  onInspectSession?(summary: CoworkSessionSummary): void;
  selection?: unknown;
  /** Changes on explicit workspace opening, including requests with no selection. */
  selectionRevision?: number;
  active?: boolean;
  openWorkspace?(contributionId: string, selection?: unknown): void;
  draft?: {
    append(text: string): void;
    focus(): void;
  };
  onClose?: () => void;
  /** A retained application page may expose itself through its current UI owner. */
  page?: { setVisible(visible: boolean): void };
  submitUserTurn?: {
    assertReady(): void;
    supportsImages(): boolean;
    send(input: {
      display: string;
      gateway: string;
      attachments: import('./application').CoworkAttachmentPayload[];
      clientTurnId: string;
      assertCurrent?(): void;
    }): Promise<boolean>;
    outcomeUnknown(): boolean;
  };
  onOpenSubtask?: (task: import('./rendering').Subtask, parentSessionId: string) => void;
  navigation?: {
    /** Pure shell navigation revision for retiring stale UI-only requests. */
    revision?: number;
    requestTransition(options?: {
      preserveTabs?: boolean;
      canCommit?(): boolean;
    }): Promise<boolean>;
    showChat(): void;
  };
}
export interface AppBrowserContribution {
  id: string;
  slot: string;
  labelKey: string;
  icon?: ReactNode;
  /** Declarative placement within a slot; equal orders retain registration order. */
  order?: number;
  /** Only session.details may replace or hide the owning session's product details. */
  detailsPresentation?(sessionId: string): 'replace' | 'append' | 'hidden';
  component: ComponentType<AppViewContext>;
}
export interface AppComposerMode {
  id: string;
  labelKey: string;
  descriptionKey?: string;
  /** Menu ordering is declarative and independent of plugin loading or enable order. */
  order?: number;
  group?: {
    id: string;
    labelKey: string;
    icon?: ReactNode;
    order?: number;
    backLabelKey?: string;
  };
  /** Shorthand for a group that uses the mode icon and default ordering. */
  groupLabelKey?: string;
  icon?: ReactNode;
  selectionLabelKey?: string;
  removeLabelKey?: string;
  selectionCaret?: 'preserve' | 'start';
  allowQueue?: boolean;
  ordinaryTurnOnly?: boolean;
  prepare(input: {
    prompt: string;
    sessionId?: string;
    options?: unknown;
    planModeEnabled?: boolean;
    queued?: boolean;
  }): Promise<{
    prompt: string;
    input?: unknown;
  }>;
  component?: ComponentType<{ onChange(value: unknown): void; value: unknown }>;
}
/** Plain local draft data, scoped to the current approved installed artifact hash. */
export interface AppUiState {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}
export interface AppBrowserHost {
  readonly plugin: AppPluginSnapshot;
  readonly signal: AbortSignal;
  /** Local memory survives business epoch changes. Never retain permissions or send callbacks. */
  readonly uiState: AppUiState;
  invoke<T = unknown>(command: string, ...args: unknown[]): Promise<T>;
  onEvent<T = unknown>(name: string, listener: (payload: T) => void): () => void;
  registerView(contribution: AppBrowserContribution): () => void;
  registerMode(mode: AppComposerMode): () => void;
  registerTranslations(dictionaries: {
    en: Record<string, string>;
    zh: Record<string, string>;
  }): () => void;
  t(key: string): string;
  readonly components: Record<string, ComponentType<Record<string, unknown>>>;
  renderHistory(input: Record<string, unknown>): ReactNode;
  openWorkspace(contributionId: string, sessionId: string, selection?: unknown): void;
  readonly application: AppServices;
  registerInteractionPresentation(
    resolve: (sessionKey: string) => { visible: boolean; label?: string } | undefined,
  ): () => void;
  interactionContextChanged(): void;
  onNavigation(listener: () => void): () => void;
  registerSessionPresentation(
    resolve: (sessionId: string) => AppSessionPresentation | undefined,
  ): () => void;
  /** Publish a complete successful activity snapshot. Retiring UI cannot prove execution ended. */
  publishSessionActivity(sessionIds: readonly string[]): void;
  registerMessagePresentation(presentation: AppMessagePresentation): () => void;
}
export interface AppMessagePresentation {
  replyMirror?(message: unknown): boolean;
  text?(source: string): string;
  nativeInput?(message: unknown): { senderLabel: string; senderId: string } | undefined;
}
/** UI hints never authorize a copy, deletion, native send, or history read. */
export interface AppSessionPresentation {
  summaryAvailable?: boolean;
  status?: 'idle' | 'running' | 'completed' | 'error';
  updatedAt?: number;
  copyAllowed?: boolean;
  exportAllowed?: boolean;
  titleSuffix?: string;
  deletionMessage?: string;
  diagnosticScopeLabel?: string;
  anchorSessionId?: string;
  workspace?: { contributionId: string; selection?: unknown };
}
export interface AppBrowserModule {
  register(host: AppBrowserHost): void | (() => void);
}
export type { AppPluginBridge };
