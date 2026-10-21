import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { build } from 'esbuild';
import ts from 'typescript';
import { beforeAll, describe, expect, it, type Mock, vi } from 'vitest';

import { reduceAgentEvent } from '../../../../src/renderer/libs/openclaw-chat/model/turn/agent-event-reducer';
import { createChatTranscriptState } from '../../../../src/renderer/libs/openclaw-chat/model/chat-transcript-state';
import { projectTurnItems } from '../../../../src/renderer/libs/openclaw-chat/model/timeline/project-turn-items';

type Message = {
  content: Array<{ type: string; text?: string; thinking?: string; textSignature?: string; arguments?: unknown }>;
  stopReason: string;
  openclawDelivery?: { textPhaseRequiresTerminal?: boolean; structuredTextStreaming?: boolean; messageScopeId?: string };
};
type Event = { type: string; delta?: string; partial?: Message; message?: Message; error?: Message };
type NativeApi = {
  createOpenAICompletionsTransportStreamFn: () => (
    model: object,
    context: object,
    options: object,
  ) => AsyncIterable<Event> & { result(): Promise<Message> };
  createAiTransportHost: (options: { buildModelFetch: () => typeof fetch }) => object;
  runWithAiTransportHost: <T>(host: object, run: () => T) => T;
  reasoningTagTextPolicy: { markStrict(options: object): void };
};
type SubscriberEvent = { stream: string; data: Record<string, unknown> & { text?: string; replace?: boolean; itemId?: string } };
type SubscriberContext = {
  params: {
    onAgentEvent: Mock<(event: SubscriberEvent) => void>;
    onPartialReply: Mock<(reply: { text: string }) => void>;
    onBlockReply: Mock<(reply: { text: string }) => void>;
    [key: string]: unknown;
  };
  blockChunker: { hasBuffered(): boolean };
  [key: string]: unknown;
};
type SubscriberApi = {
  handleMessageStart(context: SubscriberContext, event: object): unknown;
  handleMessageUpdate(context: SubscriberContext, event: object): unknown;
  handleMessageEnd(context: SubscriberContext, event: object): unknown;
  createEmbeddedAgentSubscribeState(params: object): object;
  createReplyDelivery(context: SubscriberContext): Record<string, unknown>;
  createStreamRendering(context: object): object;
  EmbeddedBlockChunker: new () => SubscriberContext['blockChunker'];
};
const { transform, CONTRACT } = require('../../../../scripts/patches/v2026.10.4/029-reasoning-completions-streaming.cjs').__testing;
const { functionRange } = require('../../../../scripts/patches/v2026.10.4/prepared-read-patch-shapes.js');
const runtime = process.env.JUSTDO_EXECUTION_PRISTINE_DIR ?? path.resolve('vendor/openclaw-runtime/current');
const ai = path.join(runtime, 'node_modules/@openclaw/ai/dist');
const transport = fs.readdirSync(ai).find(name => /^openai-completions-transport-.*\.mjs$/.test(name))!;
const host = fs.readdirSync(ai).find(name => /^host-.*\.mjs$/.test(name) &&
  fs.readFileSync(path.join(ai, name), 'utf8').includes('function createAiTransportHost('))!;
const sourceAlreadyPatched = fs.readFileSync(path.join(ai, transport), 'utf8').includes(CONTRACT);
const model = {
  id: 'arbitrary-reasoner', name: 'Synthetic fixture', api: 'openai-completions', provider: 'arbitrary-provider',
  baseUrl: 'https://fixture.invalid/v1', reasoning: true, input: ['text'],
  contextWindow: 8192, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = { messages: [{ role: 'user', content: 'Synthetic fixture', timestamp: 0 }] };
let patched: NativeApi;
let pristine: NativeApi;
let subscriber: SubscriberApi;
let pristineSubscriber: SubscriberApi;
let wireProjection: (payload: object, session: string, agent: string, visible: boolean) => {
  snapshot: boolean; delta(payload: object): SubscriberEvent;
};
type ProgressEvent = { runId: string; seq: number; stream: string; data: Record<string, unknown> };
type ProgressSnapshot = { events: ProgressEvent[]; lastSeq: number; byteLength: number };
let updateProgress: (snapshot: ProgressSnapshot | undefined, event: ProgressEvent, mode?: string) => ProgressSnapshot;

// Select real native declarations and their lexical dependencies, excluding
// unrelated top-level initialization from the large built-in agent bundle.
function nativeDeclarationClosure(source: string, file: string, names: string[]) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declarations = new Map<string, ts.Statement>();
  const register = (binding: ts.BindingName, statement: ts.Statement) => {
    if (ts.isIdentifier(binding)) declarations.set(binding.text, statement);
    else for (const element of binding.elements)
      if (ts.isBindingElement(element)) register(element.name, statement);
  };
  for (const statement of sourceFile.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name)
      declarations.set(statement.name.text, statement);
    else if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) register(declaration.name, statement);
    else if (ts.isImportDeclaration(statement)) {
      if (statement.importClause?.name) declarations.set(statement.importClause.name.text, statement);
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements) declarations.set(element.name.text, statement);
      else if (bindings) declarations.set(bindings.name.text, statement);
    }
  }
  const selected = new Set<ts.Statement>();
  const add = (statement: ts.Statement) => {
    if (selected.has(statement)) return;
    selected.add(statement);
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node)) {
        const declaration = declarations.get(node.text);
        if (declaration) add(declaration);
      }
      ts.forEachChild(node, visit);
    };
    visit(statement);
  };
  for (const name of names) {
    const declaration = declarations.get(name);
    if (!declaration) throw new Error(`Native fixture declaration missing: ${name}`);
    add(declaration);
  }
  return [...selected].sort((left, right) => left.pos - right.pos)
    .map(statement => statement.getText(sourceFile)).join('\n') + `\nexport { ${names.join(', ')} };`;
}

