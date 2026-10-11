import vm from 'node:vm';

import { build, transformSync } from 'esbuild';
import { expect, test } from 'vitest';

const {
  patchAgentStream,
} = require('../../../../scripts/patches/v2026.9.8/006-agent-request-metadata.cjs');

const transport = `async function prepareEmbeddedAttemptTransport(input) {
  const attempt = input.attempt;
  const session = input.session;
  const assertRunCurrent = resolveAdmittedRunActiveAssertion(attempt.admittedRunContext, input.abortSignal);
  session.agent.streamFn = wrapApiKey(session.agent.streamFn);
  return { serverToolClearingEnabled: false };
}`;

test('verifies current metadata after esbuild renames shared native authority imports', async () => {
  const patched = patchAgentStream(transport, 'unused-runtime', 'gateway-bundle.mjs');
  const sources: Record<string, string> = {
    entry: `import 'fixture:other'; export { prepareEmbeddedAttemptTransport } from 'fixture:transport';`,
    other: `import { h as resolveAdmittedRunActiveAssertion } from 'authority';
      globalThis.otherResolver = resolveAdmittedRunActiveAssertion;`,
    transport: `import { h as resolveAdmittedRunActiveAssertion } from 'authority';
      ${patched}
      export { prepareEmbeddedAttemptTransport };`,
  };
  const bundle = (
    await build({
      entryPoints: ['fixture:entry'],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      external: ['authority'],
      plugins: [
        {
          name: 'native-transport-fixture',
          setup(build) {
            build.onResolve({ filter: /^fixture:/ }, args => ({
              path: args.path.slice('fixture:'.length),
              namespace: 'fixture',
            }));
            build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({
              contents: sources[args.path],
              loader: 'js',
            }));
          },
        },
      ],
    })
  ).outputFiles[0].text;
  expect(bundle).toMatch(/= resolveAdmittedRunActiveAssertion\d+\(/);
  expect(patchAgentStream(bundle, 'unused-runtime', 'gateway-bundle.mjs')).toBe(bundle);

  let revoked = false;
  const assertCurrent = () => {
    if (revoked) throw new Error('revoked');
  };
  const read = async (
    _scope: unknown,
    authority: () => void,
    consume: (value: unknown) => unknown,
  ) => {
    authority();
    return consume({ ok: true, value: { sessionId: 'child', parentSessionId: 'parent' } });
  };
  const context = vm.createContext({
    module: { exports: {} },
    require: () => ({ h: () => assertCurrent }),
    withSessionEntryReadOnlyInWorker: read,
    wrapApiKey: (stream: unknown) => stream,
    streamWithPayloadPatch: (
      _stream: unknown,
      _model: unknown,
      _context: unknown,
      _options: unknown,
      patch: (payload: unknown) => void,
    ) => {
      const payload = {};
      patch(payload);
      return payload;
    },
  });
  vm.runInContext(transformSync(bundle, { format: 'cjs', target: 'node24' }).code, context);
  const input = {
    session: {
      agent: { streamFn: (_model: unknown, _context: unknown, _options: unknown) => ({}) },
    },
    attempt: {
      sessionId: 'child',
      sessionKey: 'agent:main:justdo:source',
      runId: 'run',
      model: { provider: 'builtin_models', api: 'openai-completions' },
    },
    sessionAgentId: 'main',
  };
  await context.module.exports.prepareEmbeddedAttemptTransport(input);
  expect(input.session.agent.streamFn({}, {}, {})).toMatchObject({
    metadata: { session_id: 'child', parent_session_id: 'parent', request_purpose: 'agent' },
  });
  revoked = true;
  await expect(context.module.exports.prepareEmbeddedAttemptTransport(input)).rejects.toThrow(
    'revoked',
  );
});

test.each(['', '2', '14'])(
  'retains the authority check when installing metadata around a compiled resolver suffix %s',
  suffix => {
    const compiled = transport.replaceAll(
      'resolveAdmittedRunActiveAssertion',
      `resolveAdmittedRunActiveAssertion${suffix}`,
    );
    const patched = patchAgentStream(compiled, 'unused-runtime', 'gateway-bundle.mjs');
    expect(patched).toContain('assertCurrent: assertRunCurrent');
    expect(patchAgentStream(patched, 'unused-runtime', 'gateway-bundle.mjs')).toBe(patched);
  },
);

test.each([
  transport.replace('resolveAdmittedRunActiveAssertion', 'unrelatedResolver'),
  transport.replace('resolveAdmittedRunActiveAssertion', 'resolveAdmittedRunActiveAssertionUnsafe'),
  transport.replace(
    'const assertRunCurrent',
    'const extra = resolveAdmittedRunActiveAssertion2(); const assertRunCurrent',
  ),
])('rejects missing or ambiguous native authority in a fresh bundle', source => {
  expect(() => patchAgentStream(source, 'unused-runtime', 'gateway-bundle.mjs')).toThrow(
    /authority assertion is (missing|ambiguous)/,
  );
});

test('does not admit compiled authority aliases in pinned native source', () => {
  const source = transport.replaceAll(
    'resolveAdmittedRunActiveAssertion',
    'resolveAdmittedRunActiveAssertion14',
  );
  expect(() => patchAgentStream(source, 'unused-runtime', 'worker.mjs')).toThrow(
    /authority assertion is missing/,
  );
});
