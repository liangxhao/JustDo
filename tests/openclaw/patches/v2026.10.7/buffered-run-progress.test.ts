import fs from 'node:fs';
import Module from 'node:module';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { buildSync } from 'esbuild';
import { beforeAll, describe, expect, test } from 'vitest';

import {
  advanceRunActivity,
  createRunActivity,
  type RunActivity,
} from '../../../../src/renderer/libs/openclaw-chat/model/turn/run-activity';
import { readRunProgress } from '../../../../src/renderer/libs/openclaw-chat/model/turn/run-progress';

const { observeRunStreamProgress, observeRunRequestActivity } = require('../../../../src/main/openclaw/runtime/native-support/run-progress.mjs');
const explicitRuntime = process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR;
const runtime = path.resolve(explicitRuntime ?? 'vendor/openclaw-runtime/current');
const packagePath = path.join(runtime, 'package.json');
const version = fs.existsSync(packagePath) ? JSON.parse(fs.readFileSync(packagePath, 'utf8')).version : undefined;
if (explicitRuntime !== undefined && version !== '2026.10.7') {
  throw new Error(`Explicit native progress runtime must contain openclaw@2026.10.7: ${runtime}`);
}
const available = version === '2026.10.7';

type RawEvent = {
  type: string;
  delta?: string;
  contentIndex?: number;
  partial?: unknown;
  toolCall?: unknown;
};
type Output = {
  content: Array<{ type: string; name?: string; arguments?: unknown }>;
  stopReason: string;
};
type ProbeApi = {
  processCompletionsStream(
    chunks: AsyncIterable<unknown>, output: object, model: object,
    stream: { push(event: RawEvent): void }, options: object,
  ): Promise<void>;
  onLlmRequestActivityForProbe(signal: AbortSignal, listener: (progress: boolean) => void): () => void;
};
type MemoryModule = {
  filename: string;
  paths: string[];
  exports: ProbeApi;
  _compile(source: string, filename: string): void;
};

class ChunkQueue implements AsyncIterableIterator<unknown> {
  private readonly values: unknown[] = [];
  private readonly waiting: Array<(value: IteratorResult<unknown>) => void> = [];
  private ended = false;

  push(value: unknown): void {
    const next = this.waiting.shift();
    if (next) next({ done: false, value });
    else this.values.push(value);
  }

