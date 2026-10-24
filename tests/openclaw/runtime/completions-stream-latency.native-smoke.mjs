import assert from 'node:assert/strict';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolveNativeSmokeTarget } from './native-smoke-target.mjs';

// Isolated transport integration: all HTTP responses are generated in memory
// through the AI package's supported scoped host. No Gateway, user state,
// credentials, sockets or model services are used, including arbitrary endpoint cases.
const { values } = parseArgs({ options: {
  'runtime-dir': { type: 'string' },
  'expect-streaming': { type: 'boolean' },
  'expect-buffered': { type: 'boolean' },
} });
assert.ok(!(values['expect-streaming'] && values['expect-buffered']),
  'Choose only one expected runtime behavior');
const expectStreaming = values['expect-streaming'] === true;
assert.ok(values['runtime-dir'], 'Pass --runtime-dir with the final frozen runtime directory.');
const { runtimeRoot: runtimeDir } = resolveNativeSmokeTarget(values['runtime-dir']);
const aiDir = path.join(runtimeDir, 'node_modules/@openclaw/ai/dist');
const { createAiTransportHost, runWithAiTransportHost, supportsScopedAiTransportHosts } =
  await import(pathToFileURL(path.join(aiDir, 'index.mjs')).href);
const { createOpenAICompletionsTransportStreamFn } =
  await import(pathToFileURL(path.join(aiDir, 'transports.mjs')).href);
const { reasoningTagTextPolicy } =
  await import(pathToFileURL(path.join(aiDir, 'internal/openai.mjs')).href);
assert.equal(supportsScopedAiTransportHosts(), true,
  'The smoke requires scoped host policy support; do not fall back to real fetch');

