import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { AutomaticErrorRetryDisposition as Disposition } from '../../../shared/cowork/automaticErrorRetry';
import { ExternalSessionSource, ExternalSessionStatus } from '../../../shared/integrations/externalSession';
import { OpenClawProviderId } from '../../../shared/providers/constants';
import { getLanguage, setLanguage, t } from '../../core/i18n';
import { CoworkStore } from '../../data/coworkStore';
import { SqliteStore } from '../../data/sqliteStore';
import { buildManagedSessionKey } from '../../openclaw/sessions/openclawSessionKeys';
import {
  ExternalAgentBackendFactory,
  ExternalAgentBusyError,
  ExternalAgentCancelledError,
  ExternalAgentOutcomeUnknownError,
  ExternalAgentStreamError,
} from './externalAgentBackend';
import type { ExternalAgentExecution } from './externalAgentTypes';
import { reserveExternalSession } from './externalSessionReservations';
import { ExternalSessionStore } from './externalSessionStore';

const cleanup: Array<() => void> = [];
const initialLanguage = getLanguage();
afterEach(() => {
  cleanup.splice(0).forEach(dispose => dispose());
  setLanguage(initialLanguage);
});

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'external-agent-backend-'));
  const sqlite = SqliteStore.create(cwd);
  cleanup.push(() => {
    sqlite.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const store = new CoworkStore(sqlite.getDatabase());
  const external = new ExternalSessionStore(sqlite.getDatabase());
  const models = [
    { id: 'provider/default', name: 'Default model', isDefault: true },
    { id: 'other/selected', name: 'Selected model', isDefault: false },
  ];
  const execute = vi.fn<ExternalAgentExecution>(async () => 'Answer');
  const onSessionsChanged = vi.fn();
  const options = {
    getCoworkStore: () => store,
    getExternalSessionStore: () => external,
    getModels: () => models,
    execute,
    onSessionsChanged,
  };
  const factory = new ExternalAgentBackendFactory(options);
  return {
    cwd,
    sqlite,
    store,
    external,
    models,
    execute,
    onSessionsChanged,
    factory,
    options,
    backend: factory.connect(),
  };
}

it('uses the application session ID across clients without client credentials or rollout markers', async () => {
  const f = fixture();
  const other = path.join(f.cwd, '另一个 项目');
  fs.mkdirSync(other);
  const onCreated = vi.fn();
  const first = await f.backend.start({ cwd: f.cwd, onCreated });
  const second = await f.backend.start({ cwd: other, model: 'other/selected' });
  expect(first.id).not.toBe(second.id);
  expect(f.store.getSession(first.id)?.id).toBe(first.id);
  expect(f.external.get(first.id)?.coworkSessionId).toBe(first.id);
  expect(onCreated).toHaveBeenCalledExactlyOnceWith(first);
  expect(second.cwd).toBe(fs.realpathSync(other));
  expect(f.store.listSessions().every(session => session.external?.origin === 'cli')).toBe(true);
  expect(fs.existsSync(path.join(f.cwd, 'sessions'))).toBe(false);
  await expect(f.factory.connect().resume(first.id, {})).resolves.toEqual(first);
  await expect(f.backend.resume(first.id, { cwd: other })).rejects.toThrow('directory');
  await expect(f.backend.resume('agent:main:native-key', {})).rejects.toThrow('identity');
  expect(second.modelRef).toBe('other/selected');
  expect(f.execute).not.toHaveBeenCalled();
});

it('keeps existing external IDs without treating their application IDs as resume aliases', async () => {
  const f = fixture();
  const session = f.store.createSession('Existing client task', f.cwd, 'local', [], 'main', 'ask', 'provider/default');
  const previousThreadId = randomUUID();
  f.external.create({
    externalSessionKey: previousThreadId, coworkSessionId: session.id,
    agentId: session.agentId, cwd: session.cwd, openclawSessionKey: '',
  });
  f.external.setStatus(previousThreadId, ExternalSessionStatus.Completed);
  const backend = f.factory.connect();

  const resumed = await backend.resume(previousThreadId, {});
  expect(resumed.id).toBe(previousThreadId);
  expect(backend.list!().map(thread => thread.id)).toEqual([previousThreadId]);
  await expect(backend.history!(previousThreadId)).resolves.toMatchObject({ threadId: previousThreadId, messages: [] });
  await expect(backend.resume(session.id, {})).rejects.toThrow('unavailable');
  const runId = randomUUID();
  await backend.run(resumed, runId, 'Continue the task', vi.fn(), new AbortController().signal);
  expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ sessionId: session.id, runId }));
});

