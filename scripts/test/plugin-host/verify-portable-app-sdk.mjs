// Consume emitted SDK modules from an unrelated directory, without source aliases.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildAppSdk } from '../../plugins/build-app-sdk.mjs';

const temporary = await mkdtemp(path.join(tmpdir(), 'app-portable-sdk-'));
try {
  const root = await buildAppSdk(path.join(temporary, 'sdk'));
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const slot = Symbol.for('app-plugin.browser-runtime.v1');
  const previous = globalThis[slot];
  globalThis[slot] = { services: { rendering: {} } };
  const results = [];
  try {
    for (const [name, target] of Object.entries(pkg.exports)) {
      try {
        await import(pathToFileURL(path.join(root, target.default)).href);
        results.push({ entry: name, loaded: true });
      } catch (error) {
        results.push({ entry: name, loaded: false, error: error.code, message: error.message });
      }
    }
  } finally {
    if (previous === undefined) delete globalThis[slot];
    else globalThis[slot] = previous;
  }
  console.log(
    JSON.stringify({ actualEmittedSdk: true, independentNodeEsmConsumer: true, results }),
  );
  assert.ok(
    results.every(result => result.loaded),
    'Every public emitted SDK ESM entry must resolve without repository aliases',
  );
} finally {
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(tmpdir()));
  assert.ok(path.basename(temporary).startsWith('app-portable-sdk-'));
  await rm(temporary, { recursive: true, force: true });
}
