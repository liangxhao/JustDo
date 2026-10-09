import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { NormalizedAgentEvent } from '../../../shared/openclaw/agentEvent';
import { matchesModelSelectionIdentity } from '../../../shared/providers/modelSelectionIdentity';
import type { CoworkStore } from '../../data/coworkStore';
import type {
  MulticaCodexBackend,
  MulticaCodexModel,
  MulticaCodexThread,
} from './multicaCodexSession';
import { MulticaCodexStreamError } from './multicaCodexSession';
import type {
  MulticaExternalSession,
  MulticaExternalSessionStore,
} from './multicaExternalSessionStore';

export interface MulticaCodexBackendOptions {
  getCoworkStore: () => CoworkStore;
  getExternalSessionStore: () => MulticaExternalSessionStore;
  getModels: () => MulticaCodexModel[];
  isEnabled: () => boolean;
  onSessionsChanged: () => void;
  execute: (input: {
    sessionId: string;
    runId: string;
    message: string;
    modelRef?: string;
    onEvent: (event: NormalizedAgentEvent) => void;
    signal: AbortSignal;
    onPrepared: (sessionKey: string) => void;
  }) => Promise<string>;
}

const canonicalDirectory = (value: string): string => {
  if (!path.isAbsolute(value) || !fs.statSync(value).isDirectory())
    throw new Error('Invalid task directory.');
  const resolved = fs.realpathSync(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Application-owned identity mappings only; OpenClaw owns all transcripts. */
export class MulticaCodexBackendFactory {
  private readonly active = new Set<string>();
  constructor(private readonly options: MulticaCodexBackendOptions) {}

  get activeTaskCount(): number {
    return this.active.size;
  }

  models(): MulticaCodexModel[] {
    if (!this.options.isEnabled()) throw new Error('Multica integration is disabled.');
    return this.options.getModels();
  }

  connect(cwd: string, env: Record<string, string>): MulticaCodexBackend {
    let task: { cwd: string; home: string; scope: string } | undefined;
    const context = () => {
      if (!this.options.isEnabled()) throw new Error('Multica integration is disabled.');
      if (task) return task;
      if (!env.MULTICA_TOKEN?.startsWith('mat_'))
        throw new Error('Multica task-scoped authentication is required.');
      for (const key of [
        'MULTICA_TASK_CONFIG_ROOT',
        'MULTICA_WORKSPACE_ID',
        'MULTICA_AGENT_ID',
        'MULTICA_TASK_ID',
        'MULTICA_SERVER_URL',
        'CODEX_HOME',
      ]) {
        if (!env[key]?.trim()) throw new Error(`Multica did not provide ${key}.`);
      }
      canonicalDirectory(env.MULTICA_TASK_CONFIG_ROOT);
      task = {
        cwd: canonicalDirectory(cwd),
        home: canonicalDirectory(env.CODEX_HOME),
        scope: createHash('sha256')
          .update(`${env.MULTICA_SERVER_URL}\0${env.MULTICA_WORKSPACE_ID}\0${env.MULTICA_AGENT_ID}`)
          .digest('hex')
          .slice(0, 32),
      };
      return task;
    };
    const externalKey = (id: string) => `codex:${context().scope}:${id}`;
    const get = (id: string): MulticaExternalSession => {
      if (!THREAD_ID.test(id)) throw new Error('Invalid thread identity.');
      const external = this.options.getExternalSessionStore().get(externalKey(id));
      if (!external || !this.options.getCoworkStore().getSession(external.coworkSessionId))
        throw new Error('The linked conversation is unavailable.');
      if (canonicalDirectory(external.cwd) !== context().cwd)
        throw new Error('A resumed thread cannot change its task directory.');
      const agent = this.options.getCoworkStore().getAgent(external.agentId);
      if (!agent?.enabled || agent.deletedAt)
        throw new Error('The selected assistant is unavailable.');
      return external;
    };
    const marker = (id: string) => {
      // Multica owns the sessions directory and may link it to its per-chat store.
      // Never overwrite an existing marker or follow a marker-file symlink.
      const directory = path.join(context().home, 'sessions');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const target = path.join(fs.realpathSync(directory), `rollout-justdo-${id}.jsonl`);
      const content = `${JSON.stringify({ type: 'session_meta', payload: { id, originator: 'justdo', cwd: context().cwd } })}\n`;
      try {
        fs.writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !fs.lstatSync(target).isFile())
          throw error;
        if (
          fs.statSync(target).size !== Buffer.byteLength(content) ||
          fs.readFileSync(target, 'utf8') !== content
        )
          throw new Error('The local thread marker has conflicting ownership.');
      }
    };
    const validateOptions = (params: { cwd?: string; model?: string }) => {
      const current = context();
      if (params.cwd && canonicalDirectory(params.cwd) !== current.cwd)
        throw new Error('Thread cwd must match the task process.');
    };
    const selectModel = (requested?: string, persisted?: string): string => {
      const models = this.models();
      let selected = requested || persisted || models.find(model => model.isDefault)?.id;
      if (!requested && persisted && !models.some(model => model.id === persisted)) {
        // Gateway confirmation can unwrap a built-in catalog route. Resume
        // through that route, while explicit client choices remain exact.
        const matches = models.filter(model => matchesModelSelectionIdentity(model.id, persisted));
        selected = matches.length === 1 ? matches[0].id : undefined;
      }
      if (!selected || !models.some(model => model.id === selected))
        throw new Error('The selected model is unavailable. Refresh the runtime model catalog.');
      return selected;
    };
    return {
      models: () => this.models(),
      start: async params => {
        validateOptions(params);
        const store = this.options.getCoworkStore();
        const agentId = 'main';
        const agent = store.getAgent(agentId);
        if (!agent?.enabled || agent.deletedAt)
          throw new Error('The selected assistant is unavailable.');
        const modelRef = selectModel(params.model);
        const id = randomUUID();
        const session = store.createSession(
          agent.name,
          context().cwd,
          'local',
          [],
          agentId,
          store.getConfig().permissionMode,
          modelRef,
        );
        try {
          this.options.getExternalSessionStore().create({
            externalSessionKey: externalKey(id),
            coworkSessionId: session.id,
            agentId,
            cwd: context().cwd,
            openclawSessionKey: '',
          });
          marker(id);
        } catch (error) {
          store.deleteSession(session.id);
          throw error;
        }
        this.options.getExternalSessionStore().setStatus(externalKey(id), 'completed');
        this.options.onSessionsChanged();
        return { id, cwd: context().cwd, agentId, modelRef };
      },
      resume: async (id, params) => {
        validateOptions(params);
        const external = get(id);
        const session = this.options.getCoworkStore().getSession(external.coworkSessionId)!;
        const modelRef = selectModel(params.model, session.modelRef);
        marker(id);
        return { id, cwd: external.cwd, agentId: external.agentId, modelRef };
      },
      run: async (thread: MulticaCodexThread, runId, message, onEvent, signal) => {
        const external = get(thread.id);
        if (this.active.has(external.externalSessionKey))
          throw new Error('This conversation already has an active task.');
        if (signal.aborted) throw new Error('Task cancelled.');
        const modelRef = selectModel(thread.modelRef);
        this.active.add(external.externalSessionKey);
        const externalStore = this.options.getExternalSessionStore();
        try {
          externalStore.setStatus(external.externalSessionKey, 'running');
          this.options.onSessionsChanged();
          const result = await this.options.execute({
            sessionId: external.coworkSessionId,
            runId,
            message,
            modelRef,
            onEvent,
            signal,
            onPrepared: key =>
              externalStore.setOpenClawSessionKey(external.externalSessionKey, key),
          });
          if (signal.reason instanceof MulticaCodexStreamError) throw signal.reason;
          externalStore.setStatus(
            external.externalSessionKey,
            signal.aborted ? 'cancelled' : 'completed',
          );
          return result;
        } catch (error) {
          externalStore.setStatus(
            external.externalSessionKey,
            signal.aborted && !(signal.reason instanceof MulticaCodexStreamError)
              ? 'cancelled'
              : 'error',
          );
          throw error;
        } finally {
          this.active.delete(external.externalSessionKey);
          this.options.onSessionsChanged();
        }
      },
    };
  }
}