it('requires an external mapping even when thread and application IDs use the same format', async () => {
  const f = fixture();
  const desktopSession = f.store.createSession('Desktop task', f.cwd);
  await expect(f.backend.resume(desktopSession.id, {})).rejects.toThrow('unavailable');
  const thread = await f.backend.start({ cwd: f.cwd });

  f.store.deleteSession(thread.id);

  expect(f.external.get(thread.id)).toBeNull();
  expect(f.external.wasDeleted(thread.id)).toBe(true);
  await expect(f.factory.connect().resume(thread.id, {})).rejects.toThrow('unavailable');
});

it('rolls back the new shared ID when creation metadata setup fails', async () => {
  const f = fixture();
  let createdId: string | undefined;

  await expect(f.backend.start({ cwd: f.cwd, onCreated: thread => {
    createdId = thread.id;
    expect(f.store.getSession(thread.id)?.id).toBe(thread.id);
    throw new Error('Cannot save client metadata');
  } })).rejects.toThrow('Cannot save client metadata');

  expect(createdId).toBeDefined();
  expect(f.store.getSession(createdId!)).toBeNull();
  expect(f.external.get(createdId!)).toBeNull();
  expect(f.external.wasDeleted(createdId!)).toBe(true);
  expect(f.execute).not.toHaveBeenCalled();
});

it('passes real image-only attachments to execution without inventing prompt text or changing text-only callers', async () => {
  const f = fixture();
  const thread = await f.backend.start({ cwd: f.cwd });
  const attachments = [{ name: 'image.png', mimeType: 'image/png', base64Data: 'aW1hZ2U=' }];
  await expect(f.backend.run(thread, randomUUID(), '', vi.fn(), new AbortController().signal, { attachments }))
    .resolves.toBe('Answer');
  expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ message: '', attachments }));
  await expect(f.backend.run(thread, randomUUID(), '', vi.fn(), new AbortController().signal))
    .rejects.toThrow('bounded text');
});

it('names a new conversation from the first nonempty message line and retains it across connections', async () => {
  const f = fixture();
  const agent = f.store.saveAgentProfile({
    id: 'reviewer', name: 'Reviewer', description: '', icon: '', model: '', enabled: true, isDefault: false,
  });
  const thread = await f.backend.start({ cwd: f.cwd, agentId: agent.id });
  expect(f.backend.describe!(thread.id).name).toBe(t('externalAgentNewSession'));
  const sessionId = f.external.get(thread.id)!.coworkSessionId;
  const expectedTitle = 'Review changes 😀';
  const titles: string[] = [];
  f.onSessionsChanged.mockImplementation(() => titles.push(f.store.getSession(sessionId)!.title));
  f.execute.mockImplementation(async () => {
    expect(f.store.getSession(sessionId)!.title).toBe(expectedTitle);
    return 'Answer';
  });

  await f.backend.run(thread, randomUUID(), '\r\n  Review\tchanges 😀  \r\nMore details', vi.fn(), new AbortController().signal);
  const next = f.factory.connect();
  const resumed = await next.resume(thread.id, {});
  await next.run(resumed, randomUUID(), 'A different follow-up task', vi.fn(), new AbortController().signal);

  expect(next.describe!(thread.id).name).toBe(expectedTitle);
  expect(titles[0]).toBe(expectedTitle);
  expect(f.store.readSessionSummaries([sessionId])[0]?.title).toBe(expectedTitle);
});

it('limits automatic names to 50 Unicode characters without cutting an emoji', async () => {
  const f = fixture();
  const thread = await f.backend.start({ cwd: f.cwd });

  await f.backend.run(thread, randomUUID(), '😀'.repeat(51), vi.fn(), new AbortController().signal);

  expect(f.backend.describe!(thread.id).name).toBe('😀'.repeat(50));
});

it('recognizes a pending default name after switching languages and names image-only conversations', async () => {
  const f = fixture();
  setLanguage('zh');
  const thread = await f.backend.start({ cwd: f.cwd });
  expect(f.backend.describe!(thread.id).name).toBe('新对话');
  setLanguage('en');
  const emptyThread = await f.backend.start({ cwd: f.cwd });
  expect(f.backend.describe!(emptyThread.id).name).toBe('New conversation');
  const resumedBackend = f.factory.connect();
  const resumed = await resumedBackend.resume(thread.id, {});

  await resumedBackend.run(resumed, randomUUID(), '', vi.fn(), new AbortController().signal, {
    attachments: [{ name: 'image.png', mimeType: 'image/png', base64Data: 'aW1hZ2U=' }],
  });
  await resumedBackend.run(resumed, randomUUID(), 'Explain another image', vi.fn(), new AbortController().signal);

  expect(resumedBackend.describe!(thread.id).name).toBe('Image conversation');
  expect(f.execute.mock.calls[0][0].message).toBe('');
});

