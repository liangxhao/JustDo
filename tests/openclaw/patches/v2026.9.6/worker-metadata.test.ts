import path from 'node:path';
import { transformSync } from 'esbuild';
import { expect, test } from 'vitest';
const {
  patchCompaction,
} = require('../../../../scripts/patches/v2026.9.6/007-request-purpose-metadata.cjs');

test.each(['worker.mjs', 'sqlite-store.worker.mjs'])(
  'uses embedded payload helpers in %s',
  name => {
    const source = `function streamWithPayloadPatch() {}
var AgentSessionCompaction = class extends Base {
  compact() { return [this.agent.streamFn, this.agent.streamFn]; }
};`;
    const file = path.join('dist', 'worker', name);
    const patched = patchCompaction(source, 'unused-runtime', file);
    expect(patched).not.toContain('import {');
    expect(patched).toContain('wrapJustDoCompactionRequestMetadata(this.agent.streamFn)');
    expect(() => transformSync(patched, { target: 'node24' })).not.toThrow();
    expect(patchCompaction(patched, 'unused-runtime', file)).toBe(patched);
  },
);
