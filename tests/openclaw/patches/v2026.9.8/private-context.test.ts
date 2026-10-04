import vm from 'node:vm';
import { expect, test } from 'vitest';
const { patchAgentContext } = require('../../../../scripts/patches/v2026.9.8/026-private-untrusted-context.cjs');
const source = `function prepareChatSendUserTurn(params) {
 const {request, client, logGateway} = params;
 const provenance = request.systemProvenanceReceipt;
 const body = 'visible';
 return {BodyForAgent: body, Body: body};
}`;
test('agent context is limited to local admin backend and leaves displayed message intact', () => {
 const patched=patchAgentContext(source,'fixture.mjs');
 const prepare=vm.runInNewContext(patched+';prepareChatSendUserTurn');
 const client={internal:{isLocalClient:true},connect:{client:{id:'gateway-client',mode:'backend'},scopes:['operator.admin']}};
 expect(prepare({request:{p:{justdoUntrustedContext:'external'}},client})).toEqual({BodyForAgent:'external\n\nvisible',Body:'visible'});
 expect(prepare({request:{p:{justdoUntrustedContext:'external'}},client:{...client,internal:{isLocalClient:false}}})).toEqual({BodyForAgent:'visible',Body:'visible'});
 expect(patchAgentContext(patched,'fixture.mjs')).toBe(patched);
 expect(()=>patchAgentContext(patched.replaceAll('V2026_9_8','V2026_9_6'),'fixture.mjs')).toThrow();
});