it('preserves client and desktop names set before the first task', async () => {
  const f = fixture();
  const clientThread = await f.backend.start({ cwd: f.cwd });
  f.backend.setName!(clientThread.id, 'Client project');
  const desktopThread = await f.backend.start({ cwd: f.cwd });
  f.store.updateSession(f.external.get(desktopThread.id)!.coworkSessionId, { title: 'Desktop project' });

  await f.backend.run(clientThread, randomUUID(), 'First client task', vi.fn(), new AbortController().signal);
  await f.backend.run(desktopThread, randomUUID(), 'First desktop task', vi.fn(), new AbortController().signal);

  expect(f.backend.describe!(clientThread.id).name).toBe('Client project');
  expect(f.backend.describe!(desktopThread.id).name).toBe('Desktop project');
});

it('does not rename rejected tasks or overwrite names that are reset to the default after a run', async () => {
  const f = fixture();
  const thread = await f.backend.start({ cwd: f.cwd });
  const sessionId = f.external.get(thread.id)!.coworkSessionId;
  const originalTitle = f.backend.describe!(thread.id).name;
  await expect(f.backend.run(thread, randomUUID(), '   ', vi.fn(), new AbortController().signal))
    .rejects.toThrow('bounded text');
  const release = reserveExternalSession(sessionId);
  try {
    await expect(f.backend.run(thread, randomUUID(), 'Blocked task', vi.fn(), new AbortController().signal))
      .rejects.toThrow('active task');
  } finally {
    release();
  }
  expect(f.backend.describe!(thread.id).name).toBe(originalTitle);
  const begin = vi.spyOn(f.external, 'beginExecution').mockImplementationOnce(() => {
    throw new Error('Cannot reserve execution');
  });
  await expect(f.backend.run(thread, randomUUID(), 'Unreserved task', vi.fn(), new AbortController().signal))
    .rejects.toThrow('Cannot reserve execution');
  begin.mockRestore();
  expect(f.backend.describe!(thread.id).name).toBe(originalTitle);
  expect(f.execute).not.toHaveBeenCalled();

  await f.backend.run(thread, randomUUID(), 'The first admitted task', vi.fn(), new AbortController().signal);
  f.backend.setName!(thread.id, originalTitle);
  await f.factory.connect().run(thread, randomUUID(), 'Later task', vi.fn(), new AbortController().signal);

  expect(f.backend.describe!(thread.id).name).toBe(originalTitle);
  expect(f.execute.mock.calls[0][0].initialSession).toBe(true);
  expect(f.execute.mock.calls[1][0].initialSession).toBeUndefined();
});

it('does not infer an empty conversation from a default name when product history already exists', async () => {
  const f = fixture();
  const thread = await f.backend.start({ cwd: f.cwd });
  const sessionId = f.external.get(thread.id)!.coworkSessionId;
  const title = f.backend.describe!(thread.id).name;
  const timing = f.store.beginSessionRun({ sessionId, clientTurnId: randomUUID(), startedAt: 1_000 });
  f.store.finishSessionRun(timing.id, 'completed', 2_000);

  await f.backend.run(thread, randomUUID(), 'New follow-up', vi.fn(), new AbortController().signal);

  expect(f.backend.describe!(thread.id).name).toBe(title);
  expect(f.execute.mock.calls[0][0].initialSession).toBeUndefined();
});

it('retains a selected assistant and confirmed model route while rejecting unavailable identities', async () => {
  const f = fixture();
  const agent = f.store.saveAgentProfile({
    id: 'reviewer',
    name: 'Reviewer',
    description: '',
    icon: '',
    model: '',
    enabled: true,
    isDefault: false,
  });
  const route = `${OpenClawProviderId.BuiltinModels}/openai/internal`;
  f.models.push({ id: route, name: 'Built-in', isDefault: false });
  const thread = await f.backend.start({ cwd: f.cwd, agentId: agent.id, model: route });
  expect(thread.agentId).toBe(agent.id);
  f.store.updateSession(f.store.listSessions()[0].id, { modelRef: 'openai/internal' });
  await expect(f.backend.resume(thread.id, {})).resolves.toMatchObject({ modelRef: route });
  await expect(f.backend.resume(thread.id, { model: 'openai/internal' })).rejects.toThrow(
    'model is unavailable',
  );
  f.store.updateAgent(agent.id, { enabled: false });
  await expect(f.backend.resume(thread.id, {})).rejects.toThrow('assistant is unavailable');
  await expect(f.backend.start({ cwd: f.cwd, agentId: 'missing' })).rejects.toThrow(
    'assistant is unavailable',
  );
});

