import vm from 'node:vm';
import { expect, test } from 'vitest';
const { __testing: { transform } } = require('../../../../scripts/patches/v2026.9.8/013-goal-resume-after-pause.cjs');
const native = `function isRestartSafeChatSession(params) { const entry=params.entry; return entry.abortedLastRun !== true && entry.archivedAt === undefined && entry.status !== "running"; }
function resolveRestartSafeChatAdmission(params) { return isRestartSafeChatSession(params); }
async function admitChatSend(params) { const { request, session }=params; return resolveRestartSafeChatAdmission({entry:session}); }`;
test('only Goal resume relaxes abort admission and retains the running-session guard', async () => {
 const source=transform(native,'fixture.mjs');
 const run=vm.runInNewContext(source+';admitChatSend');
 expect(await run({request:{goalOperation:{action:'resume'}},session:{abortedLastRun:true}})).toBe(true);
 expect(await run({request:{},session:{abortedLastRun:true}})).toBe(false);
 expect(await run({request:{goalOperation:{action:'resume'}},session:{abortedLastRun:true,status:'running'}})).toBe(false);
 expect(transform(source,'fixture.mjs')).toBe(source);
 expect(()=>transform(source.replaceAll('V2026_9_8','V2026_9_6'),'fixture.mjs')).toThrow();
});
