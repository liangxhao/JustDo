import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

const patches = [
  {
    name: '009-offline-official-plugin-catalog.cjs',
    family: 'OFFLINE_OFFICIAL_PLUGIN_CATALOG',
    files: {
      'catalog.mjs': `async function loadOfficialCatalog() {
  const officialCatalog = await loadConfiguredHostedOfficialExternalPluginCatalogEntries();
  return officialCatalog;
}`,
    },
    addMarker: (source: string, marker: string) =>
      source.replace(
        'async function loadOfficialCatalog() {',
        'async function loadOfficialCatalog() {/*' + marker + '*/',
      ),
  },
  {
    name: '010-disable-configured-plugin-auto-install.cjs',
    family: 'DISABLE_CONFIGURED_PLUGIN_AUTO_INSTALL',
    files: {
      'install.mjs': `async function repairMissingPluginInstallsWithLease(params, lease) {
  const { persistedRecords } = await resolveConfiguredPluginInstallContext(params);
  await writePersistedInstalledPluginIndexInstallRecordsWithLease(persistedRecords, { lease });
  return { changes: ['installed'], warnings: [], records: persistedRecords };
}`,
    },
    addMarker: (source: string, marker: string) => source + '\n/*' + marker + '*/\n',
  },
  {
    name: '012-managed-session-fork-target-key.cjs',
    family: 'MANAGED_SESSION_FORK_TARGET_KEY_SCHEMA',
    files: {
      'schema.mjs': `const SessionsForkParamsSchema = closedObject(SessionsRewindParamsSchema.properties);
const dummy = { editorText: Type.Optional(Type.String()) };`,
      'handler.mjs': `async function mutateSessionAtMessage(action, params, client, context, respond) {
  const cfg = context.getRuntimeConfig();
  const lifecycleIdentities = [params.key];
  const targetKey = action === "fork" ? buildDashboardSessionKey(current.target.agentId, { incognito: current.entry.incognito === true || isIncognitoSessionKey(current.canonicalKey) }) : current.canonicalKey;
  const upstreamLink = preparedUpstreamLink;
  resolveOperatorSessionCreation();
  const mutationParams = { sessionKey: current.canonicalKey };
  const forkParams = { ...mutationParams, entryId, targetKey, repositoryWorkspaceId: current.repositoryWorkspaceId, forkWorkspace: forkWorkspace?.value, creation: { ...creation, sandbox } };
  mutateSessionAtMessageWithPreconditions(action === "fork" ? forkParams : { ...mutationParams, entryId }, action, expectedState);
}`,
      'accessor.mjs': `function resolveMessageCut(events, entryId) {
  const target = events.find(event => event.id === entryId);
  const record = asOptionalRecord(target.entry);
  const message = asOptionalRecord(record?.message);
  if (record?.type !== "message" || message?.role !== "user") return { status: "not-user-message" };
  const prefix = activePath.slice(0, targetIndex);
  const editorAttachments = extractEditorAttachments(message.content);
  const editorMediaRefs = extractEditorMediaRefs(message);
  selectSessionTranscriptTreePathNodes();
  return { editorText: readMessageWorkContext(message)?.text ?? extractEditorText(message.content), parentId: target.parentId, prefix, editorAttachments, editorMediaRefs };
}
function forward(database, resolved, params) {
  const intent = { canonicalSourceKey, creation: params.creation, entryId: params.entryId, mode: params.mode };
  mutateSqliteSessionAtMessageInTransaction(database, resolved, intent);
  return resolveMessageCut(events, params.entryId);
}`,
    },
    addMarker: (source: string, marker: string) => source + '\n/*' + marker + '*/\n',
  },
] as const;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (
      path.dirname(root) !== os.tmpdir() ||
      !path.basename(root).startsWith('runtime-marker-guard-')
    ) {
      throw new Error('Unexpected fixture cleanup path');
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const item of patches) {
  const patch = require('../../../../scripts/patches/v2026.10.7/' + item.name);
  for (const bundle of [false, true]) {
    describe(item.name + (bundle ? ' bundle' : ' source'), () => {
      function fixture(marker?: string) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-marker-guard-'));
        roots.push(root);
        const dist = path.join(root, 'dist');
        fs.mkdirSync(dist);
        const entries = Object.entries(item.files);
        for (const [index, [name, source]] of entries.entries()) {
          fs.writeFileSync(
            path.join(dist, name),
            marker && !bundle && index === 0 ? item.addMarker(source, marker) : source,
          );
        }
        if (bundle) {
          const source = entries.map(([, source]) => source).join('\n');
          fs.writeFileSync(
            path.join(root, 'gateway-bundle.mjs'),
            marker ? item.addMarker(source, marker) : source,
          );
        }
        return root;
      }

      test('public apply and verify accept only the current idempotent shape', () => {
        const root = fixture();
        expect(patch.applyPatch(root).length).toBeGreaterThan(0);
        expect(() => patch.verifyPatch(root)).not.toThrow();
        expect(patch.applyPatch(root)).toEqual([]);
      });

      test.each(['JUSTDO', 'RUNTIME'])('public apply rejects %s historical markers', prefix => {
        const root = fixture(prefix + '_' + item.family + '_V2026_9_8');
        expect(() => patch.applyPatch(root)).toThrow(/historical|partial/i);
      });

      test.each(['JUSTDO', 'RUNTIME'])('public verify rejects %s historical markers', prefix => {
        const root = fixture();
        patch.applyPatch(root);
        const file = bundle
          ? path.join(root, 'gateway-bundle.mjs')
          : path.join(root, 'dist', Object.keys(item.files)[0]);
        const source = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, item.addMarker(source, prefix + '_' + item.family + '_V2026_9_8'));
        expect(() => patch.verifyPatch(root)).toThrow(/historical|partial/i);
      });
    });
  }
}



