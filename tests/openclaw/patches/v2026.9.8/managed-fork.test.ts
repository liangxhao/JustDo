import path from 'node:path';
import vm from 'node:vm';
import { expect, test } from 'vitest';
const { __testing: { transformWorkerAccessor, transformSchema } } = require('../../../../scripts/patches/v2026.9.8/023-managed-session-fork-target-key.cjs');
const native = 'function resolveMessageCut(Ot,Kt){let Zt=scanSessionTranscriptTree(Ot),_n=Zt.byId.get(Kt);if(!_n)return{status:`missing-entry`};let Dn=asOptionalRecord(_n.entry),kn=asOptionalRecord(Dn?.message);if(Dn?.type!==`message`||kn?.role!==`user`)return{status:`not-user-message`};let Pn=selectSessionTranscriptTreePathNodes(Zt,Zt.leafId),Fn=Pn.findIndex(Ot=>Ot.id===Kt);if(Fn<0)return{status:`off-active-path`};let Ln=[];for(let Ot of Pn.slice(0,Fn)){let Kt=asOptionalRecord(Ot.entry);Ln.push(Kt&&Kt.parentId!==Ot.parentId?{...Kt,parentId:Ot.parentId}:Ot.entry)}let Jn=extractEditorAttachments(kn.content),cr=extractEditorMediaRefs(kn);return{status:`cut`,editorText:readMessageWorkContext(kn)?.text??extractEditorText(kn.content),...Jn?{editorAttachments:Jn}:{},...cr?{editorMediaRefs:cr}:{},parentId:_n.parentId,prefix:Ln}}\nfunction forward(database,resolved,params){ mutateSqliteSessionAtMessageInTransaction(database,resolved,{entryId:params.entryId,mode:params.mode}); return resolveMessageCut(events,params.entryId); }';
const file=path.join('dist','worker','worker.mjs');
test('worker cuts include only completed assistant responses while preserving ordinary rewind', () => {
 const source=transformWorkerAccessor(native,file);
 const previous={id:'user',parentId:null,entry:{type:'message',message:{role:'user',content:'ask'}}};
 const target={id:'answer',parentId:'user',entry:{type:'message',message:{role:'assistant',content:'reply',stopReason:'stop'}}};
 const tree={byId:new Map([[previous.id,previous],[target.id,target]]),leafId:target.id};
 const cut=vm.runInNewContext(source+';resolveMessageCut', {
  scanSessionTranscriptTree:()=>tree, asOptionalRecord:(v:unknown)=>v,
  selectSessionTranscriptTreePathNodes:()=>[previous,target], extractEditorAttachments:()=>['attachment'],
  extractEditorMediaRefs:()=>['media'], readMessageWorkContext:()=>undefined, extractEditorText:(v:unknown)=>v,
 });
 expect(cut([],target.id,true)).toMatchObject({status:'cut',parentId:'answer',prefix:[previous.entry,target.entry]});
 expect(cut([],target.id,true).editorText).toBeUndefined();
 expect(cut([],target.id,false)).toEqual({status:'not-user-message'});
 target.entry.message.stopReason='toolUse';
 expect(cut([],target.id,true)).toEqual({status:'not-user-message'});
 expect(cut([],previous.id,true)).toMatchObject({parentId:null,prefix:[],editorText:'ask'});
 expect(transformWorkerAccessor(source,file)).toBe(source);
 expect(()=>transformWorkerAccessor(source.replaceAll('V2026_9_8','V2026_9_6'),file)).toThrow();
});
test('fork extends native rewind properties with optional fields using TypeBox 1 builders', () => {
 const source='const SessionsForkParamsSchema = closedObject(SessionsRewindParamsSchema.properties); const dummy={editorText:Type.Optional(Type.String())};';
 const patched=transformSchema(source,'schema.mjs');
 const schema=vm.runInNewContext(patched+';SessionsForkParamsSchema',{
  closedObject:(properties:unknown)=>({properties}), SessionsRewindParamsSchema:{properties:{entryId:{type:'string'}}},
  NonEmptyString:{type:'string',minLength:1},Type:{Optional:(v:object)=>({...v,'~optional':true}),String:()=>({type:'string'})},
 });
 expect(schema.properties).toMatchObject({entryId:{type:'string'},targetKey:{'~optional':true,minLength:1},includeEntry:{'~optional':true,type:'boolean'}});
 expect(transformSchema(patched,'schema.mjs')).toBe(patched);
 expect(()=>transformSchema(patched.replaceAll('V2026_9_8','V2026_9_6'),'schema.mjs')).toThrow();
});
