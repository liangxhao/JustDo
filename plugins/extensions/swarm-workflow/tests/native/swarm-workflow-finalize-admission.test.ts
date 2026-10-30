import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';

import { buildSync } from 'esbuild';
import { expect, it, vi } from 'vitest';

const nativeRequire = createRequire(import.meta.url);
const pluginRoot = path.resolve(import.meta.dirname, '../..');
const code = buildSync({
  entryPoints: [path.join(pluginRoot, 'service/hooks.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  write: false,
  external: ['openclaw/plugin-sdk/*'],
}).outputFiles[0].text;

function fixture() {
  const identity = {
    sessionKey: 'agent:main:justdo:parent',
    sessionId: 'native-parent',
    runId: 'native-run',
  };
  const parent = {
    sessionId: identity.sessionId,
    sessionRoot: '/project',
    permissionMode: 'workspace',
  };
  const hooks = new Map<string, any>();
  const options = new Map<string, any>();
  const flows: any[] = [];
  const owner = vi.fn(() => undefined as any);
  const submissionOwner = vi.fn((_key: string, _run: string): any => {
    throw new Error('No exact submission owner');
  });
  const requireSubmissionCorrection = vi.fn();
  const store = { all: vi.fn(() => flows), batches: { owner } };
  const engine = { submissionOwner, requireSubmissionCorrection };
  const state = {
    generation: 4,
    startTurns: new Map<string, any>(),
    store,
    engine,
  };
  let available = true;
  let identityReadFails = false;
  const ensure = () => {
    if (!available) throw new Error('Workflow service is unavailable');
    return { store, engine };
  };
  const history: any[] = [];
  const rpc = vi.fn(async () => ({ messages: history }));
  const assertParent = vi.fn();
  const api = {
    on(name: string, handler: any, registration: any) {
      hooks.set(name, handler);
      options.set(name, registration);
    },
  };
  const moduleBox = { exports: {} as any };
  vm.runInNewContext(code, {
    exports: moduleBox.exports,
    module: moduleBox,
    Date,
    Buffer,
    require: (name: string) =>
      name === 'openclaw/plugin-sdk/session-store-runtime'
        ? {
            getSessionEntry: () => {
              if (identityReadFails) throw new Error('Native identity unavailable');
              return parent;
            },
          }
        : nativeRequire(name),
  });
  const context = {
    api,
    state,
    ensure,
    rpc,
    assertParent,
    resultBudgets: { observe: vi.fn(), release: vi.fn() },
    submissionCalls: new Map(),
    managementCalls: new Map(),
    callKey: (...parts: string[]) => JSON.stringify(parts),
  };
  moduleBox.exports.registerWorkflowExecutionHooks(context);
  moduleBox.exports.registerWorkflowPromptHooks(context);
  return {
    identity,
    parent,
    hooks,
    flows,
    state,
    owner,
    submissionOwner,
    requireSubmissionCorrection,
    store,
    history,
    rpc,
    applies: (ctx: any = identity) => options.get('before_agent_finalize').appliesToAgentRun(ctx),
    finalize: (ctx: any = identity) =>
      hooks.get('before_agent_finalize')(
        {
          ...ctx,
          messages: [],
          stopHookActive: false,
        },
        ctx,
      ),
    set available(value: boolean) {
      available = value;
    },
    set identityReadFails(value: boolean) {
      identityReadFails = value;
    },
  };
}

it('excludes confirmed ordinary turns without using prompt markers as ownership', () => {
  const f = fixture();
  expect(f.applies()).toBe(false);
  expect(f.applies({ ...f.identity, prompt: '<swarm-workflow mode="auto"/>' })).toBe(false);
  expect(f.submissionOwner).toHaveBeenCalledWith(f.identity.sessionKey, f.identity.runId);
  expect(f.rpc).not.toHaveBeenCalled();
});

it('selects an exact admitted start only after prompt preparation creates its owner', async () => {
  const f = fixture();
  expect(f.applies()).toBe(false);
  const message = 'Inspect the project\n\n<swarm-workflow mode="auto"/>';
  f.history.push({ role: 'user', content: message, idempotencyKey: 'admitted-input' });
  await f.hooks.get('before_prompt_build')(
    {
      currentUserMessage: message,
      currentUserMessageId: 'admitted-input',
    },
    f.identity,
  );
  expect(f.state.startTurns.get(f.identity.sessionKey + '\n' + f.identity.runId)).toMatchObject({
    parentId: f.identity.sessionId,
    requestId: 'admitted-input',
    generation: 4,
  });
  expect(f.applies()).toBe(true);
  expect(await f.finalize()).toMatchObject({
    action: 'revise',
    retry: { idempotencyKey: 'swarm-workflow-start:admitted-input' },
  });
  expect(f.applies({ ...f.identity, runId: 'ordinary-other-run' })).toBe(false);
});

it('keeps tools closed when source identity cannot be read during prompt preparation', async () => {
  const f = fixture();
  f.identityReadFails = true;
  const message = 'Inspect\n\n<swarm-workflow mode="auto"/>';
  const result = await f.hooks.get('before_prompt_build')(
    {
      currentUserMessage: message,
      currentUserMessageId: 'source:user',
    },
    f.identity,
  );
  expect(result.toolsAllow).toEqual([]);
  expect(f.state.startTurns.size).toBe(0);
  expect(f.rpc).not.toHaveBeenCalled();
});

it('protects stale start admission without authorizing a new generation or incarnation', async () => {
  const f = fixture();
  f.state.startTurns.set(f.identity.sessionKey + '\n' + f.identity.runId, {
    generation: 3,
    expiresAt: Date.now() + 30000,
    parentId: f.identity.sessionId,
  });
  expect(f.applies()).toBe(true);
  expect(await f.finalize()).toBeUndefined();
  f.parent.sessionId = 'replacement';
  expect(f.applies()).toBe(true);
  expect(await f.finalize()).toBeUndefined();
  expect(f.requireSubmissionCorrection).not.toHaveBeenCalled();
});

it('retains exact work submission correction and rejects another run on the same session', async () => {
  const f = fixture();
  const node = {
    sessionKey: f.identity.sessionKey,
    runId: f.identity.runId,
    kind: 'work',
    completionMode: 'tool',
  };
  const flow = { nodes: [node] };
  f.flows.push(flow);
  f.submissionOwner.mockImplementation((key, run) => {
    if (key !== node.sessionKey || run !== node.runId) throw new Error('Wrong run');
    return { flow, node };
  });
  expect(f.applies()).toBe(true);
  await f.finalize();
  expect(f.requireSubmissionCorrection).toHaveBeenCalledWith(
    node.sessionKey,
    node.runId,
    expect.stringContaining('submission'),
  );
  f.requireSubmissionCorrection.mockClear();
  const wrong = { ...f.identity, runId: 'other-run' };
  expect(f.applies(wrong)).toBe(true);
  expect(await f.finalize(wrong)).toBeUndefined();
  expect(f.requireSubmissionCorrection).not.toHaveBeenCalled();
});

it('does not treat incomplete ownership, native identity or unavailable state as absence', () => {
  const f = fixture();
  expect(f.applies({ ...f.identity, sessionId: undefined })).toBe(true);
  expect(f.applies({ ...f.identity, runId: undefined })).toBe(true);
  expect(f.applies({ ...f.identity, sessionId: 'old-native' })).toBe(true);
  f.owner.mockReturnValue({ flowId: 'flow', nodeId: 'retained-item' });
  expect(f.applies()).toBe(true);
  f.owner.mockReturnValue(undefined);
  f.store.all.mockImplementation(() => {
    throw new Error('Unreadable durable ownership');
  });
  expect(f.applies()).toBe(true);
  f.available = false;
  expect(f.applies()).toBe(true);
  f.identityReadFails = true;
  expect(f.applies()).toBe(true);
});
