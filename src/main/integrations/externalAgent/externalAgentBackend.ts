import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  ExternalSessionSource,
  ExternalSessionStatus,
} from '../../../shared/integrations/externalSession';
import { matchesModelSelectionIdentity } from '../../../shared/providers/modelSelectionIdentity';
import type { CoworkSession, CoworkStore } from '../../data/coworkStore';
import { buildManagedSessionKey } from '../../openclaw/sessions/openclawSessionKeys';
import {
  type ExternalAgentBackend,
  ExternalAgentBusyError,
  ExternalAgentCancelledError,
  type ExternalAgentExecution,
  ExternalAgentExecutionOutcome,
  type ExternalAgentHistoryInput,
  type ExternalAgentHistorySnapshot,
  type ExternalAgentModel,
  ExternalAgentOutcomeUnknownError,
  ExternalAgentStreamError,
  type ExternalAgentThread,
  type ExternalAgentThreadMetadata,
} from './externalAgentTypes';
import { reserveExternalSession } from './externalSessionReservations';
import {
  ExternalExecutionState,
  type ExternalSession,
  type ExternalSessionStore,
} from './externalSessionStore';

export * from './externalAgentTypes';

export interface ExternalAgentBackendOptions {
  getCoworkStore: () => CoworkStore;
  getExternalSessionStore: () => ExternalSessionStore;
  getModels: () => ExternalAgentModel[];
  onSessionsChanged: () => void;
  execute: ExternalAgentExecution;
  readHistory?: (input: ExternalAgentHistoryInput) => Promise<ExternalAgentHistorySnapshot>;
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_THREAD_NAME_LENGTH = 500;

const canonicalDirectory = (value: string): string => {
  if (typeof value !== 'string' || !path.isAbsolute(value) || !fs.statSync(value).isDirectory())
    throw new Error('The task directory must be an existing absolute directory.');
  return fs.realpathSync(value);
};

const sameDirectory = (left: string, right: string): boolean =>
  process.platform === 'win32'
    ? canonicalDirectory(left).toLowerCase() === canonicalDirectory(right).toLowerCase()
    : canonicalDirectory(left) === canonicalDirectory(right);

/** Current OS user/profile access comes from the authenticated local bridge. */
export class ExternalAgentBackendFactory {
  private readonly active = new Set<string>();

  constructor(private readonly options: ExternalAgentBackendOptions) {}

  get activeTaskCount(): number {
    return Math.max(this.active.size, this.options.getExternalSessionStore().countUnsettled());
  }

  models(): ExternalAgentModel[] {
    return this.options.getModels();
  }

