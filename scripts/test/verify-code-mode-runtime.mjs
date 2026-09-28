// Read-only smoke check of the packaged native executor; no model/API calls.
// Usage: node scripts/test/verify-code-mode-runtime.mjs [runtime-directory]
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = path.resolve(process.argv[2] ?? path.join(root, 'vendor/openclaw-runtime/current'));
const plugin = path.join(runtime, 'dist/extensions/code-mode-quickjs');
for (const asset of ['src/code-mode.worker.js', 'assets/quickjs.wasm', 'assets/encoding.so']) {
  await access(path.join(plugin, asset));
}
const { codeModeExecutor } = await import(
  pathToFileURL(path.join(plugin, 'code-mode-executor-api.js')).href
);
const config = {
  timeoutMs: 10000,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxOutputBytes: 65536,
  maxPendingToolCalls: 16,
  maxSnapshotBytes: 10 * 1024 * 1024,
};
const start = (source, options = {}) =>
  codeModeExecutor.execute(
    {
      kind: 'exec',
      source,
      config,
      catalog: [],
      namespaces: [],
    },
    { timeoutMs: config.timeoutMs, ...options },
  );

const completed = await start('return [1, 2, 3].map(n => n * 2);');
assert.equal(completed.status, 'completed', JSON.stringify(completed));
assert.deepEqual(JSON.parse(completed.value.json), [2, 4, 6]);

const waiting = await start(
  'const text = "你好"; await yield_control(); return new TextDecoder().decode(new TextEncoder().encode(text));',
);
assert.equal(waiting.status, 'waiting', JSON.stringify(waiting));
try {
  const resumed = await waiting.continuation.resume(
    {
      kind: 'resume',
      config,
      settledRequests: waiting.pendingRequests.map(({ id }) => ({ id, ok: true, json: 'null' })),
      pendingRequests: [],
    },
    { timeoutMs: config.timeoutMs },
  );
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
  assert.equal(JSON.parse(resumed.value.json), '你好');
} finally {
  await waiting.continuation.dispose();
}

const failed = await start('throw new Error("smoke failure");');
assert.equal(failed.status, 'failed');
assert.match(failed.error, /smoke failure/);

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 100);
try {
  const canceled = await start('while (true) {}', { signal: controller.signal });
  assert.equal(canceled.status, 'failed');
  assert.equal(canceled.code, 'aborted');
} finally {
  clearTimeout(timer);
}
console.log(
  'Code Mode QuickJS: packaged assets, execution, wait/resume, UTF-8, failure and cancellation passed.',
);
