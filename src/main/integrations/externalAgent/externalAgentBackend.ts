import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  ExternalSessionSource,
  ExternalSessionStatus,
} from '../../../shared/integrations/externalSession';
import { matchesModelSelectionIdentity } from '../../../shared/providers/modelSelectionIdentity';
import type { CoworkStore } from '../../data/coworkStore';
import {
  type ExternalAgentBackend,
  ExternalAgentCancelledError,
  type ExternalAgentExecution,
  ExternalAgentExecutionOutcome,
  type ExternalAgentModel,
  ExternalAgentOutcomeUnknownError,
  ExternalAgentStreamError,
  type ExternalAgentThread,
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
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    return {
      models: () => this.models(),
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
          throw new Error('This conversation has an active or unconfirmed execution.');
        if (!SESSION_ID.test(runId)) throw new Error('Invalid execution identity.');
        if (external.executionRunId === runId || store().getSessionRunByClientTurnId(runId))
          throw new Error('This execution identity has already been used.');
        if (typeof message !== 'string' || !message.trim() || message.length > 2 * 1024 * 1024)
          throw new Error('The task must contain bounded text.');
        if (signal.aborted)
          throw new ExternalAgentCancelledError('Task cancelled before native submission.');
        const modelRef = selectModel(current.modelRef);
        const release = reserveExternalSession(external.coworkSessionId);
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
