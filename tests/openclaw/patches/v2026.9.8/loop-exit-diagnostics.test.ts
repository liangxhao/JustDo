import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const patch = require('../../../../scripts/patches/v2026.9.8/033-loop-exit-diagnostics.cjs');
const { findMatchingDelimiter } = require('../../../../scripts/patches/v2026.9.8/_patch-utils.js');
const root = process.env.JUSTDO_DIAGNOSTIC_PRISTINE_DIR;
function body(source: string, name: string) {
  const start = source.indexOf(`function ${name}(`);
  const open = source.indexOf('{', start);
  return source.slice(start, findMatchingDelimiter(source, open, '{', '}', name) + 1);
}
const fixture = `const DEFERRED_TERMINAL_METADATA_KEYS = ["stopReason", "assistantTranscriptIdempotencyKey"];`;
describe('loop exit patch contract', () => {
  it('adds closed fields idempotently and rejects historical/partial markers', () => {
    const value = patch.__testing.transform(fixture);
    expect(patch.__testing.transform(value)).toBe(value);
    expect(() => patch.__testing.transform(value.replace('_V2026_9_8', '_V2026_9_6'))).toThrow();
    expect(() => patch.__testing.transform(value.replace('"justDoResponseShape",', ''))).toThrow();
    expect(() =>
      patch.__testing.transform(value.replace('// JUSTDO_LOOP_EXIT_DIAGNOSTICS_V2026_9_8', '')),
    ).toThrow();
  });
});

