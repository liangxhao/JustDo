import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { transformSync } from 'esbuild';
import { afterEach, describe, expect, test, vi } from 'vitest';

const { patchFollowupInitiation } =
  require('../../../../scripts/patches/v2026.10.7/003-agent-request-metadata.cjs');
const agent =
  require('../../../../scripts/patches/v2026.10.7/003-agent-request-metadata.cjs').__testing;
const reviewer =
  require('../../../../scripts/patches/v2026.10.7/004-request-purpose-metadata.cjs').__testing;

test('accepts only the complete current queued initiation transfer after esbuild', async () => {
  const source = `async function executeFollowupTurn(turn2, sourceTurnId) {
    replyRunRegistry.bindSourceTurnId(turn2.operation, sourceTurnId);
    return 42;
  }`;
  const compiled = transformSync(patchFollowupInitiation(source, 'native.mjs'), {
    loader: 'js',
    target: 'es2023',
  }).code.replaceAll('justDoFollowupHumanRuns', 'justDoFollowupHumanRuns2');
  expect(compiled).not.toContain(agent.CONTRACT);
  expect(compiled).toContain('/* @__PURE__ */ Symbol.for');
  expect(patchFollowupInitiation(compiled, 'gateway-bundle.mjs')).toBe(compiled);
  expect(() => patchFollowupInitiation(compiled, 'native.mjs')).toThrow(/partial/);

  const context = vm.createContext({ replyRunRegistry: { bindSourceTurnId() {} } });
  vm.runInContext(
    'globalThis[Symbol.for("justdo.builtin-models.human-runs")] = new Set(["source"]);',
    context,
  );
  const execute = vm.runInContext(`${compiled}\nexecuteFollowupTurn`, context);
  expect(await execute({ operation: {}, runId: 'execution' }, 'source')).toBe(42);
  expect(vm.runInContext('[...globalThis[Symbol.for("justdo.builtin-models.human-runs")]]', context))
    .toEqual(['execution']);

  for (const invalid of [
    compiled.replace('.delete(sourceTurnId)', '.delete(wrongSource)'),
    compiled.replace('.add(turn2.runId)', '.add(wrongTurn.runId)'),
    compiled.replace('if (justDoFollowupHumanRuns2?.delete(sourceTurnId))', ''),
    compiled.replace('justdo.builtin-models.human-runs', 'wrong-registry'),
    compiled.replace('replyRunRegistry.bindSourceTurnId(turn2.operation, sourceTurnId),', '0,'),
    compiled.replace('const justDoFollowupHumanRuns2', 'sideEffect(); const justDoFollowupHumanRuns2'),
    `${source}\n${compiled.replace('executeFollowupTurn', 'unrelated')}`,
  ]) {
    expect(() => patchFollowupInitiation(invalid, 'gateway-bundle.mjs')).toThrow();
  }
});

test.each([
  { owner: agent, source: agent.WRAPPER, alias: 'loadJustDoSessionEntry' },
  {
    owner: reviewer,
    source: reviewer.REVIEWER_SESSION_BLOCK,
    alias: 'loadJustDoReviewerSessionEntry',
  },
])('verifies the scoped async read after esbuild resolves $alias', ({ owner, source, alias }) => {
  expect(() => owner.verifyAsyncSessionRead(source, 'source.mjs')).not.toThrow();
  const bundle = source
    .replaceAll(alias, 'withSessionEntryReadOnlyInWorker')
    .replaceAll('read)', 'read6)')
    .replaceAll('read.ok', 'read6.ok')
    .replaceAll('read.value', 'read6.value');
  expect(() => owner.verifyAsyncSessionRead(bundle, 'gateway-bundle.mjs')).not.toThrow();
  expect(() => owner.verifyAsyncSessionRead(bundle, 'source.mjs')).toThrow();
  expect(() =>
    owner.verifyAsyncSessionRead(
      bundle.replace(
        'await withSessionEntryReadOnlyInWorker(',
        'withSessionEntryReadOnlyInWorker(',
      ),
      'gateway-bundle.mjs',
    ),
  ).toThrow();
  const unrelatedRead =
    '\nasync function unrelated() { await withSessionEntryReadOnlyInWorker({ readConsistency: "latest" }); }';
  expect(() =>
    owner.verifyAsyncSessionRead(
      bundle.replace('await withSessionEntryReadOnlyInWorker(', 'await wrongAccessor(') +
        unrelatedRead,
      'gateway-bundle.mjs',
    ),
  ).toThrow();
});