const wholeFileCases = [
  { item: patches[0], target: 'catalog.mjs', family: patches[0].family },
  { item: patches[1], target: 'install.mjs', family: patches[1].family },
  { item: patches[2], target: 'schema.mjs', family: patches[2].family },
  {
    item: patches[2],
    target: 'handler.mjs',
    family: 'MANAGED_SESSION_FORK_TARGET_KEY_HANDLER',
  },
  {
    item: patches[2],
    target: 'accessor.mjs',
    family: 'MANAGED_SESSION_FORK_ASSISTANT_ENTRY',
  },

] as const;

for (const { item, target, family } of wholeFileCases) {
  const patch = require('../../../../scripts/patches/v2026.10.7/' + item.name);
  for (const bundle of [false, true]) {
    describe(`${item.name} ${target} whole-file ${bundle ? 'bundle' : 'source'} admission`, () => {
      const modes = ['pristine', 'current'] as const;
      const phases = ['applyPatch', 'verifyPatch'] as const;
      for (const mode of modes) {
        for (const phase of phases) {
          test.each(['JUSTDO', 'RUNTIME'])(`${mode} ${phase} rejects %s markers outside the function before writing`, prefix => {
            // Prefix and suffix guards cover header markers and concatenated
            // old modules, independently of each transform's selected body.
            for (const position of ['prefix', 'suffix']) {
              const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-marker-guard-'));
              roots.push(root);
              const entries: Record<string, string> = { ...item.files };
              const files = Object.entries(entries).map(([name, source]) => {
                const file = path.join(root, 'dist', name);
                fs.mkdirSync(path.dirname(file), { recursive: true });
                fs.writeFileSync(file, source);
                return file;
              });
              if (bundle) {
                const file = path.join(root, 'gateway-bundle.mjs');
                fs.writeFileSync(file, Object.values(entries).join('\n'));
                files.push(file);
              }
              if (mode === 'current') {
                patch.applyPatch(root);
                expect(() => patch.verifyPatch(root)).not.toThrow();
                expect(patch.applyPatch(root)).toEqual([]);
              }
              const file = bundle
                ? path.join(root, 'gateway-bundle.mjs')
                : path.join(root, 'dist', target);
              const source = fs.readFileSync(file, 'utf8');
              const marker = `/*${prefix}_${family}_V2026_9_8*/\n`;
              fs.writeFileSync(file, position === 'prefix' ? marker + source : source + '\n' + marker);
              const before = files.map(file => fs.readFileSync(file, 'utf8'));

              expect(() => patch[phase](root)).toThrow(/historical/i);
              expect(files.map(file => fs.readFileSync(file, 'utf8'))).toEqual(before);
            }
          });
        }
      }
    });
  }
}


