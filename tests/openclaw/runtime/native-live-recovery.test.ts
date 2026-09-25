import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from 'vitest';

const runtime = process.env.JUSTDO_TEST_PATCHED_RUNTIME
  ?? path.resolve('vendor/openclaw-runtime/current');
const dist = path.join(runtime, 'dist');
const moduleFile = fs.existsSync(dist) ? fs.readdirSync(dist)
  .filter(name => /^server-chat-state-.*\.mjs$/u.test(name))
  .map(name => path.join(dist, name))
  .find(file => fs.readFileSync(file, 'utf8').includes('function createChatRunState(')) : undefined;
if (process.env.JUSTDO_TEST_PATCHED_RUNTIME && !moduleFile) {
  throw new Error(`Native progress module not found in requested runtime: ${runtime}`);
}

test('current patch inventory excludes the retired segmented recovery patch', () => {
  expect(fs.readdirSync(path.resolve('scripts/patches/v2026.9.6'))
    .some(name => name.startsWith('017-'))).toBe(false);
});

test.skipIf(!moduleFile)('native runtime recovers buffered text and bounded tool progress without patch 017', () => {
  for (const file of [moduleFile!, path.join(runtime, 'gateway-bundle.mjs'),
    path.join(dist, 'worker/worker.mjs'), path.join(dist, 'worker/sqlite-store.worker.mjs')]) {
    expect(fs.readFileSync(file, 'utf8')).not.toContain('JUSTDO_SEGMENTED_LIVE_PROGRESS');
  }
  const result = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const native = await import(process.argv[1]);
    const create = Object.values(native).find(value => typeof value === 'function' && value.name === 'createChatRunState');
    assert.ok(create);
    const state = create();
    const record = state.getOrCreate('test');
    record.buffer = '你好，原生恢复正文';
    let seq = 0;
    const send = (stream, data) => {
      state.recordProgressEvent('test', { runId: 'test', seq: ++seq, ts: seq, stream, data }, 'full');
      const snapshot = record.progressSnapshot;
      assert.ok(Number.isFinite(snapshot.byteLength));
      assert.equal(snapshot.byteLength, snapshot.events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event), 'utf8'), 0));
      assert.ok(snapshot.byteLength <= 131072 && snapshot.events.length <= 50);
      return snapshot;
    };
    send('run_status', { phase: 'preparing_context' });
    send('assistant', { text: '你好，原生恢复正文' });
    assert.equal(state.resolveBuffer('test').text, record.buffer);
    assert.ok(!record.progressSnapshot.events.some(event => event.data.text));
    send('tool', { phase: 'start', toolCallId: 'tool-1', name: 'read', args: {} });
    let snapshot = send('item', { kind: 'tool', phase: 'update', itemId: 'tool-1', toolCallId: 'tool-1', title: 'Read file', progressText: 'reading' });
    assert.ok(snapshot.events.some(event => event.stream === 'item'));
    send('tool', { phase: 'result', toolCallId: 'tool-1', result: 'done' });
    for (let index = 0; index < 55; index++) {
      snapshot = send('tool', { phase: 'start', toolCallId: 'evict-' + index, name: 'read', args: {} });
    }
    assert.ok(!snapshot.events.some(event => event.data.toolCallId === 'tool-1'));
    assert.equal(state.resolveBuffer('test').text, record.buffer);
    console.log('native recovery passed');
  `, pathToFileURL(moduleFile!).href], { encoding: 'utf8', timeout: 60000 });
  expect(result).toContain('native recovery passed');
}, 65000);