// Point at an extracted locked npm artifact; never mutate a running runtime.
describe.skipIf(!root)('locked 9.8 native loop diagnostics integration', () => {
  const read = (needle: string) => {
    const files = fs
      .readdirSync(path.join(root!, 'dist'))
      .filter((file: string) => file.endsWith('.mjs'));
    return fs.readFileSync(
      path.join(
        root!,
        'dist',
        files.find((file: string) =>
          fs.readFileSync(path.join(root!, 'dist', file), 'utf8').includes(needle),
        )!,
      ),
      'utf8',
    );
  };
  it('patches and verifies every native copy without altering the pristine artifact', () => {
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-loop-exit-'));
    try {
      fs.mkdirSync(path.join(isolated, 'dist'));
      for (const file of fs.readdirSync(path.join(root!, 'dist'))) {
        if (!file.endsWith('.mjs')) continue;
        const source = fs.readFileSync(path.join(root!, 'dist', file), 'utf8');
        if (
          ['function runLoop(', 'function handleAgentEnd(', 'DEFERRED_TERMINAL_METADATA_KEYS'].some(
            needle => source.includes(needle),
          )
        )
          fs.writeFileSync(path.join(isolated, 'dist', file), source);
      }
      expect(patch.applyPatch(isolated)).toHaveLength(4);
      expect(patch.verifyPatch(isolated)).toEqual([]);
      expect(patch.applyPatch(isolated)).toEqual([]);
    } finally {
      fs.rmSync(isolated, { recursive: true, force: true });
    }
  });
  it('carries only the final attempt through native deferred settlement', () => {
    const source = patch.__testing.transform(read('const DEFERRED_TERMINAL_METADATA_KEYS'));
    const keys = source.match(/const DEFERRED_TERMINAL_METADATA_KEYS\s*=\s*\[[^\]]*\];/)![0];
    const events: any[] = [];
    const create = vm.runInNewContext(
      `(() => { ${keys}\n${body(source, 'resolveAgentLifecycleTerminalMetadata')}\n${body(source, 'createAgentLifecycleTerminalBackstop')}\nreturn createAgentLifecycleTerminalBackstop; })()`,
      {
        readStringValue: (value: unknown) => (typeof value === 'string' ? value : undefined),
        AGENT_RUN_RESTART_ABORT_STOP_REASON: 'restart',
        emitAgentEvent: (event: unknown) => events.push(event),
      },
    );
    const backstop = create({
      runId: 'run',
      getLifecycleGeneration: () => 'g',
      resolveTerminationFields: () => ({}),
    });
    backstop.note({
      stream: 'lifecycle',
      data: { phase: 'finishing', justDoLoopExit: 'model_error', justDoResponseShape: 'empty' },
    });
    backstop.beginAttempt();
    backstop.note({
      stream: 'lifecycle',
      data: { phase: 'finishing', justDoLoopExit: 'no_pending_work', justDoResponseShape: 'text' },
    });
    expect(events).toHaveLength(0);
    backstop.emit('end', { meta: {} });
    expect(events[0].data).toMatchObject({
      executionSettled: true,
      justDoLoopExit: 'no_pending_work',
      justDoResponseShape: 'text',
    });
  });
  it.each(patch.__testing.REASONS as string[])(
    'records the actual %s branch without changing returned messages',
    async reason => {
      const native = read('async function runLoop(');
      const source = patch.__testing.transform(native);
      const run = (text: string) => {
        const events: Record<string, unknown>[] = [];
        const message = {
          role: 'assistant',
          content: [{ type: 'text', text: 'PRIVATE' }],
          stopReason:
            reason === 'model_error' ? 'error' : reason === 'model_aborted' ? 'aborted' : 'stop',
        };
        const batch = { messages: [], steeringMessages: [], terminate: true, terminateRun: true };
        const context = {
          isActiveTurnTainted: () => false,
          getSteeringAtCheckpoint: () => [],
          withAssistantTurnTaint: (m: unknown) => m,
          toolResultTaintsTurn: () => false,
          createFailureMessage: () => ({ role: 'assistant', content: [], stopReason: 'aborted' }),
          appendInterruptedTurnMessage: async () => {},
          isTurnHandoffAbort: () => false,
          TOOL_LOOP_RECOVERY_TERMINATED_MESSAGE: 'guard',
          streamAgentResponse: async () => ({
            message,
            executedIds: new Set(),
            batches: reason === 'tool_loop_guard' ? [batch] : [],
            continuationRequired: false,
          }),
        };
        const fn = vm.runInNewContext(`(async ${body(text, 'runLoop')})`, context);
        return fn(
          { context: { messages: [] } },
          [],
          {
            model: {},
            shouldStopAfterTurn: () => reason === 'policy_stop',
            prepareNextTurn: () => (reason === 'handoff' ? { stop: true } : undefined),
          },
          { aborted: reason === 'abort_signal' },
          (event: Record<string, unknown>) => {
            events.push(event);
          },
        ).then((messages: unknown[]) => ({ messages, events }));
      };
      const before = await run(native);
      const after = await run(source);
      expect(after.messages).toEqual(before.messages);
      expect(after.events.at(-1)?.justDoLoopExit).toBe(reason);
      expect(after.events.map(({ justDoLoopExit: _exit, ...event }) => event)).toEqual(
        before.events,
      );
    },
  );
  it('projects output kinds without retaining content and rejects corrupted bundled projection', () => {
    const patched = patch.__testing.transform(read('function handleAgentEnd('));
    const handler = body(patched, 'handleAgentEnd');
    const start = handler.indexOf('const justDoLoopExit');
    const end = handler.indexOf('finalizeToolActivity', start);
    const project = (content: unknown[]) =>
      vm.runInNewContext(
        `(() => { ${handler.slice(start, end)} return { justDoLoopExit, justDoResponseShape }; })()`,
        { evt: { justDoLoopExit: 'no_pending_work' }, lastAssistant: { content } },
      );
    expect(project([{ type: 'thinking', thinking: 'PRIVATE' }])).toEqual({
      justDoLoopExit: 'no_pending_work',
      justDoResponseShape: 'thinking_only',
    });
    expect(project([{ type: 'toolCall', arguments: 'PRIVATE' }]).justDoResponseShape).toBe(
      'tool_call',
    );
    expect(project([]).justDoResponseShape).toBe('empty');
    expect(() =>
      patch.__testing.transform(
        patched.replace('? "thinking_only"', '? "text"'),
        'gateway-bundle.mjs',
      ),
    ).toThrow();
  });
});