const admissionCases = [
  ...patches.map(item => ({ name: item.name, files: item.files })),
  {
    name: '011-reset-display-history.cjs',
    files: {
      'history.mjs': 'function resolveVisibleHistoryProjection(projection) { return resolveTranscriptBoundaryWindow(projection)?.boundarySeq ?? null; }',
      'window.mjs': 'function readLatestActiveBoundaryMetadata(projection, scope) { const reset = {}; if (scope === "history") return reset; return reset; } function readLatestActiveBoundaryMetadataByType() {}',
    },
  },
  {
    name: '013-mxc-external-skill-paths.cjs',
    files: {
      'skills.mjs': 'function resolveSandboxSkillRuntimeInputs(params) { const skillsPromptWorkspaceDir = params.sandbox.workspaceAccess === "rw" && params.sandbox.skillsWorkspaceDir && params.sandbox.containerWorkdir ? containerJoin(params.sandbox.containerWorkdir, ...MATERIALIZED_SKILLS_WORKSPACE_CONTAINER_PARTS) : params.sandbox.containerWorkdir ?? skillsWorkspaceDir; }',
    },
  },
  {
    name: '014-private-untrusted-context.cjs',
    files: {
      'schema.mjs': 'const ChatSendParamsSchema = { justdoHideUserMessage: Type.Optional(Type.Boolean()), systemProvenanceReceipt: NonEmptyString };',
      'context.mjs': 'function prepareChatSendUserTurn(params) { const { request, client, logGateway } = params; const provenance = request.systemProvenanceReceipt; const body = "visible"; return { BodyForAgent: body, Body: body }; }',
    },
  },
  {
    name: '015-admin-session-cwd.cjs',
    files: {
      'sessions.mjs': 'const create = { enforceSandboxContainment: sessionCwd && !requestedExecNode && p.worktree !== true };',
    },
  },
  {
    name: '016-cron-session-permission.cjs',
    files: {
      'schema.mjs': 'const CronSessionTargetSchema = Type.Union([]);\nfunction cronAgentTurnPayloadSchema(params) {\nreturn closedObject({kind: Type.Literal("agentTurn"), toolsAllow: Type.Optional(params.toolsAllow),});\n}',
      'merge.mjs': 'function mergeCronPayload(current, patch) {\nconst next = {}; if (typeof patch.message === "string") next.message = patch.message; return next;\n}\nfunction buildPayloadFromPatch(patch) {\nreturn { message: patch.message, };\n}',
      'prepare.mjs': 'async function run(input) {\nconst cronSession = await prepareCronSession({skillLibrarySelections: input.job.skillLibrarySelections});\nconst selectedWorkspace = await selectWorkspace();\nconst workspaceDir = selectedWorkspace.workspaceDir;\nreturn cronSession;\n}',
      'execute.mjs': 'const execution = { toolsAllow: params.agentPayload?.toolsAllow, scheduledRuntimeAuthority: params.job.runtimeAuthority, };',
      'handlers.mjs': 'const cronHandlers = {\n "cron.add": async ({ client, respond }) => {\n  const candidate = {};\n  if (!assertValidParams(candidate, validateCronAddParams, "cron.add", respond)) return;\n  const jobCreate = applyCronCreateCallerScopeDefault(candidate);\n  return add({matchesExisting: (job) => cronJobMatchesDeclarationScope({job})});\n },\n "cron.update": async ({ client, respond, context }) => {\n  const patch = normalizedPatch;\n  const currentJob = await context.cron.readJob(jobId);\n  const nextJob = await assertValidCronUpdatePatch({ currentJob: currentJob, patch: patch });\n },\n "cron.run": scopedCronJobHandler("cron.run", validateCronRunParams, async ({ client, respond, context }, { jobId }) => {\n  const commitGuard = resolveCronMutationCommitGuard(client, context, {jobId});\n  return context.cron.enqueueRun(jobId, "force", {commitGuard});\n }),\n "cron.next": other\n};',
    },
  },
];

