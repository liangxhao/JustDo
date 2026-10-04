import vm from 'node:vm';
import { expect, test } from 'vitest';
const { __testing: { transformMain } } = require('../../../../scripts/patches/v2026.9.8/008-app-startup-task-recovery-boundary.cjs');
const native = `async function recoverStore(params) {
 const result = {started:0, settled:0, skipped:0};
 for (const {sessionKey, entry: loadedEntry} of params.entries) {
  let entry = loadedEntry;
  const resumeDedupeKey = sessionKey;
  if (params.handledSessionKeys.has(resumeDedupeKey)) continue;
  const observed = await commitMainSessionRecovery({entry});
 }
 return result;
}`;

test('settles a previous host epoch before native recovery and retains same-epoch recovery', async () => {
 const source = transformMain(native, 'fixture.mjs');
 const oldEntry = {sessionId:'old', status:'running', abortedLastRun:true, startedAt:50};
 const newEntry = {sessionId:'new', status:'running', abortedLastRun:true, startedAt:150};
 const entries = [{sessionKey:'old',entry:oldEntry},{sessionKey:'new',entry:newEntry}];
 const recovered: string[] = [];
 const run = vm.runInNewContext(source + ';recoverStore', {
  process:{env:{JUSTDO_APP_STARTED_AT_MS:'100'}},
  applySessionEntryReplacements: async (params: { update: (entries: unknown[]) => unknown }) => params.update(entries),
  buildRestartRecoveryClaimCleanupPatch:()=>({}), buildMainSessionRecoveryClearPatch:()=>({}),
  resolveRestartRecoveryTerminalClientRunId:()=> 'terminal', mainSessionRecoveryLog:{info:()=>{}},
  commitMainSessionRecovery: async ({entry}:{entry:{sessionId:string}})=>recovered.push(entry.sessionId),
 });
 expect(await run({entries, handledSessionKeys:new Set(),storePath:'state'})).toMatchObject({settled:1});
 expect(oldEntry).toMatchObject({status:'failed', abortedLastRun:false});
 expect(recovered).toEqual(['new']);
 expect(transformMain(source,'fixture.mjs')).toBe(source);
 expect(()=>transformMain(source.replaceAll('V2026_9_8','V2026_9_6'),'fixture.mjs')).toThrow();
});
