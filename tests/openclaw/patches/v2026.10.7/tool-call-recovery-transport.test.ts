import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { observeToolCallRecoveryResponse } from '../../../../plugins/extensions/runtime-services/tool-call-recovery/facts.mjs';
import { resolveToolCallRecovery } from '../../../../plugins/extensions/runtime-services/tool-call-recovery/policy.mjs';

type Content = { type: string; text?: string; textSignature?: string; name?: string };
type Assistant = {
  stopReason: string;
  content: Content[];
  errorCode?: string;
  diagnostics?: Array<{ type: string; details?: Record<string, unknown> }>;
};
type Event = { type: string };
type NativeStream = AsyncIterable<Event> & { result(): Promise<Assistant> };
type AiHost = Record<string, unknown>;
type AiModule = { getAiTransportHost(): AiHost; configureAiTransportHost(host: AiHost): void };
type Transports = { createOpenAICompletionsTransportStreamFn(): (model: object, context: object, options: object) => NativeStream };

const runtimeRoot = process.env.OPENCLAW_RUNTIME_DIR ?? path.resolve(__dirname, '../../../../build/runtimes/openclaw/win-x64');
const sdkRoot = path.join(runtimeRoot, 'node_modules', '@openclaw', 'ai');
const packagePath = path.join(sdkRoot, 'package.json');
const hasRuntime = fs.existsSync(packagePath);
const endpoint = 'https://transport.fixture.invalid/v1/chat/completions';
const receiptType = 'tool_call_pre_dispatch_rejection';
let ai: AiModule;
let transports: Transports;
let originalHost: AiHost;

