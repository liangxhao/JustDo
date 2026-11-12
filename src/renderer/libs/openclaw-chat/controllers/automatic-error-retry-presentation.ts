import {
  AutomaticErrorRetryDisposition as Disposition,
  AutomaticErrorRetryPhase as Phase,
  type AutomaticErrorRetryPresentation,
} from '@shared/cowork/automaticErrorRetry';

import type { AssistantTurn } from '../model/chat-transcript-state';
import { isRetryFailureMessage, retryMessageRunId } from '../pipeline/automatic-error-retry-display';

type Binding = { sessionKey: string; nativeSessionId: string | null };
type RetryApi = {
  getAutomaticErrorRetry(sessionId: string): Promise<{
    success: boolean;
    presentation?: AutomaticErrorRetryPresentation | null;
    presentations?: AutomaticErrorRetryPresentation[];
  }>;
  onAutomaticErrorRetryChanged(callback: (value: AutomaticErrorRetryPresentation) => void): () => void;
};

const HYDRATION_TIMEOUT_MS = 5_000;
/** View-owned metadata projection. Never changes transcript state or execution outcomes. */
export class AutomaticErrorRetryPresentationController {
  private sessionId: string | null = null;
  private generation = 0;
  private snapshots = new Map<string, AutomaticErrorRetryPresentation>();
  private removeListener?: () => void;
  private hydrationTimer?: ReturnType<typeof setTimeout>;
  private loading = false;
  private api?: RetryApi;

  constructor(private readonly changed: () => void, private readonly readApi: () => RetryApi | undefined =
    () => typeof window === 'undefined' ? undefined : window.electron?.cowork) {}

  get hydrating(): boolean { return this.loading; }

  selectSession(sessionId: string | null): void {
    if (this.sessionId === sessionId) return;
    this.dispose();
    this.sessionId = sessionId;
    this.api = this.readApi();
    if (!sessionId || !this.api?.getAutomaticErrorRetry || !this.api.onAutomaticErrorRetryChanged) return;
    const generation = this.generation;
    this.loading = true;
    this.removeListener = this.api.onAutomaticErrorRetryChanged(value => this.accept(value));
    this.hydrationTimer = setTimeout(() => {
      if (generation !== this.generation) return;
      this.loading = false;
      this.changed();
    }, HYDRATION_TIMEOUT_MS);
    void this.api.getAutomaticErrorRetry(sessionId).then(result => {
      if (generation !== this.generation || sessionId !== this.sessionId) return;
      if (result.success) for (const value of result.presentations ??
        (result.presentation ? [result.presentation] : [])) this.accept(value);
    }).catch(() => {}).finally(() => {
      if (generation !== this.generation) return;
      clearTimeout(this.hydrationTimer);
      this.loading = false;
      this.changed();
    });
  }

  private accept(value: AutomaticErrorRetryPresentation): void {
    if (value.sessionId !== this.sessionId || !Number.isSafeInteger(value.revision) ||
      !Array.isArray(value.runs)) return;
    const previous = this.snapshots.get(value.chainId);
    if (previous && previous.revision >= value.revision) return;
    this.snapshots.set(value.chainId, value);
    this.changed();
  }

  hiddenRuns(binding: Binding, messages: unknown[], turn: AssistantTurn | null): ReadonlySet<string> {
    const hidden = new Set<string>();
    if (!binding.nativeSessionId) return hidden;
    const failedRuns = new Set(messages.filter(isRetryFailureMessage).map(retryMessageRunId));
    if (turn?.status === 'error') failedRuns.add(turn.runId);
    for (const snapshot of this.snapshots.values()) {
      for (const run of snapshot.runs) {
        if (run.sessionKey !== binding.sessionKey || run.nativeSessionId !== binding.nativeSessionId) continue;
        if (run.disposition === Disposition.Superseded || run.disposition === Disposition.Pending ||
            (run.disposition === Disposition.Candidate && failedRuns.has(run.runId))) {
          hidden.add(run.runId);
        }
      }
    }
    return hidden;
  }

  progress(binding: Binding, hiddenRuns: ReadonlySet<string>): AutomaticErrorRetryPresentation | undefined {
    return [...this.snapshots.values()].filter(value => value.runs.some(run =>
      run.sessionKey === binding.sessionKey && run.nativeSessionId === binding.nativeSessionId &&
      ([Phase.Checking, Phase.Preparing, Phase.Running].some(phase => phase === value.phase) ||
        (value.phase === Phase.Eligible && run.disposition === Disposition.Candidate && hiddenRuns.has(run.runId)) ||
        ((value.phase === Phase.Unknown || value.phase === Phase.Cancelled) && run.disposition === Disposition.Pending)),
    ),
    ).sort((a, b) => b.revision - a.revision)[0];
  }

  dispose(): void {
    this.generation++;
    this.removeListener?.();
    this.removeListener = undefined;
    clearTimeout(this.hydrationTimer);
    this.snapshots.clear();
    this.loading = false;
    this.sessionId = null;
  }
}