it('describes persisted per-thread metadata without exposing native execution identities', async () => {
  const f = fixture();
  const thread = await f.backend.start({ cwd: f.cwd, model: 'other/selected' });
  const session = f.store.listSessions()[0];
  f.store.updateSession(session.id, { title: 'Persisted title', permissionMode: 'ask' });
  f.store.recordSessionActivity(session.id, Date.now() + 10_000);
  const runId = randomUUID();
  f.external.beginExecution(thread.id, runId);
  f.external.bindExecution(thread.id, runId, {
    sessionKey: 'private-native-key',
    sessionId: 'private-native-id',
    lifecycleRevision: 'private-native-revision',
  });
  f.external.markExecutionUnknown(thread.id, runId);

  const metadata = f.backend.describe!(thread.id);

  expect(metadata).toEqual({
    id: thread.id,
    name: 'Persisted title',
    cwd: thread.cwd,
    agentId: 'main',
    modelRef: 'other/selected',
    permissionMode: 'ask',
    status: 'running',
    executionState: 'unknown',
    createdAt: session.createdAt,
    updatedAt: f.store.getSession(session.id)!.updatedAt,
  });
  expect(f.store.getConfig().permissionMode).toBe('full');
  expect(JSON.stringify(metadata)).not.toMatch(/private-native|executionRunId|coworkSessionId/);
  expect(f.execute).not.toHaveBeenCalled();
});

it('lists only live CLI identities and does not hide database read failures', async () => {
  const f = fixture();
  const visible = await f.backend.start({ cwd: f.cwd });
  const moved = await f.backend.start({ cwd: f.cwd });
  const missingDirectory = path.join(f.cwd, 'removed-directory');
  fs.mkdirSync(missingDirectory);
  await f.backend.start({ cwd: missingDirectory });
  fs.rmdirSync(missingDirectory);
  const other = path.join(f.cwd, 'other-directory');
  fs.mkdirSync(other);
  f.store.updateSession(f.external.get(moved.id)!.coworkSessionId, { cwd: other });
  const historicalSession = f.store.createSession('Historical', f.cwd);
  new ExternalSessionStore(f.sqlite.getDatabase(), ExternalSessionSource.HistoricalAppServer).create({
    externalSessionKey: randomUUID(),
    coworkSessionId: historicalSession.id,
    agentId: 'main',
    cwd: f.cwd,
    openclawSessionKey: '',
  });
  f.store.createSession('Ordinary desktop conversation', f.cwd);
  const malformed = f.store.createSession('Malformed mapping', f.cwd);
  f.external.create({
    externalSessionKey: 'not-an-external-uuid',
    coworkSessionId: malformed.id,
    agentId: 'main',
    cwd: f.cwd,
    openclawSessionKey: '',
  });
  const changesBeforeRead = f.onSessionsChanged.mock.calls.length;

  expect(f.backend.list!().map(thread => thread.id)).toEqual([visible.id]);
  expect(f.onSessionsChanged).toHaveBeenCalledTimes(changesBeforeRead);
  expect(f.execute).not.toHaveBeenCalled();
  vi.spyOn(f.store, 'getSession').mockImplementationOnce(() => {
    throw new Error('Database read failed');
  });
  expect(() => f.backend.list!()).toThrow('Database read failed');
});

it('persists validated thread names and keeps renamed metadata available across connections', async () => {
  const f = fixture();
  const thread = await f.backend.start({ cwd: f.cwd });
  const changesBeforeRename = f.onSessionsChanged.mock.calls.length;

  f.backend.setName!(thread.id, '  New task title  ');

  expect(f.factory.connect().describe!(thread.id).name).toBe('New task title');
  expect(f.store.getSession(f.external.get(thread.id)!.coworkSessionId)?.title).toBe('New task title');
  expect(f.onSessionsChanged).toHaveBeenCalledTimes(changesBeforeRename + 1);
  for (const name of ['   ', 'x'.repeat(501)]) {
    expect(() => f.backend.setName!(thread.id, name)).toThrow('thread name');
  }
  expect(() => f.backend.setName!('agent:main:native-key', 'Wrong identity')).toThrow('identity');
  expect(f.backend.describe!(thread.id).name).toBe('New task title');
  expect(f.execute).not.toHaveBeenCalled();
});

it('rejects unavailable owners and historical namespaces during metadata access', async () => {
  const f = fixture();
  const thread = await f.backend.start({ cwd: f.cwd });
  f.store.updateAgent(thread.agentId, { enabled: false });

  expect(f.backend.list!()).toEqual([]);
  expect(() => f.backend.describe!(thread.id)).toThrow('assistant is unavailable');
  expect(() => f.backend.setName!(thread.id, 'Cannot rename')).toThrow('assistant is unavailable');
  const historical = new ExternalSessionStore(
    f.sqlite.getDatabase(),
    ExternalSessionSource.HistoricalAppServer,
  );
  const wrongNamespace = new ExternalAgentBackendFactory({
    ...f.options,
    getExternalSessionStore: () => historical,
  }).connect();
  expect(() => wrongNamespace.list!()).toThrow('namespace is unavailable');
});