async function loadSubscriber(applyPatch = true) {
  const file = path.join(runtime, 'dist/builtin-openclaw-qVsnLx0N.mjs');
  const nativeSource = fs.readFileSync(file, 'utf8');
  if (!applyPatch && nativeSource.includes(CONTRACT))
    throw new Error('Pristine subscriber control requires an unpatched source');
  const source = nativeDeclarationClosure(applyPatch ? transform(nativeSource, file) : nativeSource, file, [
    'handleMessageStart', 'handleMessageUpdate', 'handleMessageEnd', 'createEmbeddedAgentSubscribeState',
    'createReplyDelivery', 'createStreamRendering', 'EmbeddedBlockChunker',
  ]);
  const result = await build({
    stdin: { contents: source, resolveDir: path.dirname(file), sourcefile: 'subscriber-fixture.mjs' },
    bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent',
    nodePaths: [path.join(runtime, 'node_modules'), path.resolve('vendor/openclaw-runtime/win-x64/node_modules')],
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(file).href) },
  });
  const loaded = { exports: {} as SubscriberApi };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(
    createRequire(file), loaded, loaded.exports,
  );
  return loaded.exports;
}

async function loadProgressSnapshot() {
  const file = path.join(runtime, 'dist/server-chat-state-BP63MB41.mjs');
  const source = nativeDeclarationClosure(transform(fs.readFileSync(file, 'utf8'), file), file,
    ['updateChatRunProgressSnapshot']);
  const result = await build({
    stdin: { contents: source, resolveDir: path.dirname(file), sourcefile: 'progress-fixture.mjs' },
    bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent',
    nodePaths: [path.join(runtime, 'node_modules')],
  });
  const loaded = { exports: {} as { updateChatRunProgressSnapshot: typeof updateProgress } };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(
    createRequire(file), loaded, loaded.exports,
  );
  return loaded.exports.updateChatRunProgressSnapshot;
}

function subscriberContext(paramsOverride: object = {}, api = subscriber) {
  const params = { runId: 'reasoning-stream-fixture', session: { id: 'fixture-session' },
    onPartialReply: vi.fn<(reply: { text: string }) => void>(),
    onAgentEvent: vi.fn<(event: SubscriberEvent) => void>(),
    onBlockReply: vi.fn<(reply: { text: string }) => void>(),
    blockReplyBreak: 'message_end', blockReplyChunking: { minChars: 1, maxChars: 100 },
    ...paramsOverride };
  const state = api.createEmbeddedAgentSubscribeState(params);
  const context: SubscriberContext = { params, state, log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    captureModelEvent: vi.fn(), blockChunker: new api.EmbeddedBlockChunker(),
    blockChunking: params.blockReplyChunking };
  const delivery = api.createReplyDelivery(context);
  Object.assign(context, delivery);
  Object.assign(context, api.createStreamRendering({ ...context,
    pendingBlockReplyTasks: delivery.pendingBlockReplyTasks,
    pushAssistantText: delivery.pushAssistantText,
    shouldSkipAssistantText: delivery.shouldSkipAssistantText }));
  return context;
}

async function loadTransport(applyPatch: boolean): Promise<NativeApi> {
  const entry = [
    `export { t as createOpenAICompletionsTransportStreamFn } from ${JSON.stringify(path.join(ai, transport))};`,
    `export { n as createAiTransportHost, o as runWithAiTransportHost } from ${JSON.stringify(path.join(ai, host))};`,
    `export { reasoningTagTextPolicy } from ${JSON.stringify(path.join(ai, 'internal/openai.mjs'))};`,
  ].join('\n');
  const result = await build({
    stdin: { contents: entry, resolveDir: process.cwd(), sourcefile: 'synthetic-transport.mjs' },
    bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'silent',
    nodePaths: [path.join(runtime, 'node_modules'), path.resolve('vendor/openclaw-runtime/win-x64/node_modules')],
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(path.join(ai, transport)).href) },
    plugins: applyPatch ? [{
      name: 'structured-reasoning-fixture',
      setup(builder) {
        builder.onLoad({ filter: /(?:openai-completions-transport|reasoning-tag-text-partitioner)-.*\.mjs$/ }, async args => {
          const source = await fs.promises.readFile(args.path, 'utf8');
          return { contents: transform(source, args.path), loader: 'js' };
        });
      },
    }] : [],
  });
  const loaded = { exports: {} as NativeApi };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(
    createRequire(path.join(ai, transport)), loaded, loaded.exports,
  );
  return loaded.exports;
}

