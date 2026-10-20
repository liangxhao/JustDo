import type { AppSubmission } from '../../../../packages/app-plugin-sdk/contracts';
import { isAppWireValue } from '../../../../packages/app-plugin-sdk/contracts';
import type {
  AppMainRegistration,
  AppSubmissionParticipant,
} from '../../../../packages/app-plugin-sdk/main';
import { readAppInput } from '../../../../plugins/extensions/runtime-services/contracts/app-input';

export interface SessionParticipantSource {
  registrations(): readonly AppMainRegistration[];
  submissionIdentity(participant: AppSubmissionParticipant): AppSubmission;
  assertResourceOwners(ids: readonly string[]): void;
  confirmResourceDeletion(ids: readonly string[]): void;
  runSubmission<T>(
    participant: AppSubmissionParticipant,
    submission: AppSubmission | undefined,
    operation: () => T,
  ): T;
}

/** Product operations collect every participant before performing a destructive effect. */
export class AppSessionParticipants {
  private deletionLeases = 0;
  private packageMutation = false;
  private readonly admissions = new Map<
    string,
    { participant: AppSubmissionParticipant; identity: AppSubmission }[]
  >();
  constructor(private readonly source: SessionParticipantSource) {}

  isDeleting(id: string): boolean {
    return this.source.registrations().some(registration => registration.resources?.isDeleting(id));
  }

  isManaged(id: string): boolean {
    return this.source.registrations().some(registration => registration.resources?.isManaged(id));
  }

  expandResources(ids: readonly string[]): string[] {
    const result = new Set(ids);
    for (;;) {
      const size = result.size;
      for (const registration of this.source.registrations()) {
        for (const id of registration.resources?.expandResources([...result]) ?? []) {
          if (typeof id !== 'string' || !id || (!result.has(id) && result.size >= 4096))
            throw new Error('appPluginInvalidRequest');
          result.add(id);
        }
      }
      if (result.size === size) return [...result];
    }
  }

  acquireDeletion(ids: string[]): () => void {
    if (this.packageMutation) throw new Error('appPluginCleanupUnresolved');
    // Occupy the lease before calling plugin code, including synchronous callbacks.
    this.deletionLeases++;
    const releases: (() => void)[] = [];
    try {
      const cohort = this.expandResources(ids);
      this.source.assertResourceOwners(cohort);
      // All fences are acquired synchronously, before any native request or veto awaits.
      for (const registration of this.source.registrations()) {
        const release = registration.resources?.acquireDeletion(cohort);
        if (release) releases.push(release);
      }
    } catch (error) {
      try {
        releases.reverse().forEach(release => release());
      } finally {
        this.deletionLeases--;
      }
      throw error;
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      try {
        releases
          .splice(0)
          .reverse()
          .forEach(release => release());
      } finally {
        this.deletionLeases--;
      }
    };
  }

