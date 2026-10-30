import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { DiscussionLedger } from '../../../runtime/discussion/ledger';

const roots: string[]=[];
afterEach(()=>{for(const root of roots.splice(0)){expect(path.dirname(root)).toBe(os.tmpdir());expect(path.basename(root)).toMatch(/^discussion-recovery-/u);rmSync(root,{recursive:true,force:true});}});
const directory=()=>{const root=mkdtempSync(path.join(os.tmpdir(),'discussion-recovery-'));roots.push(root);return root;};
test('a retired summary dispatcher preserves exact unresolved executions without turning Stop into cancellation evidence',()=>{
  const root=directory();const first=new DiscussionLedger(root,true);
  first.write({roomId:'room',discussionId:'batch',fingerprint:'input',owner:first.owner,state:'running',executions:[{discussionId:'batch',agentId:'main',sessionKey:'agent:main:source',sessionId:'native',lifecycleRevision:'r1',runId:'accepted',outcome:'running'}]});
  const current=new DiscussionLedger(root,true);
  expect(current.read('batch')).toMatchObject({state:'unknown',interrupted:true,owner:first.owner,executions:[{runId:'accepted',outcome:'running'}]});
});
test('a durable pre-admission cancellation with no native invocation remains a consumed business request',()=>{
  const root=directory();const first=new DiscussionLedger(root,true);
  first.write({roomId:'room',discussionId:'batch',fingerprint:'cancelled-before-admission',owner:first.owner,state:'cancelled',executions:[]});
  expect(new DiscussionLedger(root,true).read('batch')).toMatchObject({state:'cancelled',executions:[],owner:first.owner});
});