const bindHistory = async (f: ReturnType<typeof fixture>) => {
  const thread = await f.backend.start({ cwd: f.cwd });
  const external = f.external.get(thread.id)!;
  f.store.bindNativeSession(external.coworkSessionId, 'private-history-key', null);
  const runId = randomUUID();
  f.external.beginExecution(thread.id, runId);
  f.external.bindExecution(thread.id, runId, {
    sessionKey: 'private-history-key', sessionId: 'private-history-sid', lifecycleRevision: 'history-revision',
  });
  f.external.finishExecution(thread.id, runId, 'completed');
  const timing = f.store.beginSessionRun({ sessionId: external.coworkSessionId, clientTurnId: runId, startedAt: 1_000 });
  return { thread, external, timing };
};

it('reads new empty histories without waking native services', async () => {
  const f = fixture();
  const thread = await f.backend.start({ cwd: f.cwd });
  const readHistory = vi.fn(async () => ({ messages: [] }));
  const backend = new ExternalAgentBackendFactory({ ...f.options, readHistory }).connect();

  await expect(backend.history!(thread.id)).resolves.toEqual({ threadId: thread.id, messages: [], runs: [] });
  expect(readHistory).not.toHaveBeenCalled();
  expect(f.execute).not.toHaveBeenCalled();
});

it('loads authenticated snapshots using the exact binding without returning private native identities', async () => {
  const f = fixture();
  const h = await bindHistory(f);
  f.store.finishSessionRun(h.timing.id, 'completed', 2_000);
  const messages = [{ role: 'assistant', content: 'Verified native history' }];
  const readHistory = vi.fn(async () => ({ messages }));
  const backend = new ExternalAgentBackendFactory({ ...f.options, readHistory }).connect();

  const result = await backend.history!(h.thread.id);

  expect(readHistory).toHaveBeenCalledExactlyOnceWith({
    sessionKey: 'private-history-key', nativeSessionId: 'private-history-sid', lifecycleRevision: 'history-revision',
  });
  expect(result).toMatchObject({
    threadId: h.thread.id, messages, latestExternalRunId: h.timing.clientTurnId,
    runs: [{ clientTurnId: h.timing.clientTurnId, state: 'completed' }],
  });
  expect(result.identityRevision).toEqual(expect.any(String));
  expect(JSON.stringify(result)).not.toMatch(/private-history-key|private-history-sid|history-revision/);
  expect(f.execute).not.toHaveBeenCalled();
});

it('pins receipt-only history to the external execution instead of a newer generic product timing', async () => {
  const f = fixture();
  const h = await bindHistory(f);
  f.store.finishSessionRun(h.timing.id, 'completed', 2_000);
  const unrelated = f.store.beginSessionRun({
    sessionId: h.external.coworkSessionId, clientTurnId: randomUUID(), startedAt: 3_000,
  });
  const backend = new ExternalAgentBackendFactory({
    ...f.options, readHistory: async () => ({ messages: [] }),
  }).connect();

  const result = await backend.history!(h.thread.id);

  expect(result.latestExternalRunId).toBe(h.timing.clientTurnId);
  expect(result.latestExternalRunId).not.toBe(unrelated.clientTurnId);
  expect(result.runs).toHaveLength(2);
});

it('keeps the original client turn while recording and settling the exact native successor', async () => {
  const f = fixture();
  const h = await bindHistory(f);
  f.store.finishSessionRun(h.timing.id, 'completed', 2_000);
  const rootRunId = randomUUID();
  const successorRunId = randomUUID();
  const backend = new ExternalAgentBackendFactory({
    ...f.options, readHistory: async () => ({ messages: [] }),
  }).connect();
  const identity = {
    sessionKey: 'private-history-key', nativeSessionId: 'private-history-sid', lifecycleRevision: 'history-revision',
  };
  f.execute.mockImplementationOnce(async input => {
    await input.hooks?.onPrepared?.({
      ...identity, sessionId: identity.nativeSessionId, runId: rootRunId, localSessionId: h.external.coworkSessionId,
      client: {} as never,
    });
    const root = f.store.beginSessionRun({ sessionId: h.external.coworkSessionId, clientTurnId: rootRunId, startedAt: 3_000 });
    f.store.finishSessionRun(root.id, 'failed', 4_000);
    f.store.setSessionRunAutomaticErrorRetry(rootRunId, {
      ...identity, chainId: rootRunId, attempt: 0, maxContinuations: 1, disposition: Disposition.Pending,
    });
    expect(input.isRetryCurrent?.()).toBe(true);
    const waiting = await backend.history!(h.thread.id);
    expect(waiting.retryTurns).toEqual([expect.objectContaining({ clientTurnId: rootRunId, state: 'running' })]);
    const successor = f.store.beginSessionRun({
      sessionId: h.external.coworkSessionId, clientTurnId: successorRunId, startedAt: 5_000,
    });
    input.onRetryPrepared?.(rootRunId, successorRunId);
    expect(f.external.get(h.thread.id)?.executionRunId).toBe(successorRunId);
    f.store.setSessionRunAutomaticErrorRetry(rootRunId, {
      ...identity, chainId: rootRunId, attempt: 0, maxContinuations: 1, disposition: Disposition.Superseded,
    });
    f.store.setSessionRunAutomaticErrorRetry(successorRunId, {
      ...identity, chainId: rootRunId, attempt: 1, maxContinuations: 1, disposition: Disposition.Final,
      predecessorRunId: rootRunId,
    });
    f.store.finishSessionRun(successor.id, 'completed', 6_000);
    return 'Answer';
  });
  await expect(backend.run(h.thread, rootRunId, 'Task', vi.fn(), new AbortController().signal)).resolves.toBe('Answer');
  expect(f.external.get(h.thread.id)).toMatchObject({ status: 'completed', executionRunId: successorRunId });
  const result = await backend.history!(h.thread.id);
  expect(result.latestExternalRunId).toBe(rootRunId);
  expect(result.retryTurns).toEqual([{
    clientTurnId: rootRunId, nativeRunIds: [rootRunId, successorRunId], state: 'completed', endedAt: 6_000,
  }]);
});