  /** Keep resource owners stable until all native package changes and reconnection finish. */
  async withPackageMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.packageMutation || this.deletionLeases) throw new Error('appPluginCleanupUnresolved');
    this.packageMutation = true;
    try {
      return await operation();
    } finally {
      this.packageMutation = false;
    }
  }

  async prepareDelete(ids: readonly string[]): Promise<void> {
    const cohort = this.expandResources(ids);
    for (const registration of this.source.registrations())
      await registration.resources?.prepareDelete(cohort);
  }

  async deleteManaged(id: string): Promise<boolean> {
    const cohort = this.expandResources([id]);
    // Preparation runs for the entire expanded cohort, including non-owning veto participants.
    await this.prepareDelete([id]);
    const owners = this.source
      .registrations()
      .filter(registration => registration.resources?.isManaged(id));
    if (owners.length > 1) throw new Error('appPluginResourceConflict');
    let handled = false;
    for (const registration of this.source.registrations()) {
      handled = ((await registration.resources?.deleteManaged(id)) ?? false) || handled;
    }
    if (handled) this.confirmDeleted(cohort);
    return handled;
  }
  confirmDeleted(ids: readonly string[]): void {
    this.source.confirmResourceDeletion(ids);
    for (const key of this.admissions.keys())
      if (ids.some(id => key.startsWith(`${id}:`))) this.admissions.delete(key);
  }

  matches(prompt: string, submission?: AppSubmission): boolean {
    const decoded = readAppInput(prompt)?.input;
    if (decoded && !isAppWireValue(decoded.input)) throw new Error('appPluginInvalidRequest');
    submission ??= decoded
      ? {
          pluginId: decoded.pluginId,
          epoch: decoded.epoch,
          mode: decoded.mode,
          input: decoded.input,
        }
      : undefined;
    return this.source
      .registrations()
      .some(registration => registration.submission?.matches(prompt, submission));
  }

  async register(input: {
    sessionId: string;
    clientTurnId: string;
    prompt: string;
    assertCurrent?: () => void;
    submission?: AppSubmission;
  }): Promise<void> {
    const decoded = readAppInput(input.prompt)?.input;
    if (
      decoded &&
      input.submission &&
      (decoded.pluginId !== input.submission.pluginId ||
        decoded.epoch !== input.submission.epoch ||
        decoded.mode !== input.submission.mode)
    )
      throw new Error('appPluginInvalidRequest');
    if (decoded && !isAppWireValue(decoded.input)) throw new Error('appPluginInvalidRequest');
    if (decoded)
      input = {
        ...input,
        submission: {
          pluginId: decoded.pluginId,
          epoch: decoded.epoch,
          mode: decoded.mode,
          input: decoded.input,
        },
      };
    const participants = this.source
      .registrations()
      .flatMap(registration =>
        registration.submission &&
        (!input.submission ||
          this.source.submissionIdentity(registration.submission).pluginId ===
            input.submission.pluginId) &&
        registration.submission.matches(input.prompt, input.submission)
          ? [registration.submission]
          : [],
      );
    if (input.submission && !participants.length) throw new Error('appPluginUnavailable');
    if (!participants.length) return;
    const key = `${input.sessionId}:${input.clientTurnId}`;
    if (this.admissions.has(key)) throw new Error('appPluginInvalidRequest');
    if (this.admissions.size >= 1024) throw new Error('appPluginCleanupUnresolved');
    const admitted: { participant: AppSubmissionParticipant; identity: AppSubmission }[] = [];
    this.admissions.set(key, admitted);
    for (const participant of participants) {
      const identity = this.source.submissionIdentity(participant);
      admitted.push({ participant, identity });
      await this.source.runSubmission(participant, input.submission ?? identity, () =>
        participant.register({
          ...input,
          assertActive: input.assertCurrent,
        }),
      );
    }
  }

  async markSubmissionStarted(id: string, turn: string): Promise<void> {
    const key = `${id}:${turn}`;
    const admitted = this.admissions.get(key);
    if (!admitted?.length) throw new Error('appPluginRetired');
    for (const entry of admitted) {
      await this.source.runSubmission(entry.participant, entry.identity, () =>
        entry.participant.markSubmissionStarted(id, turn),
      );
    }
    // This map binds only the send gate to its admitted epoch. Native outcomes
    // and cleanup remain in the participant's receipts, including unknown sends.
    if (this.admissions.get(key) === admitted) this.admissions.delete(key);
  }

  async abortBeforeSend(id: string, turn: string): Promise<boolean> {
    const results = await Promise.allSettled(
      this.source
        .registrations()
        .map(registration =>
          Promise.resolve().then(() => registration.submission?.abortBeforeSend(id, turn) ?? true),
        ),
    );
    if (results.some(result => result.status === 'rejected'))
      throw new Error('appPluginCleanupUnresolved');
    const result = results.every(result => result.status === 'fulfilled' && result.value === true);
    if (result) this.admissions.delete(`${id}:${turn}`);
    return result;
  }

  async cancel(id: string, turn?: string): Promise<void> {
    const results = await Promise.allSettled(
      this.source.registrations().map(registration => {
        try {
          // Close each local admission before returning to the native Stop caller.
          return Promise.resolve(registration.submission?.cancel(id, turn));
        } catch (error) {
          return Promise.reject(error);
        }
      }),
    );
    if (results.some(result => result.status === 'rejected'))
      throw new Error('appPluginCleanupUnresolved');
  }

  async releaseIfSettled(id: string): Promise<boolean> {
    let result = true;
    for (const registration of this.source.registrations())
      result = ((await registration.submission?.releaseIfSettled(id)) ?? true) && result;
    if (result)
      for (const key of this.admissions.keys())
        if (key.startsWith(`${id}:`)) this.admissions.delete(key);
    return result;
  }
}

/** Plugin cleanup cannot delay stopping the source execution. */
export function cancelSessionPluginsWithoutWaiting(
  getParticipants: (() => Pick<AppSessionParticipants, 'cancel'>) | undefined,
  sessionId: string,
  clientTurnId?: string,
): void {
  try {
    void getParticipants?.()
      .cancel(sessionId, clientTurnId)
      .catch((): void => undefined);
  } catch {
    // A plugin access or cleanup failure cannot prevent the native Stop.
  }
}