  connect(): ExternalAgentBackend {
    const store = () => this.options.getCoworkStore();
    const externalStore = () => {
      const result = this.options.getExternalSessionStore();
      if (result.source !== ExternalSessionSource.Cli)
        throw new Error('The CLI conversation namespace is unavailable.');
      return result;
    };
    const get = (id: string): ExternalSession => {
      if (!SESSION_ID.test(id)) throw new Error('Invalid external conversation identity.');
      const external = externalStore().get(id);
      const session = external && store().getSession(external.coworkSessionId);
      if (
        !external ||
        !session ||
        session.agentId !== external.agentId ||
        !sameDirectory(session.cwd, external.cwd)
      )
        throw new Error('The linked conversation is unavailable or its ownership changed.');
      const agent = store().getAgent(external.agentId);
      if (!agent?.enabled || agent.deletedAt)
        throw new Error('The selected assistant is unavailable.');
      return external;
    };
    const selectModel = (requested?: string, persisted?: string): string => {
      const models = this.models();
      let selected = requested || persisted || models.find(model => model.isDefault)?.id;
      if (!requested && persisted && !models.some(model => model.id === persisted)) {
        const matches = models.filter(model => matchesModelSelectionIdentity(model.id, persisted));
        selected = matches.length === 1 ? matches[0].id : undefined;
      }
      if (!selected || !models.some(model => model.id === selected))
        throw new Error('The selected model is unavailable. Refresh the runtime model catalog.');
      return selected;
    };
    const thread = (
      id: string,
      external: ExternalSession,
      modelRef: string,
    ): ExternalAgentThread => ({ id, cwd: external.cwd, agentId: external.agentId, modelRef });
    const metadata = (
      external: ExternalSession,
      session: CoworkSession,
    ): ExternalAgentThreadMetadata => ({
      id: external.externalSessionKey,
      name: session.title,
      cwd: session.cwd,
      agentId: session.agentId,
      ...(session.modelRef ? { modelRef: session.modelRef } : {}),
      createdAt: session.createdAt,
      updatedAt: Math.max(session.updatedAt, external.updatedAt),
      permissionMode: session.permissionMode,
      status: external.status,
      ...(external.executionState ? { executionState: external.executionState } : {}),
    });
    return {
      models: () => this.models(),
      describe: id => {
        const external = get(id);
        return metadata(external, store().getSession(external.coworkSessionId)!);
      },
      list: () => externalStore().list().flatMap(external => {
        if (!SESSION_ID.test(external.externalSessionKey)) return [];
        // Keep database failures visible. Only unavailable filesystem identities
        // below are filtered along with stale/deleted product metadata.
        const session = store().getSession(external.coworkSessionId);
        if (!session || session.agentId !== external.agentId) return [];
        const agent = store().getAgent(external.agentId);
        if (!agent?.enabled || agent.deletedAt) return [];
        try {
          if (!sameDirectory(session.cwd, external.cwd)) return [];
        } catch {
          return [];
        }
        return [metadata(external, session)];
      }),
      setName: (id, name) => {
        if (typeof name !== 'string' || !name.trim() || name.trim().length > MAX_THREAD_NAME_LENGTH)
          throw new Error('The thread name must contain 1 to 500 characters.');
        const external = get(id);
        store().updateSession(external.coworkSessionId, { title: name.trim() });
        this.options.onSessionsChanged();
      },
      history: async id => {
        const productIdentity = (external: ExternalSession): string => {
          const session = store().getSession(external.coworkSessionId)!;
          const key = session.nativeSessionKey ?? session.historyBinding?.sessionKey ??
            buildManagedSessionKey(session.id, session.agentId);
          if (external.openclawSessionKey && key !== external.openclawSessionKey)
            throw new Error('Native history does not match the product conversation binding.');
          if (session.historyBinding && (
            session.historyBinding.sessionKey !== external.openclawSessionKey ||
            session.historyBinding.nativeSessionId !== external.nativeSessionId
          ))
            throw new Error('Native history does not match the product conversation binding.');
          return JSON.stringify([
            session.nativeSessionKey ?? null, session.historyBinding ?? null,
            session.nativeParentSessionId ?? null,
          ]);
        };
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const before = get(id);
          const runs = store().getSessionRuns(before.coworkSessionId);
          const productBefore = productIdentity(before);
          if (!before.openclawSessionKey || !before.nativeSessionId || !before.lifecycleRevision) {
            const session = store().getSession(before.coworkSessionId)!;
            if (!runs.length && !before.executionRunId && !session.nativeSessionKey && !session.historyBinding)
              return { threadId: id, messages: [], runs: [] };
            throw new Error('Native history identity is unavailable.');
          }
          if (!this.options.readHistory) throw new Error('Authenticated native history is unavailable.');
          const history = await this.options.readHistory({
            sessionKey: before.openclawSessionKey,
            nativeSessionId: before.nativeSessionId,
            lifecycleRevision: before.lifecycleRevision,
          });
          const after = get(id);
          if (
            before.coworkSessionId !== after.coworkSessionId || before.agentId !== after.agentId ||
            before.cwd !== after.cwd || before.openclawSessionKey !== after.openclawSessionKey ||
            before.nativeSessionId !== after.nativeSessionId || before.lifecycleRevision !== after.lifecycleRevision ||
            productBefore !== productIdentity(after)
          )
            throw new Error('Native history identity changed during the read.');
          if (
            JSON.stringify(runs) !== JSON.stringify(store().getSessionRuns(after.coworkSessionId)) ||
            before.executionRunId !== after.executionRunId || before.executionState !== after.executionState ||
            before.status !== after.status
          ) {
            if (attempt === 0) continue;
            throw new Error('Native history changed during the read. Please read it again.');
          }
          return {
            threadId: id,
            messages: history.messages,
            runs,
            ...(after.executionRunId ? { latestExternalRunId: after.executionRunId } : {}),
            identityRevision: createHash('sha256').update(JSON.stringify([
              before.openclawSessionKey, before.nativeSessionId, before.lifecycleRevision,
            ])).digest('base64url'),
            ...(after.executionState === ExternalExecutionState.Unknown && after.executionRunId
              ? { unknownRunId: after.executionRunId } : {}),
          };
        }
        throw new Error('Native history could not be verified.');
      },
      start: async params => {
        const cwd = canonicalDirectory(params.cwd);
        const agentId = params.agentId || 'main';
        const agent = store().getAgent(agentId);
        if (!agent?.enabled || agent.deletedAt)
          throw new Error('The selected assistant is unavailable.');
        const modelRef = selectModel(params.model);
        const id = randomUUID();
        const session = store().createSession(
          agent.name,
          cwd,
          'local',
          [],
          agentId,
          store().getConfig().permissionMode,
          modelRef,
        );
        const created = { id, cwd, agentId, modelRef };
        try {
          externalStore().create({
            externalSessionKey: id,
            coworkSessionId: session.id,
            agentId,
            cwd,
            openclawSessionKey: '',
          });
          externalStore().setStatus(id, ExternalSessionStatus.Completed);
          params.onCreated?.(created);
        } catch (error) {
          store().deleteSession(session.id);
          throw error;
        }
        this.options.onSessionsChanged();
        return created;
      },
      resume: async (id, params) => {
        const external = get(id);
        if (params.cwd && !sameDirectory(params.cwd, external.cwd))
          throw new Error('A resumed conversation cannot change its task directory.');
        const session = store().getSession(external.coworkSessionId)!;
        return thread(id, external, selectModel(params.model, session.modelRef));
      },
      run: async (current, runId, message, onEvent, signal, hooks) => {
        const external = get(current.id);
        if (current.agentId !== external.agentId || !sameDirectory(current.cwd, external.cwd))
          throw new Error('The external conversation binding changed.');
        if (
          external.status === ExternalSessionStatus.Running ||
          external.executionState === ExternalExecutionState.Unknown
        )
          throw new ExternalAgentBusyError('This conversation has an active or unconfirmed execution.');
        if (!SESSION_ID.test(runId)) throw new Error('Invalid execution identity.');
        if (external.executionRunId === runId || store().getSessionRunByClientTurnId(runId))
          throw new Error('This execution identity has already been used.');
        if (typeof message !== 'string' || !message.trim() || message.length > 2 * 1024 * 1024)
          throw new Error('The task must contain bounded text.');
        if (signal.aborted)
          throw new ExternalAgentCancelledError('Task cancelled before native submission.');
        const modelRef = selectModel(current.modelRef);
        let release: () => void;
        try {
          release = reserveExternalSession(external.coworkSessionId);
        } catch {
          throw new ExternalAgentBusyError('This conversation already has an active task.');
        }
        const receipts = externalStore();
        let unconfirmed = false;
        let started = false;
        let outcome: ExternalAgentExecutionOutcome | undefined;
        const terminalStatus = () =>
          outcome === ExternalAgentExecutionOutcome.Completed
            ? ExternalSessionStatus.Completed
            : outcome === ExternalAgentExecutionOutcome.Cancelled
              ? ExternalSessionStatus.Cancelled
              : ExternalSessionStatus.Error;
        this.active.add(external.coworkSessionId);
        try {
          receipts.beginExecution(current.id, runId);
          started = true;
          this.options.onSessionsChanged();
          const result = await this.options.execute({
            sessionId: external.coworkSessionId,
            runId,
            message,
            modelRef,
            onEvent,
            signal,
            ...(external.openclawSessionKey &&
            external.nativeSessionId &&
            external.lifecycleRevision
              ? {
                  expectedBinding: {
                    sessionKey: external.openclawSessionKey,
                    sessionId: external.nativeSessionId,
                    lifecycleRevision: external.lifecycleRevision,
                  },
                }
              : {}),
            hooks: {
              ...(hooks?.interactiveApprovals === true ? { interactiveApprovals: true } : {}),
              onPrepared: async binding => {
                receipts.bindExecution(current.id, runId, binding);
                return hooks?.onPrepared?.(binding);
              },
            },
            onUnconfirmed: () => receipts.markExecutionUnknown(current.id, runId),
            onSettled: settled => {
              outcome = settled;
            },
          });
          outcome ??= ExternalAgentExecutionOutcome.Completed;
          if (signal.reason instanceof ExternalAgentStreamError) throw signal.reason;
          receipts.finishExecution(current.id, runId, terminalStatus());
          return result;
        } catch (error) {
          unconfirmed = error instanceof ExternalAgentOutcomeUnknownError && !outcome;
          if (started && unconfirmed) receipts.markExecutionUnknown(current.id, runId);
          else if (started)
            receipts.finishExecution(
              current.id,
              runId,
              outcome
                ? terminalStatus()
                : error instanceof ExternalAgentCancelledError
                  ? ExternalSessionStatus.Cancelled
                  : ExternalSessionStatus.Error,
            );
          throw error;
        } finally {
          if (!unconfirmed) {
            this.active.delete(external.coworkSessionId);
            release();
          }
          this.options.onSessionsChanged();
        }
      },
    };
  }
}