it('rejects deleted or replaced history ownership after an asynchronous native read', async () => {
  const f = fixture();
  const h = await bindHistory(f);
  const readHistory = vi.fn(async () => {
    f.external.setOpenClawSessionKey(h.thread.id, 'replacement-native-key');
    return { messages: [{ role: 'assistant', content: 'Late previous history' }] };
  });
  const backend = new ExternalAgentBackendFactory({ ...f.options, readHistory }).connect();

  await expect(backend.history!(h.thread.id)).rejects.toThrow('identity changed');
  expect(readHistory).toHaveBeenCalledOnce();
  f.external.setOpenClawSessionKey(h.thread.id, 'private-history-key');
  readHistory.mockImplementationOnce(async () => {
    f.store.deleteSession(h.external.coworkSessionId);
    return { messages: [] };
  });
  await expect(backend.history!(h.thread.id)).rejects.toThrow('unavailable');
});

it('rejects changed product native bindings even when the external mapping still points at an older native session', async () => {
  const f = fixture();
  const h = await bindHistory(f);
  const readHistory = vi.fn(async () => {
    f.store.bindNativeSession(h.external.coworkSessionId, 'new-product-native-key', null);
    return { messages: [{ role: 'assistant', content: 'Old native history' }] };
  });
  const backend = new ExternalAgentBackendFactory({ ...f.options, readHistory }).connect();

  await expect(backend.history!(h.thread.id)).rejects.toThrow('product conversation binding');
  expect(readHistory).toHaveBeenCalledOnce();
  await expect(backend.history!(h.thread.id)).rejects.toThrow('product conversation binding');
  expect(readHistory).toHaveBeenCalledOnce();
});

it('checks historical product session IDs before and after the native read', async () => {
  const f = fixture();
  const h = await bindHistory(f);
  let replaced = false;
  const getSession = f.store.getSession.bind(f.store);
  vi.spyOn(f.store, 'getSession').mockImplementation(id => {
    const session = getSession(id);
    return session && {
      ...session,
      historyBinding: {
        sessionKey: 'private-history-key',
        nativeSessionId: replaced ? 'replacement-history-sid' : 'private-history-sid',
        availability: 'native' as const,
      },
    };
  });
  const readHistory = vi.fn(async () => {
    replaced = true;
    return { messages: [] };
  });
  const backend = new ExternalAgentBackendFactory({ ...f.options, readHistory }).connect();

  await expect(backend.history!(h.thread.id)).rejects.toThrow('product conversation binding');
  await expect(backend.history!(h.thread.id)).rejects.toThrow('product conversation binding');
  expect(readHistory).toHaveBeenCalledOnce();
});

it('accepts the exact derived product key while a managed thread has no explicit native-binding row', async () => {
  const f = fixture();
  const thread = await f.backend.start({ cwd: f.cwd });
  const mapped = f.external.get(thread.id)!;
  const sessionKey = buildManagedSessionKey(mapped.coworkSessionId, mapped.agentId);
  const runId = randomUUID();
  f.external.beginExecution(thread.id, runId);
  f.external.bindExecution(thread.id, runId, {
    sessionKey, sessionId: 'managed-sid', lifecycleRevision: 'managed-revision',
  });
  const readHistory = vi.fn(async () => ({ messages: [] }));
  const backend = new ExternalAgentBackendFactory({ ...f.options, readHistory }).connect();

  await expect(backend.history!(thread.id)).resolves.toMatchObject({ threadId: thread.id, messages: [] });
  expect(readHistory).toHaveBeenCalledExactlyOnceWith({
    sessionKey, nativeSessionId: 'managed-sid', lifecycleRevision: 'managed-revision',
  });
  expect(f.store.getSession(mapped.coworkSessionId)?.nativeSessionKey).toBeUndefined();
});

