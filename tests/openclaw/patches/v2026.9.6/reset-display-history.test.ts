import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { expect, test } from 'vitest';
const {
  __testing: { transformFile, MARKERS },
} = require('../../../../scripts/patches/v2026.9.6/022-justdo-reset-display-history.cjs');
const original = `function resolveVisibleHistoryProjection(projection) {
  const boundary = resolveTranscriptBoundaryWindow(projection)?.boundarySeq ?? null;
  return boundary;
}
function readLatestActiveBoundaryMetadata(projection, scope) {
  const reset = { boundarySeq: 17 };
  if (scope === "history") return reset;
  return reset;
}`;
test.each(['agent:main:justdo:test', 'agent:main:other'])(
  'preserves model reset and scopes visible history to %s',
  key => {
    const patched = transformFile(original, 'fixture.mjs');
    const ctx = {
      resolveTranscriptBoundaryWindow: () => ({ boundarySeq: 17 }),
      projection: { resolved: { sessionKey: key } },
    };
    const result = vm.runInNewContext(
      patched +
        '; [resolveVisibleHistoryProjection(projection), readLatestActiveBoundaryMetadata(projection, "history"), readLatestActiveBoundaryMetadata(projection, "model")]',
      ctx,
    );
    expect(result[0]).toBe(key.includes(':justdo:') ? null : 17);
    expect(result[1]).toEqual(key.includes(':justdo:') ? undefined : { boundarySeq: 17 });
    expect(result[2]).toEqual({ boundarySeq: 17 });
    expect(transformFile(patched, 'fixture.mjs')).toBe(patched);
    const compiled = transformSync(patched, { target: 'node24' }).code;
    expect(transformFile(compiled, 'gateway-bundle.mjs')).toBe(compiled);
  },
);
test('rejects partial and historical display reset patches', () => {
  const patched = transformFile(original, 'fixture.mjs');
  expect(() => transformFile(patched.replace(`/*${MARKERS.history}*/`, ''), 'fixture.mjs')).toThrow(
    /partial/,
  );
  expect(() => transformFile(patched.replaceAll('V2026_9_6', 'V2026_9_2'), 'fixture.mjs')).toThrow(
    /partial/,
  );
});