const tools = [
  { name: 'tool_call', description: 'Synthetic dispatcher', parameters: { type: 'object', properties: { id: { type: 'string' }, args: { type: 'object' } }, required: ['id', 'args'] } },
  { name: 'tool_describe', description: 'Synthetic description', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'exec', description: 'Synthetic command', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
];
const model = {
  id: 'fixture-model', name: 'Fixture model', api: 'openai-completions', provider: 'fixture',
  baseUrl: 'https://transport.fixture.invalid/v1', reasoning: true, input: ['text'],
  contextWindow: 4096, maxTokens: 256, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = { messages: [{ role: 'user', content: 'Synthetic transport fixture', timestamp: 1 }], tools };

function event(delta: object, finishReason: string | null = null) {
  return `data: ${JSON.stringify({ id: 'fixture-response', object: 'chat.completion.chunk', created: 1, model: model.id, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;
}

function tool(index: number, name: string, args: string) {
  return event({ tool_calls: [{ index, id: `fixture-call-${index}`, type: 'function', function: { name, arguments: args } }] });
}

function receipt(message: Assistant) {
  return message.diagnostics?.filter(entry => entry.type === receiptType) ?? [];
}

function expectNativeRecoveryAdmission(message: Assistant, commentary: boolean) {
  const facts = observeToolCallRecoveryResponse(message);
  expect(facts).toMatchObject({
    rejected: true, streamComplete: true, dispatchCount: 0,
    hasVisibleText: commentary, commentaryOnly: commentary,
  });
  expect(resolveToolCallRecovery({
    ...facts, allToolsSettled: true, excluded: false, initialCandidate: true, aborted: false, attempts: 0,
  })).toMatchObject({ action: 'retry', reason: 'retry' });
}

async function consume(sse: string) {
  const fetch = vi.fn(async (url: string | URL | Request) => {
    // Every SDK request terminates here. This fixture never opens a network socket.
    expect(String(url)).toBe(endpoint);
    const bytes = new TextEncoder().encode(sse);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 17) controller.enqueue(bytes.slice(offset, offset + 17));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  ai.configureAiTransportHost({ ...originalHost, buildModelFetch: () => fetch });
  try {
    const stream = transports.createOpenAICompletionsTransportStreamFn()(model, context, {
      apiKey: 'synthetic-fixture-key', reasoningEffort: 'low', timeoutMs: 1000,
    });
    const events: Event[] = [];
    for await (const entry of stream) events.push(entry);
    const message = await stream.result();
    expect(fetch).toHaveBeenCalledOnce();
    return { events, message };
  } finally {
    ai.configureAiTransportHost(originalHost);
  }
}

describe.skipIf(!hasRuntime)('actual installed AI SDK SSE transport (requires OPENCLAW_RUNTIME_DIR or prepared vendor/current)', () => {
  beforeAll(async () => {
    const metadata = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    expect(metadata.name).toBe('@openclaw/ai');
    expect(metadata.version).toBe('2026.10.7');
    ai = await import(pathToFileURL(path.join(sdkRoot, metadata.exports['.'].import)).href) as AiModule;
    transports = await import(pathToFileURL(path.join(sdkRoot, metadata.exports['./transports'].import)).href) as Transports;
    originalHost = ai.getAiTransportHost();
  });
  afterAll(() => { if (originalHost) ai.configureAiTransportHost(originalHost); });

  it('rejects fragmented XML arguments after a complete tool_calls response without publishing an executable call', async () => {
    const chunks = ['<', 'id', '>', 'ask-user', '-question', '<', '/id', '>'];
    const sse = event({ role: 'assistant' }) + chunks.map((argumentsText, index) => event({
      tool_calls: [{ index: 0, ...(index === 0 ? { id: 'fixture-call-0', type: 'function' } : {}), function: { ...(index === 0 ? { name: 'tool_describe' } : {}), arguments: argumentsText } }],
    })).join('') + event({}, 'tool_calls') + 'data: [DONE]\n\n';
    const { message, events } = await consume(sse);
    expect(message.stopReason).toBe('error');
    expect(message.errorCode).toBe('malformed_tool_call_arguments');
    expect(receipt(message)).toEqual([{ type: receiptType, timestamp: expect.any(Number), details: {
      batchRejected: true, streamComplete: true, dispatchCount: 0,
      feedback: { version: 1, batchCallCount: 1, omitted: false, localization: 'located',
        issues: [{ callIndex: 0, kind: 'invalid_json', detail: 'xml_like_input', argumentChars: 26 }] },
    } }]);
    expect(message.content.some(block => block.type === 'toolCall')).toBe(false);
    expect(events.filter(entry => entry.type === 'toolcall_end')).toEqual([]);
    expectNativeRecoveryAdmission(message, false);
  });

  it('preserves native commentary while atomically rejecting two valid siblings and an unclosed exec command', async () => {
    const commentary = '正在检查工具响应，随后继续处理剩余步骤。';
    const sse = event({ role: 'assistant', reasoning_content: 'Synthetic reasoning marker.' }) + event({ content: commentary }) +
      tool(0, 'tool_call', '{"id":"task_assistants","args":{}}') +
      tool(1, 'tool_describe', '{"id":"read"}') +
      tool(2, 'exec', '{"command":"synthetic command') + event({}, 'tool_calls') + 'data: [DONE]\n\n';
    const { message, events } = await consume(sse);
    expect(message.stopReason).toBe('error');
    expect(message.errorCode).toBe('malformed_tool_call_arguments');
    expect(receipt(message)[0]?.details).toMatchObject({ batchRejected: true, streamComplete: true, dispatchCount: 0,
      feedback: { batchCallCount: 3, issues: [{ callIndex: 2, kind: 'invalid_json', detail: 'unterminated_string' }] } });
    expect(message.content.some(block => block.type === 'toolCall')).toBe(false);
    expect(events.filter(entry => entry.type === 'toolcall_end')).toEqual([]);
    const texts = message.content.filter(block => block.type === 'text');
    expect(texts.map(block => block.text).join('')).toBe(commentary);
    expect(texts.every(block => JSON.parse(block.textSignature ?? '{}').phase === 'commentary')).toBe(true);
    expectNativeRecoveryAdmission(message, true);
  });

  it('preserves the native stop-plus-text conflict without granting a recovery receipt', async () => {
    const sse = event({ role: 'assistant', content: 'A visible explanation.' }) +
      tool(0, 'tool_describe', '<id>read</id>') + event({}, 'stop') + 'data: [DONE]\n\n';
    const { message, events } = await consume(sse);
    expect(message.stopReason).toBe('stop');
    expect(receipt(message)).toEqual([]);
    expect(message.content.filter(block => block.type === 'text').map(block => block.text).join('')).toBe('A visible explanation.');
    expect(message.content.some(block => block.type === 'toolCall')).toBe(false);
    expect(events.filter(entry => entry.type === 'toolcall_end')).toEqual([]);
  });

  it('does not grant a completed-response receipt when the SSE ends without finish_reason or DONE', async () => {
    const { message, events } = await consume(event({ role: 'assistant' }) + tool(0, 'exec', '{"command":"unfinished'));
    expect(message.stopReason).toBe('error');
    expect(receipt(message)).toEqual([]);
    expect(message.content.some(block => block.type === 'toolCall')).toBe(false);
    expect(events.filter(entry => entry.type === 'toolcall_end')).toEqual([]);
  });

  it('publishes an ordinary valid call through the same installed transport', async () => {
    const { message, events } = await consume(event({ role: 'assistant' }) + tool(0, 'tool_describe', '{"id":"read"}') + event({}, 'tool_calls') + 'data: [DONE]\n\n');
    expect(message.stopReason).toBe('toolUse');
    expect(events.filter(entry => entry.type === 'toolcall_end')).toHaveLength(1);
    expect(message.content.filter(block => block.type === 'toolCall')).toHaveLength(1);
    expect(receipt(message)).toEqual([]);
  });

  it('attributes only real native failures when integer normalization changes JSON acceptance', async () => {
    const { message, events } = await consume(event({ role: 'assistant' }) +
      tool(0, 'exec', '{9007199254740993:0}') +
      tool(1, 'exec', '{9007199254740993:0 "x":1}') +
      tool(2, 'exec', '<private>') + event({}, 'tool_calls') + 'data: [DONE]\n\n');
    expect(message.stopReason).toBe('error');
    expect(events.filter(entry => entry.type === 'toolcall_end')).toEqual([]);
    const feedback = receipt(message)[0]?.details?.feedback;
    expect(feedback).toEqual({ version: 1, batchCallCount: 3, omitted: false, localization: 'located', issues: [
      { callIndex: 1, kind: 'native_rejected', argumentChars: 26 },
      { callIndex: 2, kind: 'invalid_json', detail: 'xml_like_input', argumentChars: 9 },
    ] });
    expect(JSON.stringify(receipt(message))).not.toContain('private');
    expectNativeRecoveryAdmission(message, false);
  });
});
