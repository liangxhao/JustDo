/** Public projections and draft locators, independent of application implementation types. */
export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  model: string;
  icon: string;
  skillIds: string[];
  enabled: boolean;
  deletedAt?: number;
  isDefault: boolean;
}
export interface CoworkSessionSummary {
  id: string;
  title: string;
  status: 'idle' | 'running' | 'completed' | 'error';
  pinned: boolean;
  groupId?: string | null;
  agentId?: string;
  nativeSessionKey?: string;
  external?: unknown;
  source?: unknown;
  createdAt: number;
  updatedAt: number;
}
export type SessionDirectoryEntry = Omit<CoworkSessionSummary, 'title'>;
export interface CoworkSession extends Omit<CoworkSessionSummary, 'agentId'> {
  cwd: string;
  agentId: string;
  executionMode: 'local' | 'sandbox';
  permissionMode: 'ask' | 'auto' | 'full';
  activeSkillIds: string[];
  modelRef?: string;
  nativeParentSessionId?: string;
}
export type CoworkSessionStatus = CoworkSessionSummary['status'];
export type CoworkInteractionRequest = AppStateSnapshot['cowork']['pendingInteractions'][number];
export interface SessionRunTiming {
  id: string;
  sessionId: string;
  clientTurnId: string;
  rootRunId?: string;
  modelRef?: string;
  startedAt: number;
  acceptedAt?: number;
  endedAt?: number;
  state: 'running' | 'completed' | 'failed' | 'aborted';
}
export interface NativeMessageQuote {
  kind?: 'message';
  id: string;
  text: string;
  sessionKey: string;
  entryId: string;
  start?: number;
  end?: number;
}
export interface ExtensionMessageQuote {
  kind: 'extension';
  pluginId: string;
  /** Optional display label supplied by the owning plugin's translations. */
  labelKey?: string;
  id: string;
  text: string;
  context: string;
}
export type MessageQuote = NativeMessageQuote | ExtensionMessageQuote;
export interface CoworkAttachmentPayload {
  name: string;
  mimeType: string;
  base64Data: string;
}
export interface AppStateSnapshot {
  agent: { agents: AgentProfile[] };
  cowork: {
    sessions: CoworkSessionSummary[];
    sessionDirectory?: SessionDirectoryEntry[];
    currentSession: CoworkSession | null;
    sessionRunTimings: Record<string, SessionRunTiming[]>;
    pendingInteractions: {
      sessionId: string;
      toolName: string;
      toolInput: Record<string, unknown>;
      requestId: string;
      toolUseId?: string | null;
      interactionKind?: string;
    }[];
    draftPrompts: Record<string, string>;
    draftMessageQuotes: Record<string, { id: string; text: string; kind?: string }[]>;
    sessionRuntimeActivity: Record<string, boolean>;
  };
}
export interface AppSettingsNavigationRequest {
  initialTab: 'runtime';
}
export interface AppServices {
  navigation: {
    showSettings(options: AppSettingsNavigationRequest): void;
  };
  metadata: {
    getSnapshot(): AppStateSnapshot;
    subscribe(listener: () => void): () => void;
  };
  sessions: {
    ensureSummaries(ids: readonly string[]): Promise<boolean>;
    getDetails(id: string): Promise<{
      session: CoworkSession | null;
      stats?: unknown;
      gatewaySessionId?: string | null;
    }>;
    loadSession(
      id: string,
      options?: { canSelect?(): boolean; onSelected?(): void },
    ): Promise<CoworkSession | null>;
    onChanged(listener: () => void): () => void;
  };
  drafts: {
    addQuote(input: { draftKey: string; quote: MessageQuote }): void;
    setPrompt(input: { sessionId: string; draft: string }): void;
  };
  files: {
    selectDirectory(): Promise<{ success: boolean; path: string | null }>;
    selectFiles(options?: {
      title?: string;
      filters?: { name: string; extensions: string[] }[];
    }): Promise<{ success: boolean; paths: string[]; error?: string }>;
    readFileAsDataUrl(
      path: string,
    ): Promise<{ success: boolean; dataUrl?: string; error?: string }>;
  };
  stageAudio(
    source: string,
    workspace: string,
  ): Promise<{ success: boolean; path?: string; error?: string }>;
}
