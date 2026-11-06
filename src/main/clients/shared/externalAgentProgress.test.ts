import { afterEach, expect, test, vi } from 'vitest';

import type { NormalizedAgentEvent } from '../../../shared/openclaw/agentEvent';
import type { GatewayClientLike } from '../../engine/gateway/types';
import { ExternalAgentProgress } from './externalAgentProgress';
import { ExternalAgentStreamError } from './externalAgentTypes';

const gates: ExternalAgentProgress[] = [];
afterEach(() => {
  gates.splice(0).forEach(gate => gate.close());
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

const event = (
  seq: number,
  sessionId: string | null = null,
  stream = 'assistant',
): NormalizedAgentEvent => ({
  runId: 'run',
  sessionKey: 'native-key',
  sessionId,
  lifecycleGeneration: null,
  agentId: 'main',
  spawnedBy: null,
  agentSeq: seq,
  frameSeq: seq,
  deliveryEvent: 'agent',
  stream,
  timestamp: seq,
  data: { text: `event ${seq}` },
});

function fixture(timeoutMs?: number) {
  const client = {} as GatewayClientLike;
  const verify = vi.fn(async (_source: GatewayClientLike, _events: NormalizedAgentEvent[]) => 'verified-sid');
  const isCurrent = vi.fn((source: GatewayClientLike) => source === client);
  const deliver = vi.fn((_event: NormalizedAgentEvent) => {});
  const fail = vi.fn((_error: ExternalAgentStreamError) => {});
  const gate = new ExternalAgentProgress({ isCurrent, verify, deliver, fail, timeoutMs });
  gates.push(gate);
  return { gate, client, verify, isCurrent, deliver, fail };
}

async function microtasks() {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

test('delivers stamped events in FIFO order through a microtask without an identity read', async () => {
  const f = fixture();
  f.gate.enqueue(event(1, 'native-sid'), f.client);
  f.gate.enqueue(event(2, 'native-sid', 'tool'), f.client);
  expect(f.deliver).not.toHaveBeenCalled();

  await f.gate.flush();

  expect(f.verify).not.toHaveBeenCalled();
  expect(f.deliver.mock.calls.map(([value]) => value.agentSeq)).toEqual([1, 2]);
  expect(f.fail).not.toHaveBeenCalled();
});

test('verifies one burst once and preserves FIFO across stamped, root, outer and inner events', async () => {
  const f = fixture();
  const proof = deferred<string>();
  f.verify.mockReturnValue(proof.promise);
  const events = [
    event(1, 'explicit-sid'),
    event(2),
    { ...event(3, null, 'tool'), data: { phase: 'start', toolCallId: 'outer', name: 'tool_call' } },
    { ...event(4, null, 'tool'), data: {
      phase: 'start', toolCallId: 'inner', parentToolCallId: 'outer', name: 'external_mcp',
    } },
    event(5, 'explicit-sid', 'lifecycle'),
  ];
  events.forEach(value => f.gate.enqueue(value, f.client));
  const flushed = f.gate.flush();
  await microtasks();

  expect(f.verify).toHaveBeenCalledExactlyOnceWith(f.client, events.slice(1, 4));
  expect(f.deliver).not.toHaveBeenCalled();
  proof.resolve('verified-sid');
  await flushed;

  expect(f.deliver.mock.calls.map(([value]) => [value.agentSeq, value.sessionId])).toEqual([
    [1, 'explicit-sid'], [2, 'verified-sid'], [3, 'verified-sid'],
    [4, 'verified-sid'], [5, 'explicit-sid'],
  ]);
  expect(events[1].sessionId).toBeNull();
});

test('events arriving during a proof form the next batch and cannot overtake it', async () => {
  const f = fixture();
  const first = deferred<string>();
  f.verify.mockReturnValueOnce(first.promise);
  f.gate.enqueue(event(1), f.client);
  await microtasks();
  f.gate.enqueue(event(2, 'native-sid'), f.client);
  f.gate.enqueue(event(3, null, 'thinking'), f.client);
  const flushed = f.gate.flush();
  expect(f.verify).toHaveBeenCalledTimes(1);
  expect(f.deliver).not.toHaveBeenCalled();

  first.resolve('verified-sid');
  await flushed;

  expect(f.verify).toHaveBeenCalledTimes(2);
  expect(f.verify.mock.calls[1]).toEqual([f.client, [event(3, null, 'thinking')]]);
  expect(f.deliver.mock.calls.map(([value]) => value.agentSeq)).toEqual([1, 2, 3]);
});

test('retains an immutable event snapshot across asynchronous verification', async () => {
  const f = fixture();
  const original = event(1);
  f.gate.enqueue(original, f.client);
  original.sessionId = 'replacement-sid';
  original.data.text = 'replacement text';

  await f.gate.flush();

  expect(f.verify.mock.calls[0][1][0]).toEqual(event(1));
  expect(f.deliver.mock.calls[0][0]).toEqual({ ...event(1), sessionId: 'verified-sid' });
});

test('fails closed before verification when the captured source is no longer current', async () => {
  const f = fixture();
  f.gate.enqueue(event(1), f.client);
  f.isCurrent.mockReturnValue(false);

  await expect(f.gate.flush()).rejects.toBeInstanceOf(ExternalAgentStreamError);

  expect(f.verify).not.toHaveBeenCalled();
  expect(f.deliver).not.toHaveBeenCalled();
  expect(f.fail).toHaveBeenCalledTimes(1);
});

test('cannot combine two source clients into one proof even if the caller accepts both', async () => {
  const f = fixture();
  f.isCurrent.mockReturnValue(true);
  f.gate.enqueue(event(1), f.client);
  f.gate.enqueue(event(2), {} as GatewayClientLike);

  await expect(f.gate.flush()).rejects.toThrow('connection owners');

  expect(f.verify).not.toHaveBeenCalled();
  expect(f.deliver).not.toHaveBeenCalled();
});

test('rechecks the exact captured connection after a proof resolves', async () => {
  const f = fixture();
  const proof = deferred<string>();
  f.verify.mockReturnValue(proof.promise);
  f.gate.enqueue(event(1), f.client);
  const flushed = f.gate.flush();
  const rejected = expect(flushed).rejects.toThrow('connection changed');
  await microtasks();
  f.isCurrent.mockReturnValue(false);
  proof.resolve('verified-sid');
  await rejected;

  expect(f.deliver).not.toHaveBeenCalled();
  expect(f.fail).toHaveBeenCalledTimes(1);
});

test('rechecks the source before each delivery and stops the remaining FIFO on replacement', async () => {
  const f = fixture();
  f.deliver.mockImplementationOnce(() => { f.isCurrent.mockReturnValue(false); });
  f.gate.enqueue(event(1, 'native-sid'), f.client);
  f.gate.enqueue(event(2, 'native-sid'), f.client);

  await expect(f.gate.flush()).rejects.toThrow('connection changed');

  expect(f.deliver).toHaveBeenCalledTimes(1);
  expect(f.fail).toHaveBeenCalledTimes(1);
});

test('synchronous closure during a current-source check cannot start verification or delivery', async () => {
  for (const stamped of [false, true]) {
    const f = fixture();
    let checks = 0;
    f.isCurrent.mockImplementation(() => {
      checks += 1;
      if (checks === (stamped ? 3 : 2)) f.gate.close();
      return true;
    });
    f.gate.enqueue(event(1, stamped ? 'native-sid' : null), f.client);

    await f.gate.flush();
    await microtasks();

    expect(f.verify).not.toHaveBeenCalled();
    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.fail).not.toHaveBeenCalled();
  }
});

test.each(['', '   '])('rejects an empty verified identity %j', async identity => {
  const f = fixture();
  f.verify.mockResolvedValue(identity);
  f.gate.enqueue(event(1), f.client);

  await expect(f.gate.flush()).rejects.toThrow('identity could not be verified');

  expect(f.deliver).not.toHaveBeenCalled();
  expect(f.fail).toHaveBeenCalledTimes(1);
});

test('reports verification failure once, drops queued output, and rejects later flushes with the same error', async () => {
  const f = fixture();
  f.verify.mockRejectedValue(new Error('untrusted native error detail'));
  f.gate.enqueue(event(1), f.client);
  f.gate.enqueue(event(2, 'native-sid'), f.client);

  await expect(f.gate.flush()).rejects.toThrow('identity could not be verified');
  const error = f.fail.mock.calls[0][0];
  f.gate.enqueue(event(3, 'native-sid'), f.client);
  await expect(f.gate.flush()).rejects.toBe(error);
  f.gate.close();

  expect(f.fail).toHaveBeenCalledTimes(1);
  expect(f.deliver).not.toHaveBeenCalled();
  expect(error.message).not.toContain('untrusted');
});

test('turns a synchronous verifier throw into one output failure', async () => {
  const f = fixture();
  f.verify.mockImplementation(() => { throw new Error('no authority'); });
  f.gate.enqueue(event(1), f.client);

  await expect(f.gate.flush()).rejects.toBeInstanceOf(ExternalAgentStreamError);

  expect(f.fail).toHaveBeenCalledTimes(1);
  expect(f.deliver).not.toHaveBeenCalled();
});

test('a delivery failure preserves an existing stream error and prevents all later output', async () => {
  const f = fixture();
  const error = new ExternalAgentStreamError('Output transport closed.');
  f.deliver.mockImplementationOnce(() => { throw error; });
  f.gate.enqueue(event(1, 'native-sid'), f.client);
  f.gate.enqueue(event(2, 'native-sid'), f.client);

  await expect(f.gate.flush()).rejects.toBe(error);
  f.gate.enqueue(event(3, 'native-sid'), f.client);
  await microtasks();

  expect(f.fail).toHaveBeenCalledExactlyOnceWith(error);
  expect(f.deliver).toHaveBeenCalledTimes(1);
});

test('a throwing failure observer cannot reopen delivery or escape enqueue', async () => {
  const f = fixture();
  f.fail.mockImplementation(() => { throw new Error('observer failed'); });
  const circular = event(1);
  circular.data.self = circular;

  expect(() => f.gate.enqueue(circular, f.client)).not.toThrow();
  await expect(f.gate.flush()).rejects.toBeInstanceOf(ExternalAgentStreamError);
  f.gate.enqueue(event(2, 'native-sid'), f.client);

  expect(f.fail).toHaveBeenCalledTimes(1);
  expect(f.verify).not.toHaveBeenCalled();
  expect(f.deliver).not.toHaveBeenCalled();
});

test('close before the scheduled microtask discards output without reporting a failure', async () => {
  const f = fixture();
  f.gate.enqueue(event(1), f.client);
  const flushed = f.gate.flush();
  f.gate.close();

  await flushed;
  await microtasks();
  await f.gate.flush();

  expect(f.verify).not.toHaveBeenCalled();
  expect(f.deliver).not.toHaveBeenCalled();
  expect(f.fail).not.toHaveBeenCalled();
});

test.each(['resolve', 'reject'] as const)(
  'close releases flush while an outstanding proof later %ss without delivering',
  async settlement => {
    const f = fixture();
    const proof = deferred<string>();
    f.verify.mockReturnValue(proof.promise);
    f.gate.enqueue(event(1), f.client);
    const flushed = f.gate.flush();
    await microtasks();
    expect(f.verify).toHaveBeenCalledTimes(1);
    f.gate.close();
    await flushed;
    if (settlement === 'resolve') proof.resolve('verified-sid');
    else proof.reject(new Error('late rejection'));
    await microtasks();

    expect(f.deliver).not.toHaveBeenCalled();
    expect(f.fail).not.toHaveBeenCalled();
  },
);

test('a hanging proof times out without flush and late success cannot deliver', async () => {
  vi.useFakeTimers();
  const f = fixture(20);
  const proof = deferred<string>();
  f.verify.mockReturnValue(proof.promise);
  f.gate.enqueue(event(1), f.client);
  await microtasks();

  await vi.advanceTimersByTimeAsync(20);
  await expect(f.gate.flush()).rejects.toThrow('verification timed out');
  proof.resolve('verified-sid');
  await microtasks();

  expect(f.fail).toHaveBeenCalledTimes(1);
  expect(f.deliver).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test('flush has one total deadline across successive individually bounded proofs', async () => {
  vi.useFakeTimers();
  const f = fixture(100);
  const first = deferred<string>();
  const second = deferred<string>();
  f.verify.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  f.gate.enqueue(event(1), f.client);
  const flushed = f.gate.flush();
  const rejected = expect(flushed).rejects.toThrow('drain timed out');
  await microtasks();
  f.gate.enqueue(event(2), f.client);
  await vi.advanceTimersByTimeAsync(60);
  first.resolve('verified-sid');
  await microtasks();
  expect(f.verify).toHaveBeenCalledTimes(2);
  expect(f.deliver).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(40);
  await rejected;
  second.resolve('verified-sid');
  await microtasks();

  expect(f.deliver).toHaveBeenCalledTimes(1);
  expect(f.fail).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test('the frame limit includes events already awaiting proof, and a limit failure cannot leak a late batch', async () => {
  const f = fixture();
  const proof = deferred<string>();
  f.verify.mockReturnValue(proof.promise);
  f.gate.enqueue(event(1), f.client);
  await microtasks();
  for (let seq = 2; seq <= 1024; seq += 1) f.gate.enqueue(event(seq, 'native-sid'), f.client);
  expect(f.fail).not.toHaveBeenCalled();
  f.gate.enqueue(event(1025, 'native-sid'), f.client);

  await expect(f.gate.flush()).rejects.toThrow('pending output limit');
  proof.resolve('verified-sid');
  await microtasks();

  expect(f.fail).toHaveBeenCalledTimes(1);
  expect(f.deliver).not.toHaveBeenCalled();
});

test('the byte limit counts UTF-8 data and in-flight batches rather than just queued characters', async () => {
  const f = fixture();
  const proof = deferred<string>();
  f.verify.mockReturnValue(proof.promise);
  const large = (seq: number) => ({ ...event(seq), data: { text: '€'.repeat(900_000) } });
  f.gate.enqueue(large(1), f.client);
  await microtasks();
  f.gate.enqueue(large(2), f.client);
  f.gate.enqueue(large(3), f.client);
  expect(f.fail).not.toHaveBeenCalled();
  f.gate.enqueue(large(4), f.client);

  await expect(f.gate.flush()).rejects.toThrow('pending output limit');
  proof.resolve('verified-sid');
  await microtasks();

  expect(f.fail).toHaveBeenCalledTimes(1);
  expect(f.deliver).not.toHaveBeenCalled();
});

test('successful delivery releases capacity and allows another flush', async () => {
  const f = fixture();
  for (let seq = 1; seq <= 1024; seq += 1) f.gate.enqueue(event(seq, 'native-sid'), f.client);
  await Promise.all([f.gate.flush(), f.gate.flush()]);
  f.gate.enqueue(event(1025), f.client);

  await f.gate.flush();

  expect(f.deliver).toHaveBeenCalledTimes(1025);
  expect(f.verify).toHaveBeenCalledTimes(1);
  expect(f.fail).not.toHaveBeenCalled();
});