async function probe({ label, withReasoning = true, strict = false,
  reasoningField = 'reasoning_content', ...overrides }) {
  const started = performance.now();
  const sent = [];
  const received = [];
  const sequence = [];
  const fixtureAbort = new AbortController();
  const encoder = new TextEncoder();
  const model = {
    id: 'arbitrary-reasoner', name: 'Synthetic fixture',
    api: 'openai-completions', provider: 'arbitrary-provider',
    baseUrl: 'https://fixture.invalid/v1', reasoning: withReasoning,
    input: ['text'], contextWindow: 8192, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...overrides,
  };
  let requestCount = 0;
  let pendingFixture;
  let fixtureError;
  const host = createAiTransportHost({
    buildModelFetch: requestedModel => {
      assert.equal(requestedModel.baseUrl, model.baseUrl);
      return async (input, init) => {
        try {
          requestCount += 1;
          const requestUrl = input instanceof Request ? input.url : String(input);
          assert.equal(requestUrl, `${model.baseUrl.replace(/\/$/, '')}/chat/completions`);
          assert.equal(init?.method?.toUpperCase(), 'POST');
          assert.equal((await new Response(init.body).json()).stream, true);
          const body = new ReadableStream({
            start(controller) {
              const send = (kind, delta, finishReason = null) => {
                sent.push({ kind, ms: Math.round(performance.now() - started) });
                sequence.push(`sent:${kind}`);
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                  id: 'synthetic-response', object: 'chat.completion.chunk',
                  created: 0, model: model.id,
                  choices: [{ index: 0, delta, finish_reason: finishReason }],
                })}\n\n`));
              };
              pendingFixture = (async () => {
                const pause = ms => delay(ms, undefined, { signal: fixtureAbort.signal });
                if (withReasoning) {
                  await pause(60);
                  send('reasoning', reasoningField === 'reasoning_details'
                    ? { reasoning_details: [{ type: 'reasoning.text', text: 'Synthetic reasoning.' }] }
                    : reasoningField === 'typed'
                      ? { content: [{ type: 'thinking', thinking: 'Synthetic reasoning.' }] }
                      : { [reasoningField]: 'Synthetic reasoning.' });
                }
                await pause(60);
                send('text-a', { content: 'Alpha ' });
                await pause(60);
                send('text-b', { content: 'Beta' });
                await pause(300);
                send('terminal', {}, 'stop');
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                controller.close();
              })().catch(error => {
                if (!fixtureAbort.signal.aborted) controller.error(error);
              });
            },
            cancel() { fixtureAbort.abort(); },
          });
          return new Response(body, { headers: {
            'content-type': 'text/event-stream', 'cache-control': 'no-cache',
          } });
        } catch (error) {
          fixtureError = error;
          throw error;
        }
      };
    },
  });
  let finalMessage;
  let terminalRequired = false;
  let structuredStreaming = false;
  let previewAuthorizedAtTextStart = false;
  try {
    await runWithAiTransportHost(host, async () => {
      const options = { apiKey: 'synthetic-fixture', timeoutMs: 5000 };
      if (strict) reasoningTagTextPolicy.markStrict(options);
      const stream = createOpenAICompletionsTransportStreamFn()(model, {
        messages: [{ role: 'user', content: 'Synthetic fixture', timestamp: Date.now() }],
      }, options);
      for await (const event of stream) {
        if (event.type === 'error') throw fixtureError ??
          new Error(event.error?.errorMessage ?? 'Transport failed');
        if (event.type === 'text_start') {
          previewAuthorizedAtTextStart =
            event.partial?.openclawDelivery?.structuredTextStreaming === true;
        }
        if (event.type === 'text_delta' || event.type === 'thinking_delta') {
          sequence.push(`received:${event.type}`);
          received.push({ kind: event.type, ms: Math.round(performance.now() - started),
            chars: event.delta.length });
        }
        if (event.type === 'done') finalMessage = event.message;
      }
    });
    await pendingFixture;
    assert.equal(requestCount, 1, 'Only the in-memory host response may be requested');
    assert.ok(finalMessage, 'The installed transport must settle');
    assert.equal(finalMessage.content.filter(block => block.type === 'text')
      .map(block => block.text).join(''), 'Alpha Beta');
    terminalRequired = finalMessage.openclawDelivery?.textPhaseRequiresTerminal === true;
    structuredStreaming = finalMessage.openclawDelivery?.structuredTextStreaming === true;
    const textEvents = received.filter(event => event.kind === 'text_delta');
    assert.ok(textEvents.length > 0, 'The installed transport must emit text');
    const firstTextIndex = sequence.indexOf('received:text_delta');
    const terminalIndex = sequence.indexOf('sent:terminal');
    assert.ok(terminalIndex >= 0);
    // Native typed content already streams at the transport layer; its subscriber
    // still requires this patch to admit reasoning-associated live previews.
    const shouldStream = !withReasoning || (!strict && (expectStreaming || reasoningField === 'typed'));
    if (shouldStream) {
      assert.ok(firstTextIndex < terminalIndex,
        `${label}: first text must arrive before the synthetic terminal`);
      assert.ok(textEvents.length >= 2, `${label}: text chunks must remain separate`);
    } else {
      assert.ok(firstTextIndex > terminalIndex,
        `${label}: explicit strict reasoning must retain terminal buffering`);
    }
    assert.equal(terminalRequired, withReasoning,
      'Streaming preview must not weaken native terminal phase ownership');
    assert.equal(structuredStreaming, withReasoning && expectStreaming && !strict);
    assert.equal(previewAuthorizedAtTextStart, structuredStreaming,
      'The subscriber must receive preview authorization before the first text delta');
    assert.equal(finalMessage.content.filter(block => block.type === 'thinking')
      .map(block => block.thinking).join(''), withReasoning ? 'Synthetic reasoning.' : '');
    console.log(JSON.stringify({ label, expectStreaming: shouldStream, sent, received,
      terminalRequired, structuredStreaming, networkRequests: 0 }));
  } finally {
    fixtureAbort.abort();
    await pendingFixture;
  }
}

await probe({ label: 'plain text', withReasoning: false });
for (const reasoningField of ['reasoning_content', 'reasoning', 'reasoning_text', 'reasoning_details', 'typed']) {
  await probe({ label: `arbitrary provider with ${reasoningField}`, reasoningField });
}
await probe({ label: 'arbitrary model, custom endpoint and transport alias',
  id: 'another-unknown-model', provider: 'another-provider',
  baseUrl: 'https://another.invalid:8443/custom/api',
  api: 'openclaw-openai-completions-transport' });
await probe({ label: 'explicit strict policy', strict: true });