  end(): void {
    this.ended = true;
    for (const next of this.waiting.splice(0)) next({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<unknown> { return this; }

  next(): Promise<IteratorResult<unknown>> {
    if (this.values.length) return Promise.resolve({ done: false, value: this.values.shift() });
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise(resolve => this.waiting.push(resolve));
  }
}

const completionChunk = (delta: object, finishReason: string | null = null) => ({
  id: 'synthetic-progress', object: 'chat.completion.chunk', created: 1, model: 'synthetic',
  choices: [{ index: 0, delta, finish_reason: finishReason }],
});
let native: ProbeApi;

describe.skipIf(!available)('real native SDK buffered request progress', () => {
  beforeAll(() => {
    const sdk = path.join(runtime, 'node_modules/@openclaw/ai/dist');
    const names = fs.readdirSync(sdk);
    const transport = names.find(name => /^openai-completions-transport-.*\.mjs$/.test(name));
    const activity = names.find(name => /^llm-request-activity-.*\.mjs$/.test(name));
    if (!transport || !activity) throw new Error(`Native progress dependency graph is incomplete: ${runtime}`);
    const target = path.join(sdk, transport);
    // Export the actual parser and its actual activity module from one in-memory
    // graph. Separate module copies would hide WeakMap-bound request activity.
    const source = fs.readFileSync(target, 'utf8') +
      `\nimport { n as onLlmRequestActivityForProbe } from './${activity}';\n` +
      'export { processCompletionsStream, onLlmRequestActivityForProbe };\n';
    const built = buildSync({
      stdin: { contents: source, sourcefile: target, resolveDir: sdk },
      bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
      define: { 'import.meta.url': JSON.stringify(pathToFileURL(target).href) },
      logLevel: 'silent',
    });
    const Constructor = Module as unknown as {
      new(filename: string): MemoryModule;
      _nodeModulePaths(directory: string): string[];
    };
    const filename = path.join(sdk, 'buffered-progress-memory.cjs');
    const loaded = new Constructor(filename);
    loaded.filename = filename;
    loaded.paths = Constructor._nodeModulePaths(sdk);
    loaded._compile(built.outputFiles[0].text, filename);
    native = loaded.exports;
  });

  test.each(['modern', 'legacy'] as const)('%s tool_call arguments retain real progress without exposing their contents', async kind => {
    const model = {
      id: 'synthetic', name: 'Synthetic', api: 'openai-completions', provider: 'mimo',
      baseUrl: 'http://127.0.0.1:1/v1', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 10_000,
    };
    const output: Output & Record<string, unknown> = {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop', timestamp: 1,
    };
    const expectedArguments = {
      id: 'show_widget', args: { title: 'Synthetic', html: '<main>' + 'synthetic '.repeat(7_000) + '</main>' },
    };
    const argumentsJson = JSON.stringify(expectedArguments);
    expect(argumentsJson.length).toBe(70_072);
    const queue = new ChunkQueue();
    const abort = new AbortController();
    const requestState = { lastAt: -Infinity };
    const streamState = {};
    const publicActivity: Array<Record<string, unknown>> = [];
    const streamObservations: Array<Record<string, unknown>> = [];
    const rawEvents: RawEvent[] = [];
    const transportActivity: boolean[] = [];
    let at = 1_000;
    let view: RunActivity = createRunActivity('native-probe', at);
    const project = (data: Record<string, unknown>) => {
      const progress = readRunProgress('item', data);
      expect(progress).not.toBeNull();
      view = advanceRunActivity(view, progress!.stage, { ...progress!, at: progress!.at ?? at }, false);
    };
    const stop = native.onLlmRequestActivityForProbe(abort.signal, progress => {
      transportActivity.push(progress);
      if (progress === true && !abort.signal.aborted) observeRunRequestActivity(requestState, (data: Record<string, unknown>) => {
        publicActivity.push(data);
        project(data);
      }, at);
    });
    const processing = native.processCompletionsStream(queue, output, model, {
      push(event) {
        rawEvents.push(event);
        observeRunStreamProgress(streamState, event, (progress: Record<string, unknown>) => {
          streamObservations.push(progress);
          project({ itemId: 'run-stream-progress', kind: 'status', phase: 'update', status: 'running', progress });
        }, at);
      },
    }, { signal: abort.signal, emitReasoning: false });
    const send = async (delta: object, finishReason: string | null = null) => {
      at += 1_100;
      queue.push(completionChunk(delta, finishReason));
      await nextTurn();
    };
    try {
      await send({ role: 'assistant' });
      await send({ content: '' });
      expect(transportActivity).toEqual([false, false]);
      expect(publicActivity).toHaveLength(0);
      expect(view.lastModelActivityAt).toBeNull();
      expect(view.lastAgentEventAt).toBe(1_000);
      let fragments = 0;
      for (let offset = 0; offset < argumentsJson.length; offset += 4_096) {
        const first = offset === 0;
        const fragment = { ...(first ? { name: 'tool_call' } : {}), arguments: argumentsJson.slice(offset, offset + 4_096) };
        if (kind === 'modern') await send({ tool_calls: [{ index: 0,
          ...(first ? { id: 'synthetic-tool-call', type: 'function' } : {}), function: fragment }] });
        else await send({ function_call: fragment });
        fragments++;
        expect(view.lastModelActivityAt).toBe(at);
        expect(view.lastAgentEventAt).toBe(at);
      }
      await send({ reasoning_content: 'Synthetic hidden reasoning' });
      expect(transportActivity.filter(Boolean)).toHaveLength(fragments + 1);
      expect(publicActivity.length).toBeGreaterThan(1);
      expect(view.lastModelActivityAt).toBe(at);
      expect(rawEvents.filter(event => event.type.startsWith('text_'))).toHaveLength(0);
      if (kind === 'legacy') {
        expect(rawEvents.filter(event => event.type.startsWith('toolcall_'))).toHaveLength(0);
        expect(streamObservations).toHaveLength(0);
        expect(view.stage).toBe('receiving-model');
        expect(view.progress).toEqual({ kind: 'model-activity' });
      } else {
        expect(rawEvents.filter(event => event.type === 'toolcall_delta').length).toBeGreaterThan(1);
        expect(streamObservations.length).toBeGreaterThan(1);
        expect(view.stage).toBe('generating-tool-input');
        expect(view.progress).toMatchObject({ kind: 'tool-input', receivedChars: argumentsJson.length });
      }
      expect(JSON.stringify(publicActivity)).not.toMatch(/receivedChars|toolCallId|arguments|html|Synthetic|thinking|text/);
      expect(publicActivity.every(event => JSON.stringify(event.progress) === '{"kind":"model-activity"}')).toBe(true);
      await send({}, kind === 'modern' ? 'tool_calls' : 'function_call');
      queue.end();
      await processing;
      expect(output.stopReason).toBe('toolUse');
      const toolCalls = output.content.filter(block => block.type === 'toolCall');
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]).toMatchObject({ name: 'tool_call', arguments: expectedArguments });
      expect(streamObservations.at(-1)).toMatchObject({ kind: 'tool-input', receivedChars: argumentsJson.length, complete: true });
    } finally {
      queue.end();
      try {
        await processing;
      } finally {
        stop();
      }
    }
  });
});