for (const item of admissionCases) {
  const patch = require('../../../../scripts/patches/v2026.10.7/' + item.name);
  describe(item.name + ' complete target-set admission', () => {
    function fixture(bundle = true) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-marker-guard-'));
      roots.push(root);
      fs.mkdirSync(path.join(root, 'dist'));
      const sources = Object.entries(item.files) as Array<[string, string]>;
      const files = sources.map(([name, content]) => {
        const file = path.join(root, 'dist', name);
        fs.writeFileSync(file, content);
        return file;
      });
      if (bundle) {
        const file = path.join(root, 'gateway-bundle.mjs');
        fs.writeFileSync(file, sources.map(([, content]) => content).join('\n'));
        files.push(file);
      }
      return { root, files, snapshot: () => files.map(file => fs.readFileSync(file, 'utf8')) };
    }

    function rejectWithoutWrites(target: ReturnType<typeof fixture>) {
      const before = target.snapshot();
      const write = vi.spyOn(fs, 'writeFileSync');
      try {
        expect(() => patch.applyPatch(target.root)).toThrow(/Mixed|partial|missing|anchor|historical|count/i);
        expect(write).not.toHaveBeenCalled();
        expect(target.snapshot()).toEqual(before);
      } finally {
        write.mockRestore();
      }
    }

    test.each([false, true])('admits all pristine and preserves current idempotence, bundle=%s', bundle => {
      const target = fixture(bundle);
      expect(patch.applyPatch(target.root).length).toBeGreaterThan(0);
      expect(() => patch.verifyPatch(target.root)).not.toThrow();
      const current = target.snapshot();
      expect(patch.applyPatch(target.root)).toEqual([]);
      expect(target.snapshot()).toEqual(current);
    });

    test.each([false, true])('rejects every mixed target before writing, majorityCurrent=%s', majorityCurrent => {
      const target = fixture();
      const pristine = target.snapshot();
      patch.applyPatch(target.root);
      const current = target.snapshot();
      for (let selected = 0; selected < target.files.length; selected++) {
        for (const [index, file] of target.files.entries())
          fs.writeFileSync(file, (majorityCurrent ? index !== selected : index === selected) ? current[index] : pristine[index]);
        rejectWithoutWrites(target);
      }
    });

    test('accepts comment-stripped current bundles and rejects their mixture with pristine source', () => {
      const target = fixture();
      const pristine = target.snapshot();
      patch.applyPatch(target.root);
      const bundle = target.files.at(-1)!;
      const stripped = fs.readFileSync(bundle, 'utf8').replace(/\/\*RUNTIME_[^]*?\*\/ ?/g, '').replace(/\/\/ RUNTIME_[^\r\n]*/g, '');
      fs.writeFileSync(bundle, stripped);
      expect(() => patch.verifyPatch(target.root)).not.toThrow();
      expect(() => patch.applyPatch(target.root)).not.toThrow();
      expect(patch.applyPatch(target.root)).toEqual([]);
      for (const [index, file] of target.files.slice(0, -1).entries()) fs.writeFileSync(file, pristine[index]);
      fs.writeFileSync(bundle, stripped);
      rejectWithoutWrites(target);
    });

    test('validates a malformed later target before writing a pristine earlier target', () => {
      const target = fixture();
      const pristine = target.snapshot();
      patch.applyPatch(target.root);
      const lastSource = target.files.length - 2;
      const malformed = target.snapshot()[lastSource].replaceAll('V2026_10_7', 'V2026_9_8');
      for (const [index, file] of target.files.entries())
        fs.writeFileSync(file, index === lastSource ? malformed : pristine[index]);
      rejectWithoutWrites(target);
    });

    if (Object.keys(item.files).length > 1) {
      test('rejects mixed seams within one bundle before writing any pristine source', () => {
        const target = fixture();
        const pristine = target.snapshot();
        patch.applyPatch(target.root);
        const current = target.snapshot();
        for (const [index, file] of target.files.entries()) fs.writeFileSync(file, pristine[index]);
        const partial = [current[0], ...pristine.slice(1, -1)].join('\n')
          .replace(/\/\*RUNTIME_[^]*?\*\/ ?/g, '').replace(/\/\/ RUNTIME_[^\r\n]*/g, '');
        fs.writeFileSync(target.files.at(-1)!, partial);
        rejectWithoutWrites(target);
      });
    }

    if (item.name === '012-managed-session-fork-target-key.cjs') {
      test.each(['parameter', 'attachments', 'media'])(
        'rejects a missing accessor %s contract before writing', contract => {
          for (const bundle of [false, true]) {
            const target = fixture();
            patch.applyPatch(target.root);
            const file = bundle ? target.files.at(-1)!
              : target.files.find(file => path.basename(file) === 'accessor.mjs')!;
            const current = fs.readFileSync(file, 'utf8');
            const missing = contract === 'parameter'
              ? current.replace(/events,\s*entryId,\s*includeEntry\s*=\s*false/, 'events, entryId')
              : current.replace(new RegExp(`includeTargetEntry\\s*\\?\\s*(?:undefined|void\\s*0)\\s*:\\s*(extractEditor${contract === 'attachments' ? 'Attachments' : 'MediaRefs'})`), '$1');
            expect(missing).not.toBe(current);
            fs.writeFileSync(file, missing);
            rejectWithoutWrites(target);
            expect(() => patch.verifyPatch(target.root)).toThrow();
          }
        },
      );

      test.each([
        { bundle: false, stripped: false },
        { bundle: true, stripped: false },
        { bundle: true, stripped: true },
      ])('rejects missing handler forwarding before writing: %j', ({ bundle, stripped }) => {
        const target = fixture();
        patch.applyPatch(target.root);
        const file = bundle ? target.files.at(-1)!
          : target.files.find(file => path.basename(file) === 'handler.mjs')!;
        const current = fs.readFileSync(file, 'utf8');
        const missing = current.replace(/includeEntry:\s*requestedForkIncludeEntry\s*,?/g, '');
        expect(missing).not.toBe(current);
        fs.writeFileSync(file, stripped ? missing.replace(/\/\*RUNTIME_[^]*?\*\//g, '') : missing);
        rejectWithoutWrites(target);
        expect(() => patch.verifyPatch(target.root)).toThrow();
      });
    }

    if (item.name === '016-cron-session-permission.cjs') {
      test.each(['permissionMode', 'sessionRoot'])('rejects a lone embedded-run %s field', field => {
        const target = fixture();
        const file = target.files.at(-1)!;
        const pristine = fs.readFileSync(file, 'utf8');
        const partial = pristine.replace('toolsAllow: params.agentPayload?.toolsAllow,',
          `${field}: params.cronSession.sessionEntry.${field},\ntoolsAllow: params.agentPayload?.toolsAllow,`);
        expect(partial).not.toBe(pristine);
        fs.writeFileSync(file, partial);
        rejectWithoutWrites(target);
      });
    }

    if (item.name === '013-mxc-external-skill-paths.cjs') {
      test.each([
        { bundle: false, stripped: false },
        { bundle: true, stripped: false },
        { bundle: true, stripped: true },
      ])('rejects extra pristine or patched skill resolvers: %j', ({ bundle, stripped }) => {
        for (const addition of ['pristine', 'patched']) {
          const target = fixture();
          const pristine = target.snapshot();
          patch.applyPatch(target.root);
          const current = target.snapshot();
          const index = bundle ? target.files.length - 1 : 0;
          const sibling = (addition === 'pristine' ? pristine[index] : current[index])
            .replace('function resolveSandboxSkillRuntimeInputs(', 'function unpatchedSibling(')
            .replace(/\/\*RUNTIME_[^]*?\*\//g, '');
          const duplicated = current[index] + '\n' + sibling;
          fs.writeFileSync(target.files[index], stripped
            ? duplicated.replace(/\/\*RUNTIME_[^]*?\*\//g, '')
            : duplicated);
          rejectWithoutWrites(target);
          expect(() => patch.verifyPatch(target.root)).toThrow();
        }
      });
    }

    if (item.name === '015-admin-session-cwd.cjs') {
      test.each([false, true])('rejects duplicate patched or mixed cwd conditions, stripped=%s', stripped => {
        for (const addition of ['patched', 'pristine']) {
          const target = fixture();
          const pristine = target.snapshot();
          patch.applyPatch(target.root);
          const current = target.snapshot();
          const bundle = target.files.at(-1)!;
          const duplicated = current.at(-1)! + '\n' +
            (addition === 'patched' ? current.at(-1)!.replace(/\/\*RUNTIME_[^]*?\*\//g, '') : pristine.at(-1)!);
          fs.writeFileSync(bundle, stripped ? duplicated.replace(/\/\*RUNTIME_[^]*?\*\//g, '') : duplicated);
          rejectWithoutWrites(target);
          expect(() => patch.verifyPatch(target.root)).toThrow();
        }
      });
    }
  });
}