it('retries one receipt change and never mixes its earlier body snapshot with settled metadata', async () => {
  const f = fixture();
  const h = await bindHistory(f);
  const readHistory = vi.fn(async () => ({ messages: [{ role: 'assistant', content: 'After settlement' }] }));
  readHistory.mockImplementationOnce(async () => {
    f.store.finishSessionRun(h.timing.id, 'completed', 2_000);
    return { messages: [{ role: 'assistant', content: 'Before settlement' }] };
  });
  const backend = new ExternalAgentBackendFactory({ ...f.options, readHistory }).connect();

  const result = await backend.history!(h.thread.id);

  expect(readHistory).toHaveBeenCalledTimes(2);
  expect(result.messages).toEqual([{ role: 'assistant', content: 'After settlement' }]);
  expect(result.runs[0]).toMatchObject({ state: 'completed', endedAt: 2_000 });
});

it('rejects continuously changing receipts and incomplete bindings instead of returning empty history', async () => {
  const f = fixture();
  const h = await bindHistory(f);
  let changes = 0;
  const readHistory = vi.fn(async () => {
    f.store.bindSessionRunRootRun(h.timing.id, `new-native-run-${++changes}`);
    return { messages: [] };
  });
  const backend = new ExternalAgentBackendFactory({ ...f.options, readHistory }).connect();
  await expect(backend.history!(h.thread.id)).rejects.toThrow('changed during the read');
  expect(readHistory).toHaveBeenCalledTimes(2);
  const incomplete = await f.backend.start({ cwd: f.cwd });
  f.external.beginExecution(incomplete.id, randomUUID());
  await expect(backend.history!(incomplete.id)).rejects.toThrow('identity is unavailable');
});

it('never recreates a deleted conversation or its tombstoned mapping', async () => {
  const f = fixture();
  const thread = await f.backend.start({ cwd: f.cwd });
  f.store.deleteSession(f.store.listSessions()[0].id);
  await expect(f.backend.resume(thread.id, {})).rejects.toThrow('unavailable');
  expect(f.external.wasDeleted(thread.id)).toBe(true);
  expect(f.store.listSessions()).toHaveLength(0);
});

it('rolls back only a newly created empty session when local metadata setup fails', async () => {
  const f = fixture();
  let id = '';
  await expect(
    f.backend.start({
      cwd: f.cwd,
      onCreated: thread => {
        id = thread.id;
        throw new Error('Marker unavailable');
      },
    }),
  ).rejects.toThrow('Marker unavailable');
  expect(f.store.listSessions()).toHaveLength(0);
  expect(f.external.get(id)).toBeNull();
  expect(f.external.wasDeleted(id)).toBe(true);
  await expect(f.backend.resume(id, {})).rejects.toThrow('unavailable');
  expect(f.execute).not.toHaveBeenCalled();
});

it('never guesses a historical scoped mapping from its bare thread UUID', async () => {
  const f = fixture();
  const id = randomUUID();
  const session = f.store.createSession('Historical client', f.cwd);
  const historical = new ExternalSessionStore(
    f.sqlite.getDatabase(),
    ExternalSessionSource.HistoricalAppServer,
  );
  const key = `codex:${'a'.repeat(32)}:${id}`;
  historical.create({
    externalSessionKey: key,
    coworkSessionId: session.id,
    agentId: session.agentId,
    openclawSessionKey: 'original-native-key',
    cwd: f.cwd,
  });
  await expect(f.backend.resume(id, {})).rejects.toThrow('unavailable');
  await expect(f.backend.resume(key, {})).rejects.toThrow('identity');
  expect(historical.get(key)).toMatchObject({
    coworkSessionId: session.id,
    openclawSessionKey: 'original-native-key',
  });
  expect(f.execute).not.toHaveBeenCalled();
});

it('holds a shared reservation through cancellation until native settlement', async () => {
  const f = fixture();
  const thread = await f.backend.start({ cwd: f.cwd });
  let finish!: (text: string) => void;
  f.execute.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      }),
  );
  const controller = new AbortController();
  const running = f.backend.run(thread, randomUUID(), 'Task', () => {}, controller.signal);
  controller.abort();
  const other = new ExternalAgentBackendFactory(f.options);
  await expect(
    other.connect().run(thread, randomUUID(), 'Other task', () => {}, new AbortController().signal),
  ).rejects.toBeInstanceOf(ExternalAgentBusyError);
  expect(f.factory.activeTaskCount).toBe(1);
  finish('Done');
  await running;
  expect(f.factory.activeTaskCount).toBe(0);
  expect(f.external.get(thread.id)?.status).toBe('completed');
});

