import vm from 'node:vm';
import { expect, test } from 'vitest';
const {
  __testing: { guard, prepare, schema, handlers, transform, seams, verifySeam },
} = require('../../../../scripts/patches/v2026.9.8/030-cron-session-permission.cjs');
test('cron permission changes require an unscoped admin and full-job runs remain protected', () => {
  const check = vm.runInNewContext(guard + ';justDoCronPermissionGuard');
  const full = {
    sessionTarget: 'isolated',
    payload: { kind: 'agentTurn', permissionMode: 'full' },
  };
  const readOnly = { ...full, payload: { ...full.payload, permissionMode: 'read-only' } };
  const admin = { connect: { scopes: ['operator.admin'] } };
  const errors: string[] = [];
  const respond = (_ok: boolean, _data: unknown, error: { message: string }) =>
    errors.push(error.message);
  expect(check(full, admin, undefined, respond, false)).toBe(true);
  expect(check(full, { connect: { scopes: ['operator.write'] } }, undefined, respond, false)).toBe(
    false,
  );
  expect(check(full, admin, { sessionKey: 'scoped' }, respond, true)).toBe(false);
  expect(check(readOnly, {}, undefined, respond, true)).toBe(false);
  expect(check(readOnly, {}, undefined, respond, false)).toBe(true);
  expect(check({ ...full, sessionTarget: 'main' }, admin, undefined, respond, true)).toBe(false);
  expect(errors).toHaveLength(4);
});
test('cron permission state uses the selected workspace after async session preparation', async () => {
  const native = `async function run(input) {
  const cronSession = await prepareCronSession({skillLibrarySelections: input.job.skillLibrarySelections});
  const selectedWorkspace=await selectWorkspace();
  const workspaceDir = selectedWorkspace.workspaceDir;
  return cronSession.sessionEntry;
 }`;
  const compiled = prepare(native).replaceAll('input', 'input3').replaceAll('undefined', 'void 0');
  const prepareSeam = seams.find((entry: { name: string }) => entry.name === 'PREPARE');
  expect(() => verifySeam(compiled, prepareSeam, 'gateway-bundle.mjs')).not.toThrow();
  expect(() =>
    verifySeam(
      compiled.replace('sessionRoot = workspaceDir', 'sessionRoot = wrongRoot'),
      prepareSeam,
      'gateway-bundle.mjs',
    ),
  ).toThrow();
  const run = vm.runInNewContext(prepare(native) + ';run', {
    prepareCronSession: async () => ({ sessionEntry: {} }),
    selectWorkspace: async () => ({ workspaceDir: 'project' }),
  });
  expect(
    await run({
      job: { sessionTarget: 'isolated', payload: { kind: 'agentTurn', permissionMode: 'full' } },
    }),
  ).toEqual({ permissionMode: 'full', sessionRoot: 'project' });
  await expect(
    run({ job: { sessionTarget: 'main', payload: { kind: 'agentTurn', permissionMode: 'full' } } }),
  ).rejects.toThrow();
  expect(await run({ job: { sessionTarget: 'isolated', payload: { kind: 'agentTurn' } } })).toEqual(
    {},
  );
});
test('cron schema uses its native union, literal and optional builders', () => {
  const native = `const CronSessionTargetSchema = Type.Union([]);
function cronAgentTurnPayloadSchema(params) {
return closedObject({kind: Type.Literal("agentTurn"), toolsAllow: Type.Optional(params.toolsAllow),});
}`;
  const build = vm.runInNewContext(schema(native) + ';cronAgentTurnPayloadSchema', {
    closedObject: (v: unknown) => v,
    Type: {
      Union: (v: unknown) => ({ anyOf: v }),
      Literal: (v: unknown) => ({ const: v }),
      Optional: (v: object) => ({ ...v, '~optional': true }),
    },
  });
  expect(build({ toolsAllow: {} }).permissionMode).toEqual({
    anyOf: [{ const: 'read-only' }, { const: 'full' }],
    '~optional': true,
  });
});

test('bundled cron handlers retain aliased job identity and validate exact current patches', () => {
  const native = `const cronHandlers = {
 "cron.add": async ({ client: client2, respond: respond2 }) => {
  const candidate2 = {};
  if (!assertValidParams(candidate2, validateCronAddParams, "cron.add", respond2)) return;
  const jobCreate2 = applyCronCreateCallerScopeDefault(candidate2);
  return add({matchesExisting: (job2) => cronJobMatchesDeclarationScope({job: job2})});
 },
 "cron.update": async ({ client: client2, respond: respond2, context: context5 }) => {
  const patch2 = normalizedPatch;
  const currentJob2 = await context5.cron.readJob(jobId2);
  const nextJob2 = await assertValidCronUpdatePatch({ currentJob: currentJob2, patch: patch2 });
 },
 "cron.run": scopedCronJobHandler("cron.run", validateCronRunParams, async ({ client: client2, respond: respond2, context: context5 }, { jobId: jobId2 }) => {
  const commitGuard2 = resolveCronMutationCommitGuard(client2, context5, {jobId: jobId2});
  return context5.cron.enqueueRun(jobId2, "force", {commitGuard: commitGuard2});
 }),
 "cron.next": other
};`;
  const rewritten = handlers(native);
  expect(rewritten).toContain('context5.cron.getJob(jobId2)');
  expect(rewritten).toContain('justDoCronPermissionGuard(currentJob2, client2');
  const seam = seams.find((entry: { name: string }) => entry.name === 'HANDLERS');
  const patched = transform(native, seam);
  expect(transform(patched, seam)).toBe(patched);
  const compiled = patched
    .replace(/\/\*JUSTDO_CRON_SESSION_PERMISSION_V2026_9_8_HANDLERS\*\//g, '')
    .trimEnd();
  expect(() => verifySeam(compiled, seam, 'gateway-bundle.mjs')).not.toThrow();
  expect(() => verifySeam(compiled, seam, 'dist/cron.mjs')).toThrow('missing HANDLERS');
  expect(() => verifySeam(native, seam, 'gateway-bundle.mjs')).toThrow('incomplete');
  expect(() =>
    verifySeam(compiled.replace('getJob(jobId2)', 'getJob(wrongJob)'), seam, 'gateway-bundle.mjs'),
  ).toThrow('historical or partial');
  expect(() => transform(patched.replace('getJob(jobId2)', 'getJob(wrongJob)'), seam)).toThrow(
    'historical or partial',
  );
  expect(() => transform(patched.replaceAll('V2026_9_8', 'V2026_9_6'), seam)).toThrow(
    'historical or unknown',
  );
});
