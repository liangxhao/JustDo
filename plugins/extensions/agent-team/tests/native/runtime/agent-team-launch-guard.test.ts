import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { buildSync } from 'esbuild';
import { afterAll, describe, expect, it, vi } from 'vitest';


const nativeRequire = createRequire(import.meta.url);
const code = buildSync({
  entryPoints: [
    path.resolve(import.meta.dirname, '../../../runtime/launch/agent-team-launch-guard.ts'),
  ],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  external: ['openclaw/plugin-sdk/*', '@runtime-services/sdk/admission-client'],
}).outputFiles[0].text;
const key = 'agent:main:justdo:source';
const prompt = 'The whole explicit user message\nSelected Agent Team mode.';
const intent = {
  expectedGeneration: 0,
  sessionKey: key,
  nativeSessionId: 'native-source',
  lifecycleRevision: 'revision-1',
  clientTurnId: 'explicit-input',
  promptSha256: createHash('sha256').update(prompt).digest('hex'),
  mode: 'discussion',
};
const ctx = { sessionKey: key, sessionId: 'native-source', runId: 'explicit-input' };
const temporaryRoots = new Set<string>();
afterAll(() => {
  const base = path.resolve(os.tmpdir()) + path.sep;
  for (const directory of temporaryRoots) {
    if (
      !directory.startsWith(base) ||
      !path.basename(directory).startsWith('agent-team-guard-test-')
    )
      throw new Error('Unexpected test cleanup directory');
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(persisted?: Record<string, unknown>, existingStateDir?: string) {
  const stateDir =
    existingStateDir ?? mkdtempSync(path.join(os.tmpdir(), 'agent-team-guard-test-'));
  temporaryRoots.add(stateDir);
  const ledgerDirectory = path.join(stateDir, 'runtime-services', 'agent-team-launch');
  const ledgerFile = path.join(
    ledgerDirectory,
    `${createHash('sha256').update(key).digest('hex')}.json`,
  );
  const hooks = new Map<string, (...args: any[]) => any>();
  const hookOptions = new Map<string, any>();
  const methods = new Map<string, (...args: any[]) => any>();
  const policies: Array<{ evaluate: (...args: any[]) => any }> = [];
  const listeners: Array<(event: any) => void> = [];
  const entry: Record<string, any> = persisted
    ? structuredClone(persisted)
    : { sessionId: 'native-source', lifecycleRevision: 'revision-1' };
  if (!existingStateDir && persisted?.pluginExtensions) {
    const launch = (persisted.pluginExtensions as any)['agent-team']?.['agent-team-launch'];
    if (launch !== undefined) {
      mkdirSync(ledgerDirectory, { recursive: true });
      const source = typeof launch?.sessionKey === 'string' ? launch.sessionKey : key;
      writeFileSync(
        path.join(ledgerDirectory, `${createHash('sha256').update(source).digest('hex')}.json`),
        JSON.stringify(launch),
      );
    }
  }
  let teamEnabled = true;
  let inputPresent = true;
  let body: unknown = prompt;
  let provenance: unknown;
  let nativeOwner = true;
  let currentAuthority = true;
  let mirrorFails = false;
  let loseAdmissionAcknowledgement = false;
  let admissionUnknown = false;
  const bindAdmission = vi.fn(async () => true);
  let service!: { start(): void; stop(): void };
  const registerService = vi.fn(value => { service = value; });
  const reserveAdmission = vi.fn(async () => {
    if (loseAdmissionAcknowledgement) { admissionUnknown = true; throw new Error('Admission acknowledgement lost'); }
    return { id: 'admission-fixture', generation: 1 };
  });
  let entryReadFails = false;
  let anchorId = 'entry-1';
  let generation = 'transcript-1';
  let blockRead: Promise<void> | undefined;
  let history: Record<string, unknown> = {
    sessionInfo: { sessionId: 'native-source', hasActiveRun: false },
    pendingInputs: { total: 0, items: [] },
    inputReceipts: [],
    inputConsumptions: [],
  };
  const state = () => entry.pluginExtensions?.['agent-team']?.['agent-team-launch'];
  async function call(name: string, params: Record<string, unknown>, mode = 'backend', signal?: AbortSignal) {
    const handler = methods.get(`agentTeam.launch.${name}`);
    if (!handler) throw new Error('Missing method');
    let result: any;
    await handler({
      params,
      signal,
      client: { connect: { client: { mode } } },
      hasCurrentClientAuthority: () => currentAuthority,
      sessionMutationCommitGuard: vi.fn(),
      respond: (ok: boolean, payload: any, error: any) => {
        result = { ok, payload, error };
      },
    });
    return result;
  }
  const gateway = vi.fn(async (method: string, params: Record<string, any>) => {
    if (method === 'chat.history') return history;
    if (method === 'sessions.pluginPatch') {
      if (mirrorFails) throw new Error('Native mirror acknowledgment unavailable');
      entry.pluginExtensions = {
        ...entry.pluginExtensions,
        'agent-team': {
          ...entry.pluginExtensions?.['agent-team'],
          [params.namespace]: structuredClone(params.value),
        },
      };
      return { ok: true };
    }
    const result = await call(method.replace('agentTeam.launch.', ''), params);
    if (!result.ok) throw new Error(result.error.message);
    return result.payload;
  });
  const api = {
    registerService,
    id: 'agent-team',
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: () => () => undefined,
      runInBackgroundContext: <T>(run: () => T): T => run(),
    },
    session: { state: { registerSessionExtension: vi.fn() } },
    runtime: {
      state: { resolveStateDir: () => stateDir },
      events: { onAgentEvent: (listener: (event: any) => void) => listeners.push(listener) },
      config: {
        current: () => ({ plugins: { entries: { 'agent-team': { enabled: teamEnabled } } } }),
      },
      gateway: { request: gateway },
    },
    registerGatewayMethod: (name: string, handler: any) => methods.set(name, handler),
    registerTrustedToolPolicy: (policy: any) => policies.push(policy),
    on: (name: string, handler: any, options: any) => {
      hooks.set(name, handler);
      hookOptions.set(name, options);
    },
  };
  const exported: Record<string, any> = {};
  const moduleBox = { exports: exported };
  vm.runInNewContext(code, {
    exports: exported,
    module: moduleBox,
    process: { argv: [] },
    require: (name: string) =>
      name === '@runtime-services/sdk/admission-client' ? { createExecutionAdmissionClient: () => ({ bind: bindAdmission, inspect: async () => admissionUnknown ? ({ state: 'unknown' }) : ({ state: 'clear', generation: 0 }), reserve: reserveAdmission, update: async () => ({}), dispose() {} }) } : name === 'openclaw/plugin-sdk/session-store-runtime'
        ? {
            getSessionEntry: () => {
              if (entryReadFails) throw new Error('Native identity unavailable');
              return entry;
            },
          }
        : name === 'openclaw/plugin-sdk/codex-session-transcript-runtime'
          ? {
              withCodexSessionTranscriptMirrorWriteLock: async (_target: any, run: any) => {
                if (blockRead) await blockRead;
                return run({
                  readMessageFacts: async () => ({
                    messagesByIdempotencyKey: new Map(
                      inputPresent
                        ? [
                            [
                              'explicit-input:user',
                              {
                                role: 'user',
                                content: body,
                                provenance,
                                __openclaw: { senderIsOwner: nativeOwner },
                              },
                            ],
                          ]
                        : [],
                    ),
                    anchorsByIdempotencyKey: new Map(
                      inputPresent
                        ? [
                            [
                              'explicit-input:user',
                              {
                                entryId: anchorId,
                                sessionId: entry.sessionId,
                                sessionKey: key,
                                generation,
                              },
                            ],
                          ]
                        : [],
                    ),
                  }),
                });
              },
            }
          : nativeRequire(name),
  });
  moduleBox.exports.registerAgentTeamLaunchGuard(api);
  service.start();
  const policy = (
    toolName: string,
    params: Record<string, unknown> = {},
    identity = ctx,
    extra = {},
  ) => policies[0].evaluate({ toolName, params, ...extra }, { ...identity, toolName });
  const verify = () => hooks.get('before_prompt_build')!({}, ctx);
  return {
    bindAdmission,
    service,
    entry,
    stateDir,
    ledgerFile,
    state,
    call,
    policy,
    verify,
    hooks,
    finalizeApplies: (identity: Record<string, unknown> = ctx) =>
      hookOptions.get('before_agent_finalize').appliesToAgentRun(identity),
    blocksWorkflowStart: (
      source: { sessionKey: string; sessionId?: string } = {
        sessionKey: key,
        sessionId: ctx.sessionId,
      },
    ) =>
      moduleBox.exports.blocksWorkflowStartDuringTeamLaunch(stateDir, source),
    gateway,
    api,
    listeners,
    reserveAdmission,
    set loseAdmissionAcknowledgement(value: boolean) { loseAdmissionAcknowledgement = value; },
    set history(value: Record<string, unknown>) {
      history = value;
    },
    set enabled(value: boolean) {
      teamEnabled = value;
    },
    set inputPresent(value: boolean) {
      inputPresent = value;
    },
    set body(value: unknown) {
      body = value;
    },
    set provenance(value: unknown) {
      provenance = value;
    },
    set nativeOwner(value: boolean) {
      nativeOwner = value;
    },
    set currentAuthority(value: boolean) {
      currentAuthority = value;
    },
    set mirrorFails(value: boolean) {
      mirrorFails = value;
    },
    set entryReadFails(value: boolean) {
      entryReadFails = value;
    },
    set anchorId(value: string) {
      anchorId = value;
    },
    set generation(value: string) {
      generation = value;
    },
    set blockRead(value: Promise<void> | undefined) {
      blockRead = value;
    },
  };
}
const request = {
  expectedGeneration: 0,
  sessionKey: key,
  nativeSessionId: 'native-source',
  clientTurnId: 'explicit-input',
};

describe('Agent Team finalize run admission', () => {
  it('does not repeat generic reservation after its acknowledgement is lost', async () => {
    const f = fixture(); f.loseAdmissionAcknowledgement = true;
    expect((await f.call('register', intent)).ok).toBe(false);
    expect(f.state()).toBeUndefined();
    f.loseAdmissionAcknowledgement = false;
    expect((await f.call('register', intent)).ok).toBe(false);
    expect(f.reserveAdmission).toHaveBeenCalledOnce();
  });
  it('does not hold ordinary confirmed native turns without a launch ledger', () => {
    const f = fixture();
    expect(f.finalizeApplies()).toBe(false);
    expect(f.finalizeApplies({ ...ctx, runId: 'ordinary-followup' })).toBe(false);
    expect(f.gateway).not.toHaveBeenCalled();
  });

  it('retains protection for missing or changed native identity and failed identity reads', () => {
    const f = fixture();
    expect(f.finalizeApplies({ ...ctx, runId: undefined })).toBe(true);
    expect(f.finalizeApplies({ ...ctx, sessionId: undefined })).toBe(true);
    expect(f.finalizeApplies({ ...ctx, sessionId: 'other-incarnation' })).toBe(true);
    f.entryReadFails = true;
    expect(f.finalizeApplies()).toBe(true);
  });

  it('keeps an admitted launch guarded through verification and native revision', async () => {
    const f = fixture();
    await f.call('register', intent);
    expect(f.finalizeApplies()).toBe(true);
    expect(f.finalizeApplies({ ...ctx, runId: 'not-the-admitted-turn' })).toBe(true);
    await f.verify();
    expect(f.finalizeApplies()).toBe(true);
    expect(await f.hooks.get('before_agent_finalize')!({}, ctx)).toMatchObject({
      action: 'revise',
      retry: { idempotencyKey: 'agent-team-launch:explicit-input' },
    });
    f.entry.lifecycleRevision = 'replaced';
    expect(f.finalizeApplies()).toBe(true);
    expect(await f.hooks.get('before_agent_finalize')!({}, ctx)).toBeUndefined();
  });

  it('does not turn unknown durable state or predecessor ownership into a streaming bypass', async () => {
    const f = fixture();
    await f.call('register', intent);
    const fresh = fixture(f.entry, f.stateDir);
    expect(fresh.finalizeApplies()).toBe(true);
    expect(await fresh.hooks.get('before_agent_finalize')!({}, ctx)).toBeUndefined();
    writeFileSync(f.ledgerFile, '{incomplete');
    expect(f.finalizeApplies()).toBe(true);
    expect(await f.hooks.get('before_agent_finalize')!({}, ctx)).toBeUndefined();
  });

  it('excludes released tombstones only for a confirmed current native incarnation', async () => {
    const f = fixture();
    await f.call('register', intent);
    f.inputPresent = false;
    expect((await f.call('abandon', { ...request, neverSubmitted: true })).ok).toBe(true);
    expect(f.finalizeApplies()).toBe(false);
    f.entry.sessionId = 'new-native';
    f.entry.lifecycleRevision = 'new-revision';
    expect(f.finalizeApplies()).toBe(true);
    expect(f.finalizeApplies({ ...ctx, sessionId: 'new-native', runId: 'new-run' })).toBe(false);
  });
});

describe('explicit Team launch protection', () => {
  it('defers owner binding until a published control request and rejects an unavailable owner', async () => {
    const f = fixture();
    expect(f.bindAdmission).not.toHaveBeenCalled();
    f.bindAdmission.mockResolvedValueOnce(false);
    expect(await f.call('register', intent)).toMatchObject({
      ok: false, error: { message: 'Execution admission owner is unavailable.' },
    });
    expect(existsSync(f.ledgerFile)).toBe(false);
    expect(f.reserveAdmission).not.toHaveBeenCalled();
    expect(f.gateway).not.toHaveBeenCalled();
    expect((await f.call('register', intent)).ok).toBe(true);
    expect(f.bindAdmission).toHaveBeenCalledTimes(2);
  });

  it('cannot resume a control write after stop and restart during owner binding', async () => {
    const f = fixture();
    let release!: (bound: boolean) => void;
    f.bindAdmission.mockReturnValueOnce(new Promise<boolean>(resolve => { release = resolve; }));
    const pending = f.call('register', intent);
    f.service.stop();
    f.service.start();
    release(true);
    expect((await pending).ok).toBe(false);
    expect(existsSync(f.ledgerFile)).toBe(false);
    expect(f.reserveAdmission).not.toHaveBeenCalled();
    expect(f.gateway).not.toHaveBeenCalled();
  });

  it('cannot write after its request is aborted during owner binding', async () => {
    const f = fixture();
    const controller = new AbortController();
    let release!: (bound: boolean) => void;
    f.bindAdmission.mockReturnValueOnce(new Promise<boolean>(resolve => { release = resolve; }));
    const pending = f.call('register', intent, 'backend', controller.signal);
    controller.abort();
    release(true);
    expect((await pending).ok).toBe(false);
    expect(existsSync(f.ledgerFile)).toBe(false);
    expect(f.reserveAdmission).not.toHaveBeenCalled();
    expect(f.gateway).not.toHaveBeenCalled();
  });

  it('does not hide workflow startup without a Team intent or after a proven release', async () => {
    const f = fixture();
    expect(f.blocksWorkflowStart()).toBe(false);
    await f.call('register', intent);
    expect(f.blocksWorkflowStart()).toBe(true);
    await f.call('release', {
      ...request,
      executionSettled: true,
      dispatchCleanupComplete: true,
    });
    expect(f.blocksWorkflowStart()).toBe(false);
    const restarted = fixture(f.entry, f.stateDir);
    restarted.entry.sessionId = 'replacement-native';
    restarted.entry.lifecycleRevision = 'replacement-revision';
    expect(restarted.blocksWorkflowStart()).toBe(false);
  });

  it.each(['collaboration', 'discussion'])(
    'blocks competing workflow startup while preserving preparation for %s',
    async mode => {
      const f = fixture();
      await f.call('register', { ...intent, mode });
      expect(f.blocksWorkflowStart()).toBe(true);
      expect(await f.policy('swarm_workflow_start')).toMatchObject({ allow: false });
      await f.verify();
      expect(f.blocksWorkflowStart()).toBe(true);
      expect(f.blocksWorkflowStart({ sessionKey: key })).toBe(true);
      for (const tool of ['read', 'exec', 'write', 'sessions_spawn'])
        expect(await f.policy(tool)).toBeUndefined();
      expect(await f.policy('swarm_workflow_start')).toMatchObject({ allow: false });
      expect(f.state().state).toBe('verified');
      await f.call('cancel', request);
      expect(f.blocksWorkflowStart()).toBe(true);
    },
  );

  it('keeps workflow startup hidden for missing, corrupt or unreadable Team evidence', async () => {
    const unreadable = fixture();
    unreadable.entryReadFails = true;
    expect(unreadable.blocksWorkflowStart()).toBe(true);
    const f = fixture();
    f.entry.pluginExtensions = { 'agent-team': { 'agent-team-launch': { incomplete: true } } };
    expect(f.blocksWorkflowStart()).toBe(true);
    f.entry.pluginExtensions = undefined;
    await f.call('register', intent);
    f.entry.pluginExtensions = undefined;
    expect(f.blocksWorkflowStart()).toBe(true);
    writeFileSync(f.ledgerFile, '{incomplete');
    expect(f.blocksWorkflowStart()).toBe(true);
  });

  it.each(['collaboration', 'discussion'])(
    'admits native catalog controls for a verified %s launch while gating actual targets',
    async mode => {
      const f = fixture();
      await f.call('register', { ...intent, mode });
      f.inputPresent = false;
      for (const control of ['tool_search', 'tool_describe', 'tool_call']) {
        expect(await f.policy(control, { id: 'task_assistants' })).toMatchObject({ allow: false });
      }
      f.inputPresent = true;
      await f.verify();
      for (const control of ['tool_search', 'tool_describe', 'tool_call']) {
        expect(await f.policy(control, { id: 'task_assistants' })).toBeUndefined();
      }
      expect(f.state().state).toBe('verified');
      expect(await f.policy('task_assistants')).toBeUndefined();
      for (const tool of ['write', 'exec', 'sessions_spawn'])
        expect(await f.policy(tool)).toBeUndefined();
      expect(f.state().state).toBe('verified');
      const wrongMode = mode === 'collaboration' ? 'team_discussion' : 'sessions_send';
      expect(await f.policy(wrongMode, { action: 'create' })).toMatchObject({ allow: false });
      const wrongRun = { ...ctx, runId: 'unrelated-turn' };
      expect(await f.policy('tool_call', { id: 'task_assistants' }, wrongRun)).toMatchObject({
        allow: false,
      });
      f.enabled = false;
      expect(await f.policy('tool_call', { id: 'task_assistants' })).toMatchObject({
        allow: false,
      });
    },
  );
  it('verifies a native-normalized explicit input without relaxing exact native row matching', async () => {
    const raw = ' \u0001Discuss cafe\u0301\twith\nthis team';
    const nativeText = 'Discuss café\twith\nthis team';
    const f = fixture();
    f.body = nativeText;
    expect(
      (
        await f.call('register', {
          ...intent,
          promptSha256: createHash('sha256').update(nativeText).digest('hex'),
        })
      ).ok,
    ).toBe(true);
    await f.verify();
    expect(f.state().state).toBe('verified');
    expect(await f.policy('team_discussion', { action: 'create' })).toBeUndefined();
    f.body = raw;
    expect(await f.policy('team_discussion', { action: 'create' })).toMatchObject({ allow: false });
  });
  it('keeps durable authority when normal native retirement clears the session projection', async () => {
    const f = fixture();
    await f.call('register', intent);
    await f.verify();
    f.entry.pluginExtensions = undefined;
    expect((await f.call('inspect', request)).payload.state).toBe('verified');
    expect(await f.policy('write')).toBeUndefined();
    expect(await f.policy('sessions_send')).toMatchObject({ allow: false });
    const fresh = fixture(f.entry, f.stateDir);
    expect((await fresh.call('inspect', request)).payload.state).toBe('unknown');
    expect(await fresh.policy('team_discussion', { action: 'create' })).toMatchObject({
      allow: false,
    });
    await fresh.call('release', {
      ...request,
      executionSettled: true,
      dispatchCleanupComplete: true,
    });
    fresh.entry.pluginExtensions = undefined;
    const next = fixture(fresh.entry, fresh.stateDir);
    expect((await next.call('inspect', request)).payload).toMatchObject({
      state: 'released',
      generation: 1,
    });
    expect(
      (await next.call('register', { ...intent, expectedGeneration: 1, clientTurnId: 'next' }))
        .payload,
    ).toMatchObject({ state: 'pending', generation: 2 });
    expect((await next.call('register', intent)).ok).toBe(false);
    expect((await next.call('cancel', request)).ok).toBe(false);
    expect((await next.call('abandon', { ...request, neverSubmitted: true })).ok).toBe(false);
  });

  it('holds a corrupt durable ledger despite an empty native projection', async () => {
    const f = fixture();
    await f.call('register', intent);
    f.entry.pluginExtensions = undefined;
    writeFileSync(f.ledgerFile, '{incomplete');
    expect((await f.call('inspect', request)).payload.state).toBe('unknown');
    expect((await f.call('register', intent)).ok).toBe(false);
    expect(await f.policy('write')).toMatchObject({ allow: false });
  });

  it('rejects oversized durable metadata without lifting the native tool guard', async () => {
    const f = fixture();
    await f.call('register', intent);
    f.entry.pluginExtensions = undefined;
    writeFileSync(f.ledgerFile, JSON.stringify({ arbitrary: 'x'.repeat(33 * 1024) }));
    expect((await f.call('inspect', request)).payload.state).toBe('unknown');
    expect(await f.policy('write')).toMatchObject({ allow: false });
  });

  it('holds a failed first durable write until trusted reconciliation instead of lifting policy', async () => {
    const f = fixture();
    const nativeFs = nativeRequire('node:fs');
    const rename = vi.spyOn(nativeFs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('Disk commit unavailable');
    });
    try {
      expect((await f.call('register', intent)).ok).toBe(false);
    } finally {
      rename.mockRestore();
    }
    expect(f.state()).toBeUndefined();
    expect((await f.call('inspect', request)).payload.state).toBe('unknown');
    expect(f.blocksWorkflowStart()).toBe(true);
    expect(await f.policy('write')).toMatchObject({ allow: false });
  });

  it('keeps the durable generation after a lost native projection acknowledgment', async () => {
    const f = fixture();
    f.inputPresent = false;
    f.mirrorFails = true;
    expect((await f.call('register', intent)).ok).toBe(false);
    expect(f.state()).toBeUndefined();
    expect((await f.call('inspect', request)).payload).toMatchObject({
      state: 'pending',
      generation: 1,
    });
    expect(await f.policy('write')).toMatchObject({ allow: false });
    f.mirrorFails = false;
    expect((await f.call('abandon', { ...request, neverSubmitted: true })).payload).toMatchObject({
      state: 'released',
      generation: 1,
    });
    expect((await f.call('register', intent)).ok).toBe(false);
  });

  it('rechecks backend authority before persisting a late verification', async () => {
    const f = fixture();
    await f.call('register', intent);
    let finish!: () => void;
    f.blockRead = new Promise(resolve => {
      finish = resolve;
    });
    const verifying = f.call('verify', { ...request, runId: ctx.runId });
    await Promise.resolve();
    await Promise.resolve();
    f.currentAuthority = false;
    finish();
    expect((await verifying).ok).toBe(false);
    expect(f.state().state).toBe('pending');
  });

  it('revokes retiring registrations without discarding their durable intent', async () => {
    const f = fixture();
    await f.call('register', intent);
    await f.verify();
    const registration = f.api.session.state.registerSessionExtension.mock.calls[0][0];
    registration.cleanup({ reason: 'restart' });
    f.entry.pluginExtensions = undefined;
    expect(await f.policy('team_discussion', { action: 'create' })).toMatchObject({ allow: false });
    const fresh = fixture(f.entry, f.stateDir);
    expect((await fresh.call('inspect', request)).payload.state).toBe('unknown');
  });

  it.each([
    { permissionMode: 'read-only' },
    { permissionMode: 'restricted' },
    { goal: { status: 'running' } },
    {
      pluginExtensions: {
        'plan-mode': { state: { enabled: false, awaitingReview: true } },
      },
    },
    { pluginExtensions: { 'plan-mode': { state: { enabled: true } } } },
    {
      pluginExtensions: {
        'plan-mode': {
          state: {
            enabled: false,
            awaitingReview: { version: 1, requestId: 'plan-request', persistedAt: 1 },
          },
        },
      },
    },
    { pluginExtensions: { 'plan-mode': { state: { malformed: true } } } },
  ])('rejects a launch after native eligibility changes to %j', async changes => {
    const f = fixture();
    Object.assign(f.entry, changes);
    expect((await f.call('register', intent)).ok).toBe(false);
    expect(f.state()).toBeUndefined();
  });

  it.each([false, true])(
    'uses canonical Plan state over conflicting slot projections: %s',
    async enabled => {
      const f = fixture();
      Object.assign(f.entry, {
        planMode: !enabled,
        justdoPlanMode: { enabled: !enabled, awaitingReview: enabled ? undefined : true },
        pluginExtensions: { 'plan-mode': { state: { enabled } } },
      });
      expect((await f.call('register', intent)).ok).toBe(!enabled);
      if (enabled) {
        expect(f.state()).toBeUndefined();
      } else {
        await f.verify();
        expect(await f.policy('team_discussion', { action: 'create' })).toBeUndefined();
      }
    },
  );

  it.each(['guarded', 'workspace', 'full'])(
    'retains normal %s permission and sandbox admission',
    async permissionMode => {
      const f = fixture();
      Object.assign(f.entry, {
        permissionMode,
        sandbox: 'required',
        pluginExtensions: { 'plan-mode': { state: { enabled: false } } },
      });
      expect((await f.call('register', intent)).ok).toBe(true);
      await f.verify();
      expect(await f.policy('team_discussion', { action: 'create' })).toBeUndefined();
    },
  );

  it('denies late input verification after native mode changes while allowing proven cleanup', async () => {
    const f = fixture();
    await f.call('register', intent);
    f.entry.pluginExtensions['plan-mode'] = { state: { enabled: true } };
    expect(await f.policy('team_discussion', { action: 'create' })).toMatchObject({ allow: false });
    expect(await f.hooks.get('before_agent_finalize')!({}, ctx)).toBeUndefined();
    expect(f.state().state).toBe('pending');
    expect(
      (
        await f.call('release', {
          ...request,
          executionSettled: true,
          dispatchCleanupComplete: true,
        })
      ).ok,
    ).toBe(true);
    expect(await f.policy('write')).toBeUndefined();
  });

  it('limits a completed accepted launch intent to its original run, leaving later native work to native policy', async () => {
    const f = fixture();
    await f.call('register', intent);
    await f.verify();
    const later = { ...ctx, runId: 'automatic-summary' };
    expect(f.finalizeApplies(later)).toBe(true);
    expect(await f.policy('write', {}, later)).toMatchObject({ allow: false });
    await f.call('confirm', { ...request, mode: 'discussion', receiptId: 'accepted-discussion' });
    expect(f.blocksWorkflowStart()).toBe(true);
    expect(f.finalizeApplies(later)).toBe(true);
    expect(await f.policy('write', {}, later)).toMatchObject({ allow: false });
    f.listeners[0]({
      sessionKey: key,
      sessionId: ctx.sessionId,
      runId: ctx.runId,
      stream: 'lifecycle',
      data: { phase: 'end', executionSettled: true },
      seq: 3,
    });
    await vi.waitFor(() => expect(f.state().wholeSettled?.runId).toBe(ctx.runId));
    expect(f.blocksWorkflowStart()).toBe(false);
    expect(await f.policy('swarm_workflow_start')).toMatchObject({ allow: false });
    expect(await f.policy('swarm_workflow_start', {}, later)).toBeUndefined();
    expect(f.blocksWorkflowStart({ sessionKey: key, sessionId: 'other' })).toBe(true);
    f.entry.lifecycleRevision = 'changed-revision';
    expect(f.blocksWorkflowStart()).toBe(true);
    f.entry.lifecycleRevision = intent.lifecycleRevision;
    f.entry.sessionId = 'replacement-native';
    expect(f.blocksWorkflowStart()).toBe(true);
    f.entry.sessionId = ctx.sessionId;
    expect(f.blocksWorkflowStart()).toBe(false);
    expect(f.finalizeApplies(later)).toBe(false);
    expect(f.finalizeApplies()).toBe(true);
    expect(await f.policy('write', {}, later)).toBeUndefined();
    expect(f.state().state).toBe('launched');
    expect(await f.policy('write')).toBeUndefined();
    expect(await f.policy('write', {}, { ...later, sessionId: 'other' })).toMatchObject({
      allow: false,
    });
    expect(await f.policy('write', {}, { ...later, runId: '' })).toMatchObject({ allow: false });
    f.enabled = false;
    expect(await f.policy('write', {}, later)).toBeUndefined();
    const restarted = fixture(f.entry);
    expect(restarted.blocksWorkflowStart()).toBe(true);
    expect(restarted.finalizeApplies(later)).toBe(true);
    expect(await restarted.policy('write', {}, later)).toMatchObject({ allow: false });
    await f.call('cancel', request);
    expect(f.blocksWorkflowStart()).toBe(true);
    expect(await f.policy('write', {}, later)).toMatchObject({ allow: false });
  });

  it('preserves a proven release across process owners and admits only the next exact generation', async () => {
    const f = fixture();
    await f.call('register', intent);
    await f.call('release', { ...request, executionSettled: true, dispatchCleanupComplete: true });
    const restarted = fixture(f.entry);
    expect((await restarted.call('inspect', request)).payload).toMatchObject({
      state: 'released',
      generation: 1,
    });
    expect((await restarted.call('register', intent)).ok).toBe(false);
    expect(
      (
        await restarted.call('register', {
          ...intent,
          expectedGeneration: 1,
          clientTurnId: 'new-turn',
        })
      ).payload,
    ).toMatchObject({ state: 'pending', generation: 2 });
    const replaced = fixture(f.entry);
    replaced.entry.sessionId = 'replacement-native';
    expect((await replaced.call('inspect', request)).payload).toMatchObject({
      state: 'released',
      generation: 1,
      wholeSettled: false,
    });
  });

  it.each(['reset', 'revision'])(
    'keeps released historical receipts readable after %s without transferring whole-run proof',
    async kind => {
      const f = fixture();
      await f.call('register', intent);
      f.listeners[0]({
        ...ctx,
        stream: 'lifecycle',
        seq: 4,
        data: { phase: 'end', executionSettled: true },
      });
      await vi.waitFor(() => expect(f.state().wholeSettled?.runId).toBe(ctx.runId));
      await f.call('release', {
        ...request,
        executionSettled: true,
        dispatchCleanupComplete: true,
      });
      expect((await f.call('inspect', request)).payload.wholeSettled).toBe(true);
      const restarted = fixture(f.entry);
      restarted.entry.lifecycleRevision = 'revision-2';
      if (kind === 'reset') restarted.entry.sessionId = 'replacement-native';
      const freshIdentity = { ...request, nativeSessionId: restarted.entry.sessionId };
      for (const identity of [request, freshIdentity]) {
        expect((await restarted.call('inspect', identity)).payload).toMatchObject({
          state: 'released',
          generation: 1,
          wholeSettled: false,
          launch: {
            nativeSessionId: 'native-source',
            lifecycleRevision: 'revision-1',
          },
        });
      }
      expect(
        (await restarted.call('inspect', { ...request, nativeSessionId: 'unrelated' })).ok,
      ).toBe(false);
      expect(
        (
          await restarted.call('register', {
            ...intent,
            expectedGeneration: 1,
            clientTurnId: 'next-turn',
          })
        ).ok,
      ).toBe(false);
      const next = await restarted.call('register', {
        ...intent,
        expectedGeneration: 1,
        nativeSessionId: restarted.entry.sessionId,
        lifecycleRevision: restarted.entry.lifecycleRevision,
        clientTurnId: 'next-turn',
      });
      expect(next.payload).toMatchObject({ state: 'pending', generation: 2 });
      expect((await restarted.call('inspect', freshIdentity)).payload.wholeSettled).toBe(false);
      expect(restarted.state().wholeSettled).toBeUndefined();
      expect((await restarted.call('cancel', request)).ok).toBe(false);
    },
  );

  it.each(['reset', 'revision'])(
    'never treats an unreleased %s incarnation change as a closed generation',
    async kind => {
      const f = fixture();
      await f.call('register', intent);
      f.entry.lifecycleRevision = 'revision-2';
      if (kind === 'reset') f.entry.sessionId = 'replacement-native';
      for (const nativeSessionId of ['native-source', f.entry.sessionId]) {
        expect((await f.call('inspect', { ...request, nativeSessionId })).ok).toBe(false);
      }
      expect(
        (
          await f.call('register', {
            ...intent,
            expectedGeneration: 1,
            nativeSessionId: f.entry.sessionId,
            lifecycleRevision: f.entry.lifecycleRevision,
            clientTurnId: 'next-turn',
          })
        ).ok,
      ).toBe(false);
      expect(await f.policy('write', {}, { ...ctx, sessionId: f.entry.sessionId })).toMatchObject({
        allow: false,
      });
    },
  );

  it('pins the latest native revision when Main cannot publicly describe it', async () => {
    const f = fixture();
    const { lifecycleRevision: _revision, ...withoutRevision } = intent;
    expect((await f.call('register', withoutRevision)).payload).toEqual({
      executionAdmission: { id: 'admission-fixture', generation: 1 },
      state: 'pending',
      nativeSessionId: 'native-source',
      lifecycleRevision: 'revision-1',
      generation: 1,
    });
    expect((await f.call('inspect', request)).payload.launch.clientTurnId).toBe(ctx.runId);
    expect((await f.call('inspect', request)).payload.wholeSettled).toBe(false);
  });
  it('persists only closed metadata even when control parameters contain unrelated text', async () => {
    const f = fixture();
    await f.call('register', {
      ...intent,
      prompt: 'Never mirror this body',
      nested: { text: 'other body' },
    });
    expect(f.state().prompt).toBeUndefined();
    expect(f.state().nested).toBeUndefined();
    expect(f.state().expectedGeneration).toBeUndefined();
  });
  it('records only exact native whole-run publication without claiming cleanup', async () => {
    const f = fixture();
    await f.call('register', intent);
    const terminal = {
      ...ctx,
      stream: 'lifecycle',
      seq: 4,
      data: { phase: 'end', executionSettled: true },
    };
    f.listeners[0]({ ...terminal, runId: 'native-followup-uuid' });
    f.listeners[0]({ ...terminal, sessionId: 'replaced' });
    f.listeners[0]({ ...terminal, data: { phase: 'finishing', executionSettled: true } });
    expect((await f.call('inspect', request)).payload.wholeSettled).toBe(false);
    f.listeners[0](terminal);
    await vi.waitFor(() => expect(f.state().wholeSettled?.runId).toBe(ctx.runId));
    expect((await f.call('inspect', request)).payload.wholeSettled).toBe(true);
    expect((await f.call('release', { ...request, executionSettled: true })).ok).toBe(false);
  });
  it('abandons a proven never-submitted intent without inventing a terminal event', async () => {
    const f = fixture();
    await f.call('register', intent);
    f.inputPresent = false;
    expect((await f.call('abandon', request)).ok).toBe(false);
    expect((await f.call('abandon', { ...request, neverSubmitted: true })).ok).toBe(true);
    expect(f.state().state).toBe('released');
    expect(await f.policy('write')).toBeUndefined();
  });
  it('tombstones an absent never-submitted generation and never resurrects a late registration', async () => {
    const f = fixture();
    f.inputPresent = false;
    expect((await f.call('inspect', request)).payload).toEqual({ state: 'absent', generation: 0 });
    expect((await f.call('abandon', { ...intent, neverSubmitted: true })).ok).toBe(true);
    expect(f.state().generation).toBe(1);
    expect((await f.call('register', intent)).ok).toBe(false);
    expect(
      (await f.call('register', { ...intent, expectedGeneration: 1, clientTurnId: 'second' })).ok,
    ).toBe(true);
    expect(f.state().generation).toBe(2);
    expect(
      (
        await f.call('release', {
          ...request,
          clientTurnId: 'second',
          executionSettled: true,
          dispatchCleanupComplete: true,
        })
      ).ok,
    ).toBe(true);
    expect((await f.call('register', intent)).ok).toBe(false);
    expect(f.state().state).toBe('released');
  });
  it('ignores copied metadata for a different native source key without relaxing same-key incarnation guards', async () => {
    const f = fixture();
    await f.call('register', intent);
    const childKey = 'agent:main:justdo:copied';
    f.entry.sessionId = 'child-native';
    const childCtx = { sessionKey: childKey, sessionId: 'child-native', runId: 'ordinary-child' };
    expect(await f.policy('write', {}, childCtx)).toBeUndefined();
    expect(
      (
        await f.call('inspect', {
          ...request,
          sessionKey: childKey,
          nativeSessionId: 'child-native',
        })
      ).payload,
    ).toEqual({ state: 'absent', generation: 0 });
    expect(
      (
        await f.call('register', {
          ...intent,
          sessionKey: childKey,
          nativeSessionId: 'child-native',
          clientTurnId: 'child-explicit',
        })
      ).ok,
    ).toBe(true);
    expect(f.state().sessionKey).toBe(childKey);
    expect(f.state().generation).toBe(1);
  });
  it.each(['input', 'active', 'queue', 'receipt', 'unknown'])(
    'never abandons %s native evidence',
    async kind => {
      const f = fixture();
      await f.call('register', intent);
      f.inputPresent = kind === 'input';
      f.history = {
        sessionInfo: {
          sessionId: 'native-source',
          hasActiveRun: kind === 'active' ? true : kind === 'unknown' ? undefined : false,
        },
        pendingInputs: { total: kind === 'queue' ? 1 : 0, items: [] },
        inputReceipts: kind === 'receipt' ? [{ runId: ctx.runId, state: 'consumed' }] : [],
        inputConsumptions: [],
      };
      expect((await f.call('abandon', { ...request, neverSubmitted: true })).ok).toBe(false);
      expect(f.state().state).toBe('pending');
    },
  );
  it('does not derive a launch intent from text and registration does not grant tools', async () => {
    const f = fixture();
    expect(await f.policy('write')).toBeUndefined();
    expect((await f.call('register', intent)).ok).toBe(true);
    expect(f.state().state).toBe('pending');
    f.inputPresent = false;
    expect((await f.policy('write')).allow).toBe(false);
    expect((await f.policy('team_discussion', { action: 'create' })).allow).toBe(false);
  });
  it('verifies an exact normal input that becomes durable only at the tool boundary', async () => {
    const f = fixture();
    await f.call('register', intent);
    f.inputPresent = false;
    await f.verify();
    await f.hooks.get('llm_input')!({}, ctx);
    expect(f.state().state).toBe('pending');
    expect((await f.policy('team_discussion', { action: 'create' })).allow).toBe(false);
    f.inputPresent = true;
    expect(await f.policy('task_assistants')).toBeUndefined();
    expect(f.state().state).toBe('verified');
    expect(await f.policy('team_discussion', { action: 'create' })).toBeUndefined();
    expect(f.state().state).toBe('attempted');
  });
  it('verifies an exact normal input at finalization without closing correction on pure discovery', async () => {
    const f = fixture();
    await f.call('register', intent);
    f.inputPresent = false;
    await f.verify();
    f.inputPresent = true;
    const result = await f.hooks.get('before_agent_finalize')!({}, ctx);
    expect(result.action).toBe('revise');
    expect(f.state().corrections).toBe(1);
    expect(await f.policy('task_assistants')).toBeUndefined();
    expect(f.state().state).toBe('verified');
    expect((await f.hooks.get('before_agent_finalize')!({}, ctx)).action).toBe('revise');
  });
  it('keeps discussion history reads eligible for bounded missing-launch correction', async () => {
    const f = fixture();
    await f.call('register', intent);
    expect(await f.policy('team_discussion', { action: 'read' })).toBeUndefined();
    expect(f.state().state).toBe('verified');
    expect((await f.hooks.get('before_agent_finalize')!({}, ctx)).action).toBe('revise');
    expect(await f.policy('team_discussion', { action: 'stop' })).toBeUndefined();
    expect(f.state().state).toBe('attempted');
  });
  it('requires a real backend, exact native incarnation and a complete SHA256 digest', async () => {
    const f = fixture();
    expect((await f.call('register', intent, 'ui')).ok).toBe(false);
    expect((await f.call('register', { ...intent, nativeSessionId: 'replaced' })).ok).toBe(false);
    expect((await f.call('register', { ...intent, lifecycleRevision: 'replaced' })).ok).toBe(false);
    expect((await f.call('register', { ...intent, promptSha256: 'partial' })).ok).toBe(false);
    expect(f.state()).toBeUndefined();
  });
  it.each(['missing', 'different-body', 'peer-copy', 'non-owner'])(
    'keeps %s input unverified and never corrects it',
    async kind => {
      const f = fixture();
      await f.call('register', intent);
      if (kind === 'missing') f.inputPresent = false;
      if (kind === 'different-body') f.body = prompt + '\nextra';
      if (kind === 'peer-copy')
        f.provenance = { kind: 'inter_session', sourceTool: 'sessions_send' };
      if (kind === 'non-owner') f.nativeOwner = false;
      await f.verify();
      expect(f.state().state).toBe('pending');
      expect((await f.policy('team_discussion', { action: 'create' })).allow).toBe(false);
      expect(await f.hooks.get('before_agent_finalize')!({}, ctx)).toBeUndefined();
    },
  );
  it('rejects a queued execution UUID even when the submitted input exists', async () => {
    const f = fixture();
    await f.call('register', intent);
    const queued = { ...ctx, runId: 'native-followup-uuid' };
    await f.hooks.get('before_prompt_build')!({}, queued);
    await f.hooks.get('llm_input')!({}, queued);
    expect(f.state().state).toBe('pending');
    expect((await f.policy('team_discussion', { action: 'create' }, queued)).allow).toBe(false);
    expect(await f.hooks.get('before_agent_finalize')!({}, queued)).toBeUndefined();
  });
  it('bounds native corrections to two and never resets the count on duplicate registration', async () => {
    const f = fixture();
    await f.call('register', intent);
    await f.verify();
    expect(f.state().state).toBe('verified');
    for (let index = 0; index < 2; index++) {
      const result = await f.hooks.get('before_agent_finalize')!({}, ctx);
      expect(result.action).toBe('revise');
      expect(result.retry.maxAttempts).toBe(2);
      expect(result.retry.idempotencyKey).toBe('agent-team-launch:explicit-input');
    }
    await f.call('register', intent);
    expect(await f.hooks.get('before_agent_finalize')!({}, ctx)).toBeUndefined();
    expect(f.state().corrections).toBe(2);
  });
  it('keeps preparation available while checking Team operations inside Code Mode', async () => {
    const f = fixture();
    await f.call('register', intent);
    await f.verify();
    expect(await f.policy('exec')).toBeUndefined();
    expect(
      await f.policy('exec', {}, ctx, { toolKind: 'code_mode_exec', toolInputKind: 'javascript' }),
    ).toBeUndefined();
    expect(await f.policy('swarm_workflow_start')).toMatchObject({ allow: false });
    expect(
      (await f.policy('sessions_send', { sessionKey: 'agent:worker:justdo:peer' })).allow,
    ).toBe(false);
    expect(await f.policy('write')).toBeUndefined();
    expect(f.state().state).toBe('verified');
    expect(await f.policy('team_discussion', { action: 'create' })).toBeUndefined();
    expect(f.state().state).toBe('attempted');
    expect(await f.hooks.get('before_agent_finalize')!({}, ctx)).toBeUndefined();
  });
  it.each(['collaboration', 'discussion'])(
    'leaves native preparation tools available throughout a verified %s launch',
    async mode => {
      const f = fixture();
      await f.call('register', { ...intent, mode });
      const additions = ['skills_read', 'skills_search', 'progress_card'];
      f.inputPresent = false;
      for (const tool of additions) expect(await f.policy(tool)).toMatchObject({ allow: false });
      f.inputPresent = true;
      await f.verify();
      for (const phase of ['verified', 'attempted']) {
        if (phase === 'attempted')
          expect((await f.call('attempt', { ...request, runId: ctx.runId })).ok).toBe(true);
        for (const tool of additions) {
          expect(await f.policy(tool)).toBeUndefined();
          expect(f.state().state).toBe(phase);
        }
        for (const tool of [
          'ask_user',
          'ls',
          'find',
          'grep',
          'glob',
          'view_image',
          'pdf',
          'x_search',
          'sessions_list',
          'sessions_history',
          'sessions_search',
          'conversations_list',
          'agents_list',
          'presence',
          'github_identity_status',
          'get_goal',
          'decision_evaluate',
          'session_status',
          'process',
          'subagents',
          'browser',
        ])
          expect(await f.policy(tool)).toBeUndefined();
        expect(await f.policy('process', { action: 'list' })).toBeUndefined();
        expect(await f.policy('subagents', { action: 'list' })).toBeUndefined();
        expect(await f.policy('browser', { action: 'snapshot' })).toBeUndefined();
        expect(await f.policy('team_discussion', { action: 'read' })).toBeUndefined();
        expect(f.state().state).toBe(phase);
      }
      f.enabled = false;
      for (const tool of additions) expect(await f.policy(tool)).toMatchObject({ allow: false });
    },
  );
  it('does not treat preparation or attempted delegation as accepted collaboration', async () => {
    const f = fixture();
    await f.call('register', { ...intent, mode: 'collaboration' });
    await f.verify();
    expect(await f.policy('write')).toBeUndefined();
    expect(await f.policy('exec')).toBeUndefined();
    expect(f.state().state).toBe('verified');
    await f.policy('sessions_send', { sessionKey: 'agent:worker:justdo:peer' });
    expect(f.state().state).toBe('attempted');
    expect(await f.policy('write')).toBeUndefined();
    expect(
      (await f.call('confirm', { ...request, mode: 'discussion', receiptId: 'native-receipt' })).ok,
    ).toBe(false);
    expect(
      (await f.call('confirm', { ...request, mode: 'collaboration', receiptId: 'native-receipt' }))
        .ok,
    ).toBe(true);
    expect(await f.policy('write')).toBeUndefined();
    expect(await f.policy('exec')).toBeUndefined();
    expect((await f.policy('team_discussion', { action: 'create' })).allow).toBe(false);
  });
  it('keeps the permanent policy active after optional Team disablement', async () => {
    const f = fixture();
    await f.call('register', intent);
    await f.verify();
    f.enabled = false;
    expect((await f.policy('team_discussion', { action: 'create' })).allow).toBe(false);
    expect(
      (await f.policy('exec', {}, ctx, { toolKind: 'code_mode_exec', toolInputKind: 'javascript' }))
        .allow,
    ).toBe(false);
    expect(await f.hooks.get('before_agent_finalize')!({}, ctx)).toBeUndefined();
  });
  it('does not restore authority from persisted verification after a process owner change', async () => {
    const old = fixture();
    await old.call('register', intent);
    await old.verify();
    const fresh = fixture(old.entry);
    expect((await fresh.call('register', intent)).payload.state).toBe('unknown');
    expect((await fresh.policy('team_discussion', { action: 'create' })).allow).toBe(false);
    expect(await fresh.hooks.get('before_agent_finalize')!({}, ctx)).toBeUndefined();
  });
  it.each(['incarnation', 'revision', 'entry', 'transcript'])(
    'revokes a verified launch when %s changes',
    async kind => {
      const f = fixture();
      await f.call('register', intent);
      await f.verify();
      if (kind === 'incarnation') f.entry.sessionId = 'replacement-native';
      if (kind === 'revision') f.entry.lifecycleRevision = 'replacement-revision';
      if (kind === 'entry') f.anchorId = 'replacement-entry';
      if (kind === 'transcript') f.generation = 'replacement-transcript';
      expect((await f.policy('team_discussion', { action: 'create' })).allow).toBe(false);
      expect(await f.hooks.get('before_agent_finalize')!({}, ctx)).toBeUndefined();
    },
  );
  it('keeps cancelled launches restrictive until Main confirms terminal evidence and dispatch cleanup', async () => {
    const f = fixture();
    await f.call('register', intent);
    await f.verify();
    await f.call('cancel', request);
    expect((await f.policy('write')).allow).toBe(false);
    expect((await f.call('release', { ...request, executionSettled: true })).ok).toBe(false);
    expect((await f.call('release', { ...request, dispatchCleanupComplete: true })).ok).toBe(false);
    expect((await f.call('register', { ...intent, clientTurnId: 'second-input' })).ok).toBe(false);
    expect(
      (
        await f.call('release', {
          ...request,
          executionSettled: true,
          dispatchCleanupComplete: true,
        })
      ).ok,
    ).toBe(true);
    expect(await f.policy('write')).toBeUndefined();
    expect((await f.call('register', intent)).ok).toBe(false);
    expect(
      (await f.call('register', { ...intent, expectedGeneration: 1, clientTurnId: 'second-input' }))
        .ok,
    ).toBe(true);
  });
  it('does not admit a late verification after cancellation', async () => {
    const f = fixture();
    await f.call('register', intent);
    let unblock!: () => void;
    f.blockRead = new Promise<void>(resolve => {
      unblock = resolve;
    });
    const pending = f.verify();
    await Promise.resolve();
    const cancelled = f.call('cancel', request);
    unblock();
    await Promise.all([pending, cancelled]);
    expect(f.state().state).toBe('cancelled');
    expect((await f.policy('team_discussion', { action: 'create' })).allow).toBe(false);
  });
});