it('classifies a shared reservation collision as busy without creating a second execution receipt', async () => {
  const f = fixture();
  const thread = await f.backend.start({ cwd: f.cwd });
  const before = f.external.get(thread.id)!;
  const release = reserveExternalSession(before.coworkSessionId);
  try {
    await expect(
      f.backend.run(thread, randomUUID(), 'Other protocol task', () => {}, new AbortController().signal),
    ).rejects.toBeInstanceOf(ExternalAgentBusyError);
    expect(f.external.get(thread.id)).toEqual(before);
    expect(f.execute).not.toHaveBeenCalled();
  } finally {
    release();
  }
});

it('persists the exact binding before caller tool hooks and leaves unknown work reserved across factories', async () => {
  const f = fixture();
  const thread = await f.backend.start({ cwd: f.cwd });
  const runId = randomUUID();
  const onPrepared = vi.fn(async () => {
    expect(f.factory.isExecuting(thread.id)).toBe(true);
    expect(f.external.get(thread.id)).toMatchObject({
      executionRunId: runId,
      nativeSessionId: 'native-id',
      lifecycleRevision: 'revision-1',
      executionState: 'running',
    });
  });
  f.execute.mockImplementation(async input => {
    await input.hooks?.onPrepared?.({
      localSessionId: input.sessionId,
      runId: input.runId,
      sessionKey: 'native-key',
      sessionId: 'native-id',
      lifecycleRevision: 'revision-1',
      client: {} as never,
    });
    throw new ExternalAgentOutcomeUnknownError('The native outcome is unknown.');
  });
  await expect(
    f.backend.run(thread, runId, 'Task', () => {}, new AbortController().signal, { onPrepared }),
  ).rejects.toThrow('outcome is unknown');
  expect(onPrepared).toHaveBeenCalledTimes(1);
  expect(f.factory.isExecuting(thread.id)).toBe(false);
  expect(f.factory.activeTaskCount).toBe(1);
  expect(f.external.get(thread.id)).toMatchObject({
    status: 'running',
    executionState: 'unknown',
    executionRunId: runId,
  });
  const restarted = new ExternalAgentBackendFactory(f.options);
  expect(restarted.activeTaskCount).toBe(1);
  await expect(
    restarted.connect().run(thread, randomUUID(), 'Retry', () => {}, new AbortController().signal),
  ).rejects.toBeInstanceOf(ExternalAgentBusyError);
  expect(f.execute).toHaveBeenCalledTimes(1);
});

it('preserves native success on output failure and rejects obsolete models before dispatch', async () => {
  const f = fixture();
  const thread = await f.backend.start({ cwd: f.cwd, model: 'other/selected' });
  const controller = new AbortController();
  f.execute.mockImplementation(async () => {
    controller.abort(new ExternalAgentStreamError('Output limit'));
    return 'Done';
  });
  await expect(
    f.backend.run(thread, randomUUID(), 'Task', () => {}, controller.signal),
  ).rejects.toThrow('Output limit');
  expect(f.external.get(thread.id)?.status).toBe('completed');
  f.models.pop();
  await expect(
    f.backend.run(thread, randomUUID(), 'Task', () => {}, new AbortController().signal),
  ).rejects.toThrow('model is unavailable');
  expect(f.execute).toHaveBeenCalledTimes(1);
});

it('does not replay a completed native request under a previously used execution identity', async () => {
  const f = fixture();
  const thread = await f.backend.start({ cwd: f.cwd });
  const runId = randomUUID();
  await f.backend.run(thread, runId, 'First task', () => {}, new AbortController().signal);
  await expect(
    f.backend.run(thread, runId, 'Replay', () => {}, new AbortController().signal),
  ).rejects.toThrow('already been used');
  expect(f.execute).toHaveBeenCalledTimes(1);
});

it('preserves native cancellation even when no local client requested a stop', async () => {
  const f = fixture();
  const thread = await f.backend.start({ cwd: f.cwd });
  f.execute.mockRejectedValue(new ExternalAgentCancelledError('Native execution was cancelled.'));
  await expect(
    f.backend.run(thread, randomUUID(), 'Task', () => {}, new AbortController().signal),
  ).rejects.toBeInstanceOf(ExternalAgentCancelledError);
  expect(f.external.get(thread.id)?.status).toBe('cancelled');
});

it('does not overwrite exact native failure when a local stop was also requested', async () => {
  const f = fixture();
  const thread = await f.backend.start({ cwd: f.cwd });
  const controller = new AbortController();
  f.execute.mockImplementation(async input => {
    input.onSettled?.('failed');
    controller.abort();
    throw new Error('Native failure');
  });
  await expect(
    f.backend.run(thread, randomUUID(), 'Task', () => {}, controller.signal),
  ).rejects.toThrow('Native failure');
  expect(f.external.get(thread.id)?.status).toBe('error');
});
