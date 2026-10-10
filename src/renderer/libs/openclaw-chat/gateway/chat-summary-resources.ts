import {
  ArtifactRpcMethod,
  type ArtifactsListResult,
  type ArtifactSummary,
} from '@shared/openclaw/artifacts';

import {
  projectSessionSummaryResources,
  type SessionSummaryResources,
} from '../model/session-summary-resources';

interface ResourceState {
  sessionKey: string;
  connected: boolean;
  ready: boolean;
  running: boolean;
  messages: readonly unknown[];
  client: { request<T>(method: string, params: Record<string, unknown>): Promise<T> } | null;
}

/** Debounced metadata reads share the chat's authenticated client and history owner. */
export class ChatSummaryResourceObserver {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private disposed = false;
  private scope = '';
  private client: ResourceState['client'] = null;
  private artifacts: ArtifactSummary[] = [];
  private requestKey = '';
  private loading = false;
  private unavailable = false;
  private omittedOversized = false;
  private published = '';
  private messageIdentities = new WeakMap<object, number>();
  private nextIdentity = 0;
  private projectionKey = '';
  private projectionArtifacts: ArtifactSummary[] | null = null;
  private projected: Pick<SessionSummaryResources, 'outputs' | 'sources'> = {
    outputs: [],
    sources: [],
  };

  constructor(
    private readonly read: () => ResourceState,
    private readonly onChange: (snapshot: SessionSummaryResources) => void,
  ) {}

  publish = (): void => {
    if (this.disposed) return;
    const state = this.read();
    if (state.sessionKey !== this.scope || state.client !== this.client || !state.connected) {
      this.generation++;
      this.scope = state.sessionKey;
      this.client = state.client;
      this.artifacts = [];
      this.requestKey = '';
      this.loading = false;
      this.unavailable = false;
      this.omittedOversized = false;
      this.emit(state);
    }
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, 500);
  };

  retry = (): void => {
    this.requestKey = '';
    this.publish();
  };

  private emit(state: ResourceState): void {
    const projectionKey = state.ready ? this.historyKey(state) : '';
    if (projectionKey !== this.projectionKey || this.artifacts !== this.projectionArtifacts) {
      this.projectionKey = projectionKey;
      this.projectionArtifacts = this.artifacts;
      this.projected = projectSessionSummaryResources(
        state.ready ? state.messages : [],
        this.artifacts,
      );
    }
    const snapshot: SessionSummaryResources = {
      sessionKey: state.sessionKey,
      ...this.projected,
      outputsLoading: this.loading,
      outputsUnavailable: this.unavailable,
      omittedOversized: this.omittedOversized,
    };
    const key = JSON.stringify(snapshot);
    if (key === this.published) return;
    this.published = key;
    this.onChange(snapshot);
  }

  private async refresh(): Promise<void> {
    const state = this.read();
    if (this.disposed) return;
    this.emit(state);
    if (!state.connected || !state.ready || !state.client) return;
    const key = JSON.stringify([this.historyKey(state), state.running]);
    if (key === this.requestKey) return;
    this.requestKey = key;
    const generation = ++this.generation;
    this.loading = true;
    this.emit(state);
    try {
      const result = await state.client.request<ArtifactsListResult>(ArtifactRpcMethod.LIST, {
        sessionKey: state.sessionKey,
        messageRole: 'assistant',
      });
      if (!this.isCurrent(state, generation)) return;
      if (!Array.isArray(result.artifacts)) throw new Error('Invalid artifact metadata');
      this.artifacts = result.artifacts;
      this.omittedOversized = result.omittedOversized === true;
      this.unavailable = false;
    } catch {
      if (!this.isCurrent(state, generation)) return;
      this.unavailable = true;
    } finally {
      if (this.isCurrent(state, generation)) {
        this.loading = false;
        this.emit(this.read());
      }
    }
  }

  private historyKey(state: ResourceState): string {
    const identities = state.messages.map(message => {
      if (!message || typeof message !== 'object') return 0;
      let identity = this.messageIdentities.get(message);
      if (identity === undefined) {
        identity = ++this.nextIdentity;
        this.messageIdentities.set(message, identity);
      }
      return identity;
    });
    return JSON.stringify([state.sessionKey, identities]);
  }

  private isCurrent(state: ResourceState, generation: number): boolean {
    const current = this.read();
    return (
      !this.disposed &&
      generation === this.generation &&
      current.connected &&
      state.sessionKey === current.sessionKey &&
      state.client === current.client
    );
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    clearTimeout(this.timer);
  }
}