async function fixture(api: NativeApi, override: object = {}, signal?: AbortSignal, strict = false,
  subscriberContext?: SubscriberContext, subscriberApi = subscriber) {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let requestStarted!: () => void;
  const requested = new Promise<void>(resolve => { requestStarted = resolve; });
  const requests: object[] = [];
  const encoder = new TextEncoder();
  const response = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const fetchFixture: typeof fetch = async (input, options) => {
    const request = new Request(input, options);
    requests.push(await request.json());
    request.signal.addEventListener('abort', () => controller.error(request.signal.reason), { once: true });
    requestStarted();
    return new Response(response, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const events: Event[] = [];
  const done = api.runWithAiTransportHost(api.createAiTransportHost({ buildModelFetch: () => fetchFixture }), async () => {
    const options = {
      apiKey: 'synthetic-fixture', reasoning: 'high', timeoutMs: 5000, signal,
    };
    if (strict) api.reasoningTagTextPolicy.markStrict(options);
    const stream = api.createOpenAICompletionsTransportStreamFn()({ ...model, ...override }, context, options);
    let latestPartial: Message | undefined;
    for await (const event of stream) {
      events.push(structuredClone(event));
      latestPartial = event.partial ?? latestPartial;
      if (subscriberContext) {
        if (event.type === 'done' || event.type === 'error') {
          await subscriberApi.handleMessageEnd(subscriberContext, { type: 'message_end',
            message: structuredClone(event.message ?? event.error) });
        } else if (event.type !== 'start' && latestPartial) {
          const partial = structuredClone(latestPartial);
          await subscriberApi.handleMessageUpdate(subscriberContext, { type: 'message_update',
            message: partial, assistantMessageEvent: { ...structuredClone(event), partial } });
        }
      }
    }
    return stream.result();
  });
  await Promise.race([requested, done.then(result => {
    throw new Error(`Synthetic fetch was not reached: ${JSON.stringify(result)}`);
  })]);
  const send = async (delta: object, finishReason: string | null = null) => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify({
      id: 'synthetic-response', object: 'chat.completion.chunk', created: 0, model: model.id,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`));
    await nextTurn();
    await nextTurn();
  };
  return {
    events, requests, send, done,
    async finish(reason = 'stop') {
      await send({}, reason);
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
      return done;
    },
    fail(error: Error) { controller.error(error); return done; },
    eof() { controller.close(); return done; },
  };
}
const deltas = (events: Event[]) => events.filter(event => event.type === 'text_delta').map(event => event.delta);
const text = (message: Message) => message.content.filter(block => block.type === 'text').map(block => block.text).join('');

function visibleContent(events: SubscriberEvent[]) {
  const transcript = createChatTranscriptState('fixture-session-key', null);
  let nextId = 0;
  for (const [index, event] of events.entries()) {
    reduceAgentEvent(transcript, {
      ...event, runId: 'reasoning-stream-fixture', sessionKey: 'fixture-session-key',
      sessionId: null, lifecycleGeneration: null, agentId: null, spawnedBy: null,
      agentSeq: index + 1, frameSeq: null, deliveryEvent: 'agent', timestamp: index + 1,
    }, { now: () => index + 1, createId: prefix => `${prefix}-${++nextId}` });
  }
  return projectTurnItems(transcript.activeTurn).flatMap(item =>
    item.kind === 'content' ? [item.item.text] : []);
}

beforeAll(async () => {
  if (sourceAlreadyPatched) {
    pristine = patched = await loadTransport(true);
  } else {
    [pristine, patched] = await Promise.all([loadTransport(false), loadTransport(true)]);
  }
  subscriber = await loadSubscriber();
  if (!sourceAlreadyPatched) pristineSubscriber = await loadSubscriber(false);
  updateProgress = await loadProgressSnapshot();
  const wireSource = fs.readFileSync(path.join(runtime, 'dist/server-chat-BdeVtCxj.mjs'), 'utf8');
  wireProjection = new Function(
    functionRange(wireSource, 'projectAssistantWireDelta').text + '\n' +
    functionRange(wireSource, 'assistantWireProjection').text + '\nreturn assistantWireProjection;',
  )();
}, 30_000);

it('preserves the preview prefix through the actual native delta-only final wire projection', () => {
  const final = { stream: 'assistant', data: { itemId: 'body-1', text: 'Checking. More.', delta: ' More.',
    assistantTextScope: { id: 'source-1', commentaryItemIds: [] } } };
  const wire = wireProjection(final, 'session', 'main', true);
  expect(wire.snapshot).toBe(false);
  const delivered = wire.delta(final);
  expect(delivered.data.text).toBeUndefined();
  expect(visibleContent([
    { stream: 'assistant', data: { itemId: 'body-1', text: 'Checking.', assistantTextScope: { id: 'source-1' } } },
    { stream: 'item', data: { kind: 'preamble', phase: 'update', itemId: 'commentary-1',
      progressText: 'Checking.', assistantTextScope: { id: 'source-1' } } },
    delivered,
  ])).toEqual(['Checking. More.']);
});

describe('native bounded message snapshots', () => {
  function setup(mode = 'full') {
    let snapshot: ProgressSnapshot | undefined;
    let seq = 0;
    const emit = (stream: string, data: Record<string, unknown>, sequence = ++seq) => {
      snapshot = updateProgress(snapshot, { runId: 'reasoning-stream-fixture', seq: sequence, stream, data }, mode);
      return snapshot;
    };
    const assistant = (text: string, itemId = 'preview-1', commentaryItemIds?: string[]) => emit('assistant', {
      text, itemId, assistantTextScope: { id: 'source-1',
        ...(commentaryItemIds === undefined ? {} : { commentaryItemIds }) },
    });
    const preamble = () => emit('item', { kind: 'preamble', phase: 'end', itemId: 'commentary-1',
      progressText: 'Checking.', assistantTextScope: { id: 'source-1' } });
    return { emit, assistant, preamble };
  }

  it.each(['full', 'summary'])('retains rollback facts through native %s capture and Renderer replay', mode => {
    const { assistant, preamble } = setup(mode);
    assistant('Checking.');
    preamble();
    const result = assistant('Final.', 'preview-1', []);
    expect(visibleContent(result.events)).toEqual(['Final.']);
    expect(result.events).toHaveLength(2);
    expect(Object.isFrozen(result.events[1].data)).toBe(true);
  });

  it.each(['Different.', 'Checking.'])('retains the following unstructured message by its own native owner: %s', final => {
    const { assistant, preamble, emit } = setup();
    assistant('Checking.');
    preamble();
    const result = emit('assistant', { text: final, itemId: 'answer-2' });
    expect(visibleContent(result.events)).toEqual(['Checking.', final]);
    expect(result.events.map(event => event.data.itemId)).toEqual(['preview-1', 'commentary-1', 'answer-2']);
  });

  it('inherits source facts only for a later native correction of the exact assistant owner', () => {
    const { assistant, emit } = setup();
    assistant('Final.', 'preview-1', []);
    const result = emit('assistant', { text: '', replace: true, itemId: 'preview-1' });
    expect(result.events[0].data.assistantTextScope).toEqual({ id: 'source-1', commentaryItemIds: [] });
    expect(emit('assistant', { text: 'Other.', itemId: 'answer-2' }).events[1].data.assistantTextScope).toBeUndefined();
  });

  it('preserves exact completion facts when text exceeds the native per-event budget', () => {
    const { preamble, assistant } = setup();
    preamble();
    const result = assistant('x'.repeat(70_000), 'preview-1', []);
    expect(result.events[1].data).toMatchObject({ assistantTextSnapshot: true,
      assistantTextScope: { id: 'source-1', commentaryItemIds: [] } });
    expect(result.events[1].data.text).toBeUndefined();
    expect(visibleContent(result.events)).toEqual([]);
    expect(result.byteLength).toBeLessThan(65536);
  });

  it('evicts related previews and preambles together within the original native budget', () => {
    const { preamble, assistant, emit } = setup();
    assistant('Checking.');
    preamble();
    let result: ProgressSnapshot;
    for (let index = 0; index < 50; index++) result = emit('assistant', { text: 'Next.', itemId: `other-${index}` });
    expect(result!.events).toHaveLength(50);
    expect(result!.events.some(event => event.data.assistantTextScope)).toBe(false);
    expect(result!.byteLength).toBeGreaterThan(0);
    expect(result!.byteLength).toBeLessThanOrEqual(131072);
  });

  it('removes an entire unsafe scope if even its completion metadata exceeds the budget', () => {
    const { assistant, preamble } = setup();
    assistant('Checking.');
    preamble();
    expect(assistant('Final.', 'preview-1', ['x'.repeat(70_000)]).events).toEqual([]);
  });

  it('retains native sequence admission and leaves unkeyed assistant producers on the legacy path', () => {
    const { assistant, emit } = setup();
    assistant('Final.', 'preview-1', []);
    expect(emit('assistant', { text: 'Old.', itemId: 'preview-1' }, 1).events[0].data.text).toBe('Final.');
    expect(emit('assistant', { text: 'Unknown producer.' }).events).toHaveLength(1);
  });
});

describe('actual completions transport structured reasoning semantics', () => {
  it.skipIf(sourceAlreadyPatched)('audits unpatched subscriber behavior when stop rolls back a provisional tool', async () => {
    const context = subscriberContext({}, pristineSubscriber);
    const run = await fixture(pristine, {}, undefined, false, context, pristineSubscriber);
    await run.send({ reasoning_content: 'Private thought.' });
    await run.send({ content: 'Checking.' });
    await run.send({ tool_calls: [{ index: 0, id: 'rollback-tool', type: 'function',
      function: { name: 'read_file', arguments: '{"path":' } }] });
    const result = await run.finish('stop');
    const events = context.params.onAgentEvent.mock.calls.map(([event]) => event);
    expect(result.content.some(block => block.type === 'toolCall')).toBe(false);
    expect(result.content.filter(block => block.type === 'text').map(block => block.textSignature))
      .toEqual([undefined]);
    expect(visibleContent(events)).toEqual(['Checking.', 'Checking.']);
  });

  it('releases arbitrary-provider text in separate packets before the gated terminal', async () => {
    const implementations: Array<[NativeApi, boolean]> = sourceAlreadyPatched
      ? [[patched, true]] : [[pristine, false], [patched, true]];
    for (const [api, early] of implementations) {
      const run = await fixture(api);
      await run.send({ reasoning_content: 'Private thought.' });
      await run.send({ content: 'Alpha ' });
      await run.send({ content: 'Beta' });
      expect(deltas(run.events)).toEqual(early ? ['Alpha ', 'Beta'] : []);
      const result = await run.finish();
      expect(text(result)).toBe('Alpha Beta');
      expect(result.openclawDelivery?.textPhaseRequiresTerminal).toBe(true);
      expect(result.openclawDelivery?.structuredTextStreaming === true).toBe(early);
    }
  });

  it('retains ordinary plain-text streaming', async () => {
    const run = await fixture(patched, { reasoning: false });
    await run.send({ content: 'Alpha ' });
    await run.send({ content: 'Beta' });
    expect(deltas(run.events)).toEqual(['Alpha ', 'Beta']);
    expect(text(await run.finish())).toBe('Alpha Beta');
  });

  it.each([
    { baseUrl: 'http://127.0.0.1:9988/custom/api' },
    { id: 'previously-unknown-model', provider: 'different-provider' },
  ])('streams protocol lanes independently of model or endpoint %j', async override => {
    const run = await fixture(patched, override);
    await run.send({ reasoning_content: 'Private thought.' });
    await run.send({ content: 'Public answer.' });
    expect(deltas(run.events)).toEqual(['Public answer.']);
    expect(text(await run.finish())).toBe('Public answer.');
  });

  it('allows coalesced dedicated reasoning and public content', async () => {
    const run = await fixture(patched);
    await run.send({ reasoning_content: 'Private thought.', content: 'Public answer.' });
    expect(deltas(run.events)).toEqual(['Public answer.']);
    expect(text(await run.finish())).toBe('Public answer.');
  });

  it('streams public content when native reasoning emission is disabled', async () => {
    const run = await fixture(patched, { reasoning: false });
    await run.send({ reasoning_content: 'Private thought.' });
    await run.send({ content: 'Public answer.' });
    expect(run.events.some(event => event.type === 'thinking_delta')).toBe(false);
    expect(deltas(run.events)).toEqual(['Public answer.']);
    const result = await run.finish();
    expect(text(result)).toBe('Public answer.');
    expect(result.content.some(block => block.type === 'thinking')).toBe(false);
  });

  it('retains explicit strict policy and retroactive private-prefix filtering', async () => {
    const run = await fixture(patched, {}, undefined, true);
    await run.send({ reasoning_content: 'Private thought.' });
    await run.send({ content: 'PRIVATE PREFIX' });
    await run.send({ content: '</think>PUBLIC' });
    expect(deltas(run.events)).toEqual([]);
    const result = await run.finish();
    expect(text(result)).toBe('PUBLIC');
    expect(result.openclawDelivery?.structuredTextStreaming).not.toBe(true);
  });

  it.each(['reasoning_content', 'reasoning', 'reasoning_text', 'reasoning_details'])
  ('streams every native recognized dedicated reasoning field %s', async field => {
    const run = await fixture(patched);
    await run.send(field === 'reasoning_details'
      ? { reasoning_details: [{ type: 'reasoning.text', text: 'Private thought.' }] }
      : { [field]: 'Private thought.' });
    await run.send({ content: 'Public answer.' });
    expect(deltas(run.events)).toEqual(['Public answer.']);
    const result = await run.finish();
    expect(text(result)).toBe('Public answer.');
    expect(result.openclawDelivery?.structuredTextStreaming).toBe(true);
  });

  it('streams normalized typed thinking and typed public text', async () => {
    const run = await fixture(patched);
    await run.send({ content: [{ type: 'reasoning', text: 'Structured private thought.' },
      { type: 'output_text', text: 'Public answer.' }] });
    expect(deltas(run.events)).toEqual(['Public answer.']);
    const result = await run.finish();
    expect(text(result)).toBe('Public answer.');
    expect(result.content.filter(block => block.type === 'thinking').map(block => block.thinking).join(''))
      .toBe('Structured private thought.');
    expect(result.openclawDelivery?.structuredTextStreaming).toBe(true);
  });

  it('preserves native pending-syntax phase boundaries when reasoning resumes inside a split tag', async () => {
    const run = await fixture(patched);
    await run.send({ reasoning_content: 'First thought.' });
    await run.send({ content: 'Interim. <thi' });
    await run.send({ reasoning_content: 'Second thought.', content: 'nk>SECRET</think>Final.' });
    const result = await run.finish();
    expect(text(result)).toBe('Interim. Final.');
    expect(result.content.filter(block => block.type === 'text').map(block => block.textSignature))
      .toEqual([undefined, undefined]);
    expect(deltas(run.events).join('')).not.toContain('SECRET');
  });

  it('keeps a split inline tag private when structured reasoning starts later', async () => {
    const run = await fixture(patched);
    await run.send({ content: '<thi' });
    await run.send({ reasoning_content: 'Private thought.', content: 'nk>SECRET</think>SAFE' });
    const result = await run.finish();
    expect(text(result)).toBe('SAFE');
    expect(deltas(run.events).join('')).not.toContain('SECRET');
    expect(result.openclawDelivery?.structuredTextStreaming).toBe(true);
  });

  const reasoningTagSplits = [
    { open: '<think>', close: '</think>' },
    { open: '<mm:think>', close: '</mm:think>' },
    { open: '<think mode="private">', close: '</think>' },
    { open: "<think data-note='quoted > attr'>", close: '</think>' },
  ].flatMap(tag => Array.from({ length: tag.open.length - 1 }, (_, index) => ({
    ...tag, split: index + 1,
  })));

  const assertPrivateTextAbsent = (events: Event[], subscriberContext: SubscriberContext) => {
    expect(deltas(events).join('')).not.toContain('SECRET');
    expect(subscriberContext.params.onAgentEvent.mock.calls
      .filter(([event]) => event.stream === 'assistant')
      .map(([event]) => event.data.text ?? '').join('')).not.toContain('SECRET');
    expect(subscriberContext.params.onPartialReply.mock.calls
      .map(([reply]) => reply.text).join('')).not.toContain('SECRET');
    expect(subscriberContext.params.onBlockReply.mock.calls
      .map(([reply]) => reply.text).join('')).not.toContain('SECRET');
  };

  it.each(reasoningTagSplits)
  ('preserves split $open at $split across a separate reasoning-only packet and same-packet stop', async ({ open, close, split }) => {
    const context = subscriberContext();
    const run = await fixture(patched, {}, undefined, false, context);
    await run.send({ content: open.slice(0, split) });
    await run.send({ reasoning_content: 'Dedicated thought.' });
    assertPrivateTextAbsent(run.events, context);
    await run.send({ content: `${open.slice(split)}SECRET${close}SAFE` }, 'stop');
    assertPrivateTextAbsent(run.events, context);
    const result = await run.eof();
    expect(text(result)).toBe('SAFE');
    assertPrivateTextAbsent(run.events, context);
  });

  it.each(reasoningTagSplits)
  ('preserves split $open at $split across a separate native tool packet and same-packet stop', async ({ open, close, split }) => {
    const context = subscriberContext();
    const run = await fixture(patched, {}, undefined, false, context);
    await run.send({ reasoning_content: 'Dedicated thought.' });
    await run.send({ content: open.slice(0, split) });
    await run.send({ tool_calls: [{ index: 0, id: 'interrupted_tag_tool', type: 'function',
      function: { name: 'read_file', arguments: '{"path":"fixture"}' } }] });
    assertPrivateTextAbsent(run.events, context);
    await run.send({ content: `${open.slice(split)}SECRET${close}SAFE` }, 'stop');
    assertPrivateTextAbsent(run.events, context);
    const result = await run.eof();
    expect(text(result)).toBe('SAFE');
    // A native stop intentionally does not promote the interrupted tool call.
    assertPrivateTextAbsent(run.events, context);
  });

  it('restores native terminal phases when reasoning resumes after public text', async () => {
    const run = await fixture(patched);
    await run.send({ reasoning_content: 'First thought.' });
    await run.send({ content: 'Interim.' });
    expect(deltas(run.events)).toEqual(['Interim.']);
    await run.send({ reasoning_content: 'Second thought.' });
    await run.send({ content: 'Final.' });
    expect(deltas(run.events)).toEqual(['Interim.', 'Final.']);
    const result = await run.finish();
    const phases = result.content.filter(block => block.type === 'text').map(block => ({
      text: block.text, phase: JSON.parse(block.textSignature!).phase,
    }));
    expect(phases).toEqual([{ text: 'Interim.', phase: 'commentary' }, { text: 'Final.', phase: 'final_answer' }]);
    expect(result.openclawDelivery?.structuredTextStreaming).toBe(true);
  });

  it.each(['<think>', '<mm:think>'])('hides split inline reasoning %s while public text remains separate', async open => {
    const close = open.replace('<', '</');
    const run = await fixture(patched);
    await run.send({ reasoning_content: 'Structured private thought.' });
    await run.send({ content: open.slice(0, 3) });
    await run.send({ content: `${open.slice(3)}SECRET${close}SAFE` });
    expect(deltas(run.events).join('')).not.toContain('SECRET');
    const result = await run.finish();
    expect(text(result)).toBe('SAFE');
    expect(result.openclawDelivery?.structuredTextStreaming).toBe(true);
  });

  it('preserves literal reasoning tags inside closed Markdown code', async () => {
    const run = await fixture(patched);
    await run.send({ reasoning_content: 'Private thought.' });
    await run.send({ content: 'Use `<think>example</think>` as code.' });
    expect(text(await run.finish())).toBe('Use `<think>example</think>` as code.');
  });

  it('marks unresolved visible text as commentary on transport failure', async () => {
    const run = await fixture(patched);
    await run.send({ reasoning_content: 'Private thought.' });
    await run.send({ content: 'Unresolved answer.' });
    const result = await run.fail(new Error('Synthetic transport failure'));
    expect(result.stopReason).toBe('error');
    expect(JSON.parse(result.content.find(block => block.type === 'text')!.textSignature!).phase).toBe('commentary');
  });

  it('honors abort without promoting a partial answer', async () => {
    const abort = new AbortController();
    const run = await fixture(patched, {}, abort.signal);
    await run.send({ reasoning_content: 'Private thought.' });
    await run.send({ content: 'Interrupted answer.' });
    abort.abort(new Error('Synthetic cancellation'));
    const result = await run.done;
    expect(result.stopReason).toBe('aborted');
    expect(JSON.parse(result.content.find(block => block.type === 'text')!.textSignature!).phase).toBe('commentary');
  });

  it('keeps incomplete EOF as failure and hides any unfinished private tag', async () => {
    const run = await fixture(patched);
    await run.send({ reasoning_content: 'Private thought.' });
    await run.send({ content: '<think>SECRET' });
    const result = await run.eof();
    expect(result.stopReason).toBe('error');
    expect(text(result)).toBe('');
    expect(deltas(run.events).join('')).not.toContain('SECRET');
  });

  it('retains exact native tool arguments and commentary classification', async () => {
    const run = await fixture(patched);
    await run.send({ reasoning_content: 'Private thought.' });
    await run.send({ content: 'Checking a file.' });
    await run.send({ tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: {
      name: 'read_file', arguments: '{"path":"<think>literal</think>",',
    } }] });
    await run.send({ tool_calls: [{ index: 0, function: { arguments: '"count":2}' } }] });
    const result = await run.finish('tool_calls');
    expect(result.stopReason).toBe('toolUse');
    expect(result.content.find(block => block.type === 'toolCall')?.arguments).toEqual({ path: '<think>literal</think>', count: 2 });
    expect(JSON.parse(result.content.find(block => block.type === 'text')!.textSignature!).phase).toBe('commentary');
  });

  it('lets the Renderer transfer the preview while tool arguments are still streaming', async () => {
    const context = subscriberContext();
    const run = await fixture(patched, {}, undefined, false, context);
    await run.send({ reasoning_content: 'Private thought.' });
    await run.send({ content: 'Checking a file.' });
    const preview = context.params.onAgentEvent.mock.calls.map(([event]) => event)
      .filter(event => event.stream === 'assistant').at(-1)!;
    await run.send({ tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: {
      name: 'read_file', arguments: '{"path":',
    } }] });
    await run.send({ tool_calls: [{ index: 0, function: { arguments: '"fixture"}' } }] });
    const live = context.params.onAgentEvent.mock.calls.map(([event]) => structuredClone(event));
    const result = await run.finish('tool_calls');

    expect(preview.data.text).toBe('Checking a file.');
    const commentaryIndex = live.findIndex(event => event.stream === 'item');
    expect(commentaryIndex).toBeGreaterThan(-1);
    expect(live.slice(0, commentaryIndex).filter(event => event.stream === 'assistant').at(-1))
      .toMatchObject({ data: { text: 'Checking a file.', itemId: preview.data.itemId } });
    expect(live.some(event => event.stream === 'assistant' && event.data.text === '')).toBe(false);
    const transcript = createChatTranscriptState('fixture-session-key', null);
    let nextId = 0;
    for (const [index, event] of live.entries()) {
      reduceAgentEvent(transcript, {
        ...event, runId: 'reasoning-stream-fixture', sessionKey: 'fixture-session-key',
        sessionId: null, lifecycleGeneration: null, agentId: null, spawnedBy: null,
        agentSeq: index + 1, frameSeq: null, deliveryEvent: 'agent', timestamp: index + 1,
      }, { now: () => index + 1, createId: prefix => `${prefix}-${++nextId}` });
      const visible = projectTurnItems(transcript.activeTurn).filter(item => item.kind === 'content');
      expect(visible.length).toBeLessThanOrEqual(1);
    }
    expect(projectTurnItems(transcript.activeTurn).filter(item => item.kind === 'content'))
      .toMatchObject([{ item: { text: 'Checking a file.' } }]);
    const events = context.params.onAgentEvent.mock.calls.map(([event]) => event);
    expect(events.filter(event => event.stream === 'assistant' && event.data.replace === true &&
      event.data.text === '')).toHaveLength(1);
    expect(result.stopReason).toBe('toolUse');
    expect(result.content.find(block => block.type === 'toolCall')?.arguments).toEqual({ path: 'fixture' });
    expect(context.params.onPartialReply).not.toHaveBeenCalled();
    expect(context.params.onBlockReply).not.toHaveBeenCalled();
  });

  it.each([false, true])('retracts only provisional commentary when stop rolls back tool input (deferred: %s)', async deferred => {
    const context = subscriberContext(deferred ? { onBeforeTerminalDelivery: vi.fn() } : {});
    const run = await fixture(patched, {}, undefined, false, context);
    await run.send({ reasoning_content: 'Private thought.' });
    await run.send({ content: 'Restored final.' });
    await run.send({ tool_calls: [{ index: 0, id: 'rolled-back-tool', type: 'function', function: {
      name: 'read_file', arguments: '{"path":',
    } }] });
    const result = await run.finish('stop');
    expect(result.stopReason).toBe('stop');
    expect(result.content).toContainEqual({ type: 'text', text: 'Restored final.' });
    expect(result.content.some(block => block.type === 'toolCall')).toBe(false);
    const beforeRelease = context.params.onAgentEvent.mock.calls.map(([event]) => structuredClone(event));
    if (deferred) {
      expect(beforeRelease.some(event => event.stream === 'assistant')).toBe(false);
      (context.releaseDeferredReplies as () => void)();
    }
    const events = context.params.onAgentEvent.mock.calls.map(([event]) => event);
    const commentaryId = beforeRelease.find(event => event.stream === 'item')?.data.itemId;
    expect(commentaryId).toBeTruthy();
    expect(events.some(event => event.stream === 'item' && event.data.replace === true)).toBe(false);
    expect(events.at(-1)).toMatchObject({ stream: 'assistant', data: {
      assistantTextScope: { commentaryItemIds: [] },
    } });
    expect(visibleContent(events)).toEqual(['Restored final.']);
    const count = events.length;
    (context.releaseDeferredReplies as () => void)();
    expect(context.params.onAgentEvent.mock.calls).toHaveLength(count);
  });

  it('does not recover unclosed hidden content coalesced with reasoning and stop', async () => {
    const context = subscriberContext();
    const run = await fixture(patched, {}, undefined, false, context);
    await run.send({ reasoning_content: 'Dedicated thought.', content: '<think>SECRET' }, 'stop');
    const result = await run.eof();
    expect(result.stopReason).toBe('stop');
    expect(text(result)).toBe('');
    expect(deltas(run.events).join('')).not.toContain('SECRET');
    expect(context.params.onAgentEvent.mock.calls.filter(([event]) => event.stream === 'assistant' && event.data.text)).toEqual([]);
    expect(context.params.onPartialReply).not.toHaveBeenCalled();
    expect(context.params.onBlockReply).not.toHaveBeenCalled();
  });

  it('does not recover unclosed hidden content before a same-packet native tool', async () => {
    const context = subscriberContext();
    const run = await fixture(patched, {}, undefined, false, context);
    await run.send({ reasoning_content: 'Dedicated thought.', content: '<think>SECRET',
      tool_calls: [{ index: 0, id: 'same_packet_tool', type: 'function', function: {
        name: 'read_file', arguments: '{"path":"fixture"}',
      } }] });
    expect(deltas(run.events).join('')).not.toContain('SECRET');
    const result = await run.finish('tool_calls');
    expect(result.stopReason).toBe('toolUse');
    expect(text(result)).toBe('');
    expect(result.content.find(block => block.type === 'toolCall')?.arguments)
      .toEqual({ path: 'fixture' });
    expect(context.params.onAgentEvent.mock.calls.filter(([event]) => event.stream === 'assistant' && event.data.text)).toEqual([]);
    expect(context.params.onPartialReply).not.toHaveBeenCalled();
    expect(context.params.onBlockReply).not.toHaveBeenCalled();
  });

  it.each(['error', 'abort', 'EOF'])
  ('retracts exactly the streamed assistant preview after native %s', async failure => {
    const context = subscriberContext();
    const cancellation = new AbortController();
    const run = await fixture(patched, {}, cancellation.signal, false, context);
    await run.send({ reasoning_content: 'Dedicated thought.' });
    await run.send({ content: 'Unresolved answer.' });
    const before = context.params.onAgentEvent.mock.calls.map(([event]) => event)
      .filter(event => event.stream === 'assistant');
    expect(before.at(-1)?.data.text).toBe('Unresolved answer.');
    expect(before.at(-1)?.data.itemId).toBeTruthy();
    const result = failure === 'error'
      ? await run.fail(new Error('Synthetic transport failure'))
      : failure === 'EOF'
        ? await run.eof()
        : await (() => { cancellation.abort(new Error('Synthetic cancellation')); return run.done; })();
    expect(result.stopReason).toBe(failure === 'abort' ? 'aborted' : 'error');
    const events = context.params.onAgentEvent.mock.calls.map(([event]) => event);
    const replacements = events.filter(event => event.stream === 'assistant' &&
      event.data.text === '' && event.data.replace === true);
    expect(replacements).toHaveLength(1);
    expect(replacements[0].data.itemId).toBe(before.at(-1)?.data.itemId);
    expect(events.filter(event => event.stream === 'assistant').at(-1)).toBe(replacements[0]);
    expect(context.params.onPartialReply).not.toHaveBeenCalled();
    expect(context.params.onBlockReply).not.toHaveBeenCalled();
    expect(events.some(event => event.stream === 'item')).toBe(true);
  });

});

describe('real native subscriber and Renderer ownership', () => {
  function message(value: string, scope = 'native-message-1', allowed = true) {
    return { role: 'assistant', api: 'openai-completions', provider: model.provider, model: model.id,
      stopReason: 'stop', timestamp: 0,
      usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0,
        cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } },
      content: [{ type: 'text', text: value }] as Message['content'],
      openclawDelivery: { textPhaseRequiresTerminal: true, structuredTextStreaming: allowed, messageScopeId: scope } };
  }
  function update(context: SubscriberContext, value: string, delta: string, scope = 'native-message-1', type = 'text_delta') {
    const partial = message(value, scope);
    subscriber.handleMessageUpdate(context, { type: 'message_update', message: partial,
      assistantMessageEvent: { type, contentIndex: 0, delta, partial } });
  }
  function commentary(context: SubscriberContext, value: string, scope = 'native-message-1', owner = 'native-commentary') {
    const partial = message(value, scope);
    partial.content[0].textSignature = JSON.stringify({ v: 1, id: owner, phase: 'commentary' });
    subscriber.handleMessageUpdate(context, { type: 'message_update', message: partial,
      assistantMessageEvent: { type: 'toolcall_delta' } });
    return partial;
  }
  const events = (context: SubscriberContext) => context.params.onAgentEvent.mock.calls.map(([event]) => event);

  it('publishes normalized previews with stable native scope before terminal without durable delivery', () => {
    const context = subscriberContext();
    update(context, 'Alpha ', 'Alpha ');
    update(context, 'Alpha Beta', 'Beta');
    expect(events(context).map(event => event.data.text)).toEqual(['Alpha', 'Alpha Beta']);
    for (const event of events(context)) expect(event).toMatchObject({ data: {
      assistantTextScope: { id: 'native-message-1' },
    } });
    expect(context.params.onPartialReply).not.toHaveBeenCalled();
    expect(context.params.onBlockReply).not.toHaveBeenCalled();
    expect(context.blockChunker.hasBuffered()).toBe(false);
  });

  it('still withholds unadmitted reasoning-associated text', () => {
    const context = subscriberContext();
    const partial = message('Buffered answer.', 'strict-message', false);
    subscriber.handleMessageUpdate(context, { type: 'message_update', message: partial,
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Buffered answer.', partial } });
    expect(context.params.onAgentEvent).not.toHaveBeenCalled();
  });

  it('does not mistake text_end for complete message evidence and publishes an unchanged message_end', async () => {
    const context = subscriberContext();
    update(context, 'Unchanged.', 'Unchanged.');
    update(context, 'Unchanged.', '', 'native-message-1', 'text_end');
    expect(events(context).at(-1)).toMatchObject({ data: { assistantTextScope: { id: 'native-message-1' } } });
    expect(events(context).at(-1)?.data.assistantTextScope).not.toHaveProperty('commentaryItemIds');
    const count = events(context).length;
    await subscriber.handleMessageEnd(context, { type: 'message_end', message: message('Unchanged.') });
    expect(events(context).length).toBe(count + 1);
    expect(events(context).at(-1)).toMatchObject({ data: {
      text: 'Unchanged.', replace: true, assistantTextScope: { id: 'native-message-1', commentaryItemIds: [] },
    } });
    expect(visibleContent(events(context))).toEqual(['Unchanged.']);
  });

  it('publishes a full message-end snapshot through native wire even when only a suffix changed', async () => {
    const context = subscriberContext();
    update(context, 'Checking.', 'Checking.');
    commentary(context, 'Checking.');
    await subscriber.handleMessageEnd(context, { type: 'message_end', message: message('Checking. More.') });
    const final = events(context).filter(event => event.stream === 'assistant').at(-1)!;
    expect(final.data).toMatchObject({ text: 'Checking. More.', replace: true,
      assistantTextScope: { id: 'native-message-1', commentaryItemIds: [] } });
    expect(wireProjection(final, 'session', 'main', true).snapshot).toBe(true);
    expect(visibleContent(events(context))).toEqual(['Checking. More.']);
  });

  it('moves display ownership in the Renderer and preserves terminal Chat-buffer reconciliation', async () => {
    const context = subscriberContext();
    update(context, 'Checking.', 'Checking.');
    const partial = commentary(context, 'Checking.');
    expect(events(context).filter(event => event.stream === 'assistant')).toHaveLength(1);
    expect(visibleContent(events(context))).toEqual(['Checking.']);
    await subscriber.handleMessageEnd(context, { type: 'message_end', message: partial });
    expect(events(context).filter(event => event.stream === 'assistant').at(-1))
      .toMatchObject({ data: { text: '', replace: true, assistantTextScope: {
        id: 'native-message-1', commentaryItemIds: ['native-commentary'],
      } } });
    expect(visibleContent(events(context))).toEqual(['Checking.']);
  });

  it('keeps complete commentary and the final answer in the same native message', async () => {
    const context = subscriberContext();
    update(context, 'Checking.', 'Checking.');
    const partial = commentary(context, 'Checking.');
    const final = message('Done.');
    final.content = [...partial.content, { type: 'text', text: 'Done.',
      textSignature: JSON.stringify({ v: 1, id: 'final-answer', phase: 'final_answer' }) }];
    await subscriber.handleMessageEnd(context, { type: 'message_end', message: final });
    expect(visibleContent(events(context))).toEqual(['Checking.', 'Done.']);
  });

  it('keeps identical text in two independent native messages', async () => {
    const context = subscriberContext();
    const partial = commentary(context, 'Same on purpose.');
    await subscriber.handleMessageEnd(context, { type: 'message_end', message: partial });
    subscriber.handleMessageStart(context, { type: 'message_start', message: message('', 'native-message-2') });
    await subscriber.handleMessageEnd(context, { type: 'message_end', message: message('Same on purpose.', 'native-message-2') });
    expect(visibleContent(events(context))).toEqual(['Same on purpose.', 'Same on purpose.']);
  });

  it('captures source facts before terminal callbacks advance the native message', async () => {
    const context = subscriberContext();
    update(context, 'Checking.', 'Checking.');
    const partial = commentary(context, 'Checking.');
    context.params.onAgentEvent.mockImplementation(event => {
      if (event.stream === 'assistant' && event.data.text === '' && event.data.replace === true) {
        subscriber.handleMessageStart(context, { type: 'message_start', message: message('', 'native-message-2') });
        update(context, 'Ready.', 'Ready.', 'native-message-2');
      }
    });
    await subscriber.handleMessageEnd(context, { type: 'message_end', message: partial });
    await subscriber.handleMessageEnd(context, { type: 'message_end', message: message('Ready.', 'native-message-2') });
    expect(visibleContent(events(context))).toEqual(['Checking.', 'Ready.']);
    expect(events(context).filter(event => event.stream === 'item').at(-1))
      .toMatchObject({ data: { assistantTextScope: { id: 'native-message-1' } } });
    expect(context).not.toHaveProperty('withAssistantPublicationBatch');
  });

  it('stops publication after native unsubscribe without a new publication queue', async () => {
    const context = subscriberContext();
    update(context, 'Checking.', 'Checking.');
    const partial = commentary(context, 'Checking.');
    (context.state as { unsubscribed: boolean }).unsubscribed = true;
    const count = events(context).length;
    await subscriber.handleMessageEnd(context, { type: 'message_end', message: partial });
    expect(events(context)).toHaveLength(count);
  });

  it('retains native callback failure handling and publishes subsequent snapshots', () => {
    const context = subscriberContext();
    context.params.onAgentEvent.mockImplementationOnce(() => { throw new Error('Synthetic callback failure'); });
    expect(() => update(context, 'First.', 'First.')).not.toThrow();
    update(context, 'First. Second.', ' Second.');
    expect(visibleContent(events(context))).toEqual(['First. Second.']);
  });

  it('preserves explicit finalization admission deferral', () => {
    const context = subscriberContext({ onBeforeTerminalDelivery: vi.fn() });
    update(context, 'Protected final answer.', 'Protected final answer.');
    expect(context.params.onAgentEvent).not.toHaveBeenCalled();
    expect(context.params.onPartialReply).not.toHaveBeenCalled();
    expect(context.params.onBlockReply).not.toHaveBeenCalled();
  });
});