test('bundle metadata verification requires caller authority through and after the read', () => {
  const source = agent.WRAPPER.replaceAll(
    'loadJustDoSessionEntry',
    'withSessionEntryReadOnlyInWorker',
  );
  for (const invalid of [
    source.replace('params.assertCurrent,', '() => {},'),
    source.replace('params.assertCurrent();', ''),
  ]) {
    expect(() => agent.verifyAsyncSessionRead(invalid, 'gateway-bundle.mjs')).toThrow(/authority/);
  }
});

const accessorFixture = `async function withSessionEntryReadOnlyInWorker() {}
export { withSessionEntryReadOnlyInWorker as a };`;
const payloadFixture = `function streamWithPayloadPatch() {}
export { streamWithPayloadPatch as s };`;
const pythonFixture = `const blocked = [
  "PIP_CONFIG_FILE",
  "PYTHONUSERBASE",
];
function sanitizeHostExecEnvWithDiagnostics(params) {
\tconst baseEnv = params?.baseEnv ?? process.env;
\tconst merged = {};
\treturn {
\t\tenv: markOpenClawExecEnv(merged),
\t};
}`;
const promptPatch = require('../../../../scripts/patches/v2026.10.7/002-final-system-prompt-replacements.cjs');
const promptFixture = promptPatch.__testing.ATTEMPT_ANCHOR + '\n' + promptPatch.__testing.FINAL_ANCHOR + '});\n}';
const metadataFixtures = {
  'schema.mjs': `const ChatSendParamsSchema = {
systemInputProvenance: Type.Optional(InputProvenanceSchema),
systemProvenanceReceipt: Type.Optional(Type.String())
};`,
  'registration.mjs': `function register() {
  const chatSendReceivedAtMs = 0;
  context.addChatRun(clientRunId, { sessionKey, });
  return { transcript: options?.transcript, };
}`,
  'transport.mjs': `const observer = streamWithPayloadPatch;
async function prepareEmbeddedAttemptTransport(input) {
  const attempt = input.attempt;
  const session = input.session;
  const current = resolveAdmittedRunActiveAssertion();
  session.agent.streamFn = wrapApiKey(session.agent.streamFn);
  return { serverToolClearingEnabled: false, compactionReplayEnabled: false };
}`,
  'followup.mjs': `async function executeFollowupTurn(turn, sourceTurnId) {
  replyRunRegistry.bindSourceTurnId(turn.operation, sourceTurnId);
}`,
};
const purposeFixtures = {
  'compaction.mjs': `var AgentSessionCompaction = class extends Base {
  first() { return this.agent.streamFn; }
  second() { return this.agent.streamFn; }
  compact() { session_before_compact(); }
};`,
  'simple.mjs': `function completeWithPreparedSimpleCompletionModel() {}
async function completePreparedModel(params) {
  let model = prepareModelForSimpleCompletion(params.model);
  const { reasoning: level } = options;
  return completeSimple();
}`,
  'reviewer.mjs': `const EXEC_REVIEWER_MAX_TOKENS = 10;
function createModelExecAutoReviewer(params) {
  const cfg = params.cfg;
  const agentId = params.agentId ?? "main";
  return async input => tracker.track(() => complete({ model: input.model, cfg, context: input.context }));
}`,
};
const recoveryFixture = `async function recoverStore(params) {
  const result = { started: 0, settled: 0, skipped: 0 };
  for (const { sessionKey, entry: loadedEntry } of params.entries) {
    let entry = loadedEntry;
    const resumeDedupeKey = sessionKey;
    if (params.handledSessionKeys.has(resumeDedupeKey)) continue;
    const observed = await commitMainSessionRecovery({ entry });
  }
  return result;
}
const recoveryBindings = [buildMainSessionRecoverySettlementPatch, resolveRestartRecoveryTerminalClientRunId];`;
const goalFixture = `function isRestartSafeChatSession(params) {
  const entry = params.entry;
  return entry.abortedLastRun !== true && entry.archivedAt === undefined;
}
function resolveRestartSafeChatAdmission(params) { return isRestartSafeChatSession(params); }
async function admitChatSend(params) {
  const { request, session } = params;
  return resolveRestartSafeChatAdmission({ entry: session });
}`;
const replayFixture = `function transformTransportMessages(messages) {
  preserveCrossModelToolCallThoughtSignature();
  normalizeSameModelToolCallIds();
  for (const block of messages) {
    if (block.type !== "toolCall") { output.push(block); continue; }
  }
}`;
const mediaFixtures = {
  'media.mjs': `const MANAGED_DOCUMENT_MIME_TYPES = new Set(["application/json", "application/msword"]);
const missingContentType = "Managed media attachment has no detectable content type";
function resolveManagedMediaKind(mime) { return MANAGED_DOCUMENT_MIME_TYPES.has(mime) ? "document" : null; }
function createManagedOutgoingMediaBlocks(params) {
  const item = params.item;
  const media = params.media;
  const localPath = resolveLocalMediaPath(item.url);
  const contentType = media.contentType ?? item.mimeType;
  const kind = resolveManagedMediaKind(contentType);
  if (!kind) throw new Error("Managed media attachment has an unsupported content type");
  return { kind, contentType };
}`,
  'projection.mjs': `function takeAssistantManagedMediaUrlsForDisplay(message) {
  const urls = message.openclawDelivery?.mediaUrls ?? [];
  if (!urls.length) return { changed: false, urls };
  const original = message.openclawDelivery;
  const delivery = { ...original };
  delete delivery.mediaUrls;
  if (Object.keys(delivery).length) message.openclawDelivery = delivery;
  else delete message.openclawDelivery;
  return { changed: true, urls };
}`,
};
const targetCases = [
  {
    name: '001-managed-pip-config-environment.cjs',
    owners: { 'python-a.mjs': pythonFixture, 'python-b.mjs': pythonFixture },
    dependencies: {},
    corrupt: (source: string) => source.replace('\tconst baseEnv', 'const baseEnv'),
  },
  {
    name: '002-final-system-prompt-replacements.cjs',
    owners: { 'prompt.mjs': promptFixture },
    dependencies: {},
    corrupt: (source: string) => source.replace(promptPatch.__testing.FINAL_ANCHOR, ''),
  },
  {
    name: '003-agent-request-metadata.cjs',
    owners: metadataFixtures,
    dependencies: { 'accessor.mjs': accessorFixture },
    corrupt: (source: string) => source.replace('return { serverToolClearingEnabled:', 'return { invalid:'),
    partial: (source: string, root: string, file: string) =>
      require('../../../../scripts/patches/v2026.10.7/003-agent-request-metadata.cjs').patchSchema(source, file),
    internalPartials: [
      {
        name: 'human admission without hidden-turn projection',
        file: 'registration.mjs',
        make: (source: string, _root: string, file: string) =>
          require('../../../../scripts/patches/v2026.10.7/003-agent-request-metadata.cjs').patchChatRegistration(source, file)
            .replace(/transcript: p\.justdoHideUserMessage[^\n]+/, 'transcript: options?.transcript, };'),
      },
      {
        name: 'agent helper without its stream installation',
        file: 'transport.mjs',
        make: (source: string, root: string, file: string) =>
          require('../../../../scripts/patches/v2026.10.7/003-agent-request-metadata.cjs').patchAgentStream(source, root, file)
            .replace(/session\.agent\.streamFn = await wrapJustDoAgentRequestMetadata\([\s\S]*?\}\);/, ''),
      },
    ],
  },
  {
    name: '004-request-purpose-metadata.cjs',
    owners: purposeFixtures,
    dependencies: { 'accessor.mjs': accessorFixture, 'payload.mjs': payloadFixture },
    corrupt: (source: string) => source.replace('.track(() =>', '.track(unsupported =>'),
    partial: (source: string, root: string, file: string) =>
      require('../../../../scripts/patches/v2026.10.7/004-request-purpose-metadata.cjs').patchCompaction(source, root, file),
    internalPartials: [
      {
        name: 'compaction helper without both stream installations',
        file: 'compaction.mjs',
        make: (source: string, root: string, file: string) =>
          require('../../../../scripts/patches/v2026.10.7/004-request-purpose-metadata.cjs').patchCompaction(source, root, file)
            .replace('wrapJustDoCompactionRequestMetadata(this.agent.streamFn)', 'this.agent.streamFn'),
      },
      {
        name: 'simple-completion helper without its model installation',
        file: 'simple.mjs',
        make: (source: string, root: string, file: string) =>
          require('../../../../scripts/patches/v2026.10.7/004-request-purpose-metadata.cjs').patchSimpleCompletion(source, root, file)
            .replace(/model = prepareJustDoPurposeSimpleCompletionModel\([^;]+;/, ''),
      },
      {
        name: 'reviewer helper without its session lookup',
        file: 'reviewer.mjs',
        make: (source: string, root: string, file: string) =>
          require('../../../../scripts/patches/v2026.10.7/004-request-purpose-metadata.cjs').patchExecReviewer(source, root, file)
            .replace(/sessionId: await resolveJustDoReviewerSessionId\([^)]*\), requestPurpose: "exec_review", /, ''),
      },
    ],
  },
  {
    name: '005-app-startup-task-recovery-boundary.cjs',
    owners: { 'recovery.mjs': recoveryFixture },
    dependencies: {},
    corrupt: (source: string) => source.replace('const observed = await', 'const observed ='),
  },
  {
    name: '006-goal-resume-after-pause.cjs',
    owners: { 'goal.mjs': goalFixture },
    dependencies: {},
    corrupt: (source: string) => source.replace('const { request, session }', 'const { unknown, session }'),
  },
  {
    name: '007-assistant-display-block-replay.cjs',
    owners: { 'replay.mjs': replayFixture },
    dependencies: {},
    corrupt: (source: string) => source.replace('output.push(block); continue;', 'continue;'),
  },
  {
    name: '008-trusted-local-file-media.cjs',
    owners: mediaFixtures,
    dependencies: { 'disposition.mjs': 'function buildManagedMediaContentDisposition() { return buildAssistantMediaContentDisposition(); }' },
    corrupt: (source: string) => source.replace('const delivery = { ...original };', ''),
    partial: (source: string, _root: string, file: string) =>
      require('../../../../scripts/patches/v2026.10.7/008-trusted-local-file-media.cjs').__testing.transform(source, file),
  },
] as const;
const targetRoots: string[] = [];
afterEach(() => {
  for (const root of targetRoots.splice(0)) {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('runtime-target-admission-'))
      throw new Error('Unexpected target admission fixture cleanup path');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
const withoutCommentMarkers = (source: string) =>
  source.replace(/\/\/[^\n]*RUNTIME_[^\n]*/g, '').replace(/\/\*RUNTIME_[^*]*\*\//g, '');

for (const spec of targetCases) {
  describe(spec.name + ' public target admission', () => {
    const patch = require('../../../../scripts/patches/v2026.10.7/' + spec.name);
    const sourceOnly = spec.name.startsWith('001');
    function create(bundle: boolean) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-target-admission-'));
      targetRoots.push(root);
      fs.mkdirSync(path.join(root, 'dist'));
      const entries = Object.entries({ ...spec.owners, ...spec.dependencies });
      const originals = new Map(entries.map(([name, source]) => [path.join(root, 'dist', name), source]));
      for (const [file, source] of originals) fs.writeFileSync(file, source);
      const owners = Object.keys(spec.owners).map(name => path.join(root, 'dist', name));
      const bundleFile = path.join(root, 'gateway-bundle.mjs');
      const pristineBundle = entries.map(([, source]) => source).join('\n');
      if (bundle) {
        if (sourceOnly) {
          patch.applyPatch(root);
          fs.writeFileSync(bundleFile, withoutCommentMarkers(fs.readFileSync(owners[0], 'utf8')));
        } else fs.writeFileSync(bundleFile, pristineBundle);
        originals.set(bundleFile, pristineBundle);
      }
      const snapshot = () => [...originals.keys()].map(file => fs.existsSync(file) ? fs.readFileSync(file) : undefined);
      return { root, owners, originals, bundleFile, pristineBundle, snapshot };
    }
    function rejected(target: ReturnType<typeof create>) {
      const before = target.snapshot();
      const write = vi.spyOn(fs, 'writeFileSync');
      try {
        expect(() => patch.applyPatch(target.root)).toThrow();
        expect(write).not.toHaveBeenCalled();
        expect(target.snapshot()).toEqual(before);
      } finally { write.mockRestore(); }
    }

    test.each([false, true])('accepts complete targets idempotently: bundle=%s', bundle => {
      const target = create(bundle);
      if (!sourceOnly || !bundle) expect(patch.applyPatch(target.root).length).toBeGreaterThan(0);
      if (bundle) fs.writeFileSync(target.bundleFile, withoutCommentMarkers(fs.readFileSync(target.bundleFile, 'utf8')));
      const current = target.snapshot();
      expect(patch.applyPatch(target.root)).toEqual([]);
      expect(target.snapshot()).toEqual(current);
    });

    test('validates a later malformed target before writing an earlier valid target', () => {
      const target = create(!sourceOnly);
      const file = sourceOnly ? target.owners[1] : target.bundleFile;
      fs.writeFileSync(file, spec.corrupt(fs.readFileSync(file, 'utf8')));
      rejected(target);
    });

    test.each([false, true])('rejects source/bundle mixtures without writes: nativeCurrent=%s', nativeCurrent => {
      const target = create(true);
      if (!sourceOnly) patch.applyPatch(target.root);
      if (nativeCurrent) fs.writeFileSync(target.bundleFile, target.pristineBundle);
      else for (const file of target.owners) fs.writeFileSync(file, target.originals.get(file)!);
      rejected(target);
    });

    if (Object.keys(spec.owners).length > 1) test('rejects mixed native seams without writes', () => {
      const target = create(false);
      patch.applyPatch(target.root);
      fs.writeFileSync(target.owners[0], target.originals.get(target.owners[0])!);
      rejected(target);
    });

    if ('partial' in spec) test('rejects a bundle with only one current seam before writing native sources', () => {
      const target = create(true);
      fs.writeFileSync(target.bundleFile, withoutCommentMarkers(spec.partial(target.pristineBundle, target.root, target.bundleFile)));
      rejected(target);
    });

    if ('internalPartials' in spec) for (const partial of spec.internalPartials) test(
      'rejects ' + partial.name + ' before writing any target', () => {
        const target = create(false);
        const file = path.join(target.root, 'dist', partial.file);
        fs.writeFileSync(file, partial.make(target.originals.get(file)!, target.root, file));
        rejected(target);
      },
    );

    if (spec.name.startsWith('008')) test.each(['missing', 'invalid'])(
      'rejects %s native disposition ownership before writing media targets', mode => {
        const target = create(false);
        const file = path.join(target.root, 'dist', 'disposition.mjs');
        if (mode === 'missing') fs.unlinkSync(file);
        else fs.writeFileSync(file, target.originals.get(file)!.replace('buildAssistantMediaContentDisposition', 'untrustedDisposition'));
        rejected(target);
      },
    );
  });
}
