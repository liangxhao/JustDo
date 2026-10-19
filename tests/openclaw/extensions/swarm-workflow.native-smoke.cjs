const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), {spawn} = require('node:child_process');
const assert = require('node:assert/strict');
const {buildSync} = require('esbuild');
const WebSocket = require('ws');
const original=process.env.SWARM_WORKFLOW_TEST_RUNTIME;
if(!original) throw new Error('Set SWARM_WORKFLOW_TEST_RUNTIME to a prepared OpenClaw runtime directory.');
const runtimeEntry=process.env.SWARM_WORKFLOW_TEST_ENTRY||'openclaw.mjs';
if(!['openclaw.mjs','gateway-launcher.cjs'].includes(runtimeEntry))throw Error('Unsupported fixture runtime entry.');
const base=path.resolve('.agent-tasks/swarm-workflow/native-smoke-'+Date.now());
fs.mkdirSync(path.join(base,'extensions/swarm-workflow'),{recursive:true});
fs.mkdirSync(path.join(base,'node_modules'),{recursive:true});
fs.mkdirSync(path.join(base,'project'),{recursive:true});
fs.symlinkSync(original,path.join(base,'node_modules/openclaw'),'junction');
const plugin=path.join(base,'extensions/swarm-workflow');
const formatProbe=process.env.SWARM_WORKFLOW_TEST_FORMAT_FEEDBACK==='1';
const fixtureEntry=`import workflow from ${JSON.stringify(path.resolve('openclaw-extensions/swarm-workflow/index.ts').replaceAll('\\','/'))};
export default {...workflow,register(api){
 workflow.register(api);
 const terminals=new Map();
 api.runtime.events.onAgentEvent(event=>{
  if(event.stream!=='lifecycle'||event.data?.executionSettled!==true||!['end','error'].includes(event.data.phase))return;
  const error=event.data.error;
  terminals.set(event.runId+'|'+event.sessionKey,{runId:event.runId,sessionKey:event.sessionKey,phase:event.data.phase,executionSettled:true,
   ...(typeof error==='string'?(Buffer.byteLength(JSON.stringify(error))<=2048?{error}:{errorTooLong:true}):{})});
  if(terminals.size>64)terminals.delete(terminals.keys().next().value);
 });
 api.registerGatewayMethod('swarmFixture.describeRun',async({params,respond})=>{
  try{
   const state=await api.runtime.subagent.describeRun({runId:params.runId});
   if(state.runId!==params.runId||state.sessionKey!==params.sessionKey)throw Error('Native execution identity changed');
   const {runId,sessionKey,state:status,outcome,executionSettled,cleanupSettled,currentEpoch,currentSession,epoch}=state;
   respond(true,{state:{runId,sessionKey,state:status,outcome,executionSettled,cleanupSettled,currentEpoch,currentSession,epoch},terminal:terminals.get(runId+'|'+sessionKey)});
  }catch(error){respond(false,undefined,{code:'UNAVAILABLE',message:String(error)});}
 },{scope:'operator.admin'});
}};`;
buildSync({...(formatProbe?{stdin:{contents:fixtureEntry,resolveDir:process.cwd(),sourcefile:'swarm-native-fixture.mjs'}}:{entryPoints:['openclaw-extensions/swarm-workflow/index.ts']}),outfile:path.join(plugin,'index.js'),bundle:true,platform:'node',format:'esm',external:['openclaw/plugin-sdk/*']});
fs.copyFileSync('openclaw-extensions/swarm-workflow/openclaw.plugin.json',path.join(plugin,'openclaw.plugin.json'));
fs.writeFileSync(path.join(plugin,'package.json'),JSON.stringify({name:'openclaw-swarm-workflow',type:'module',openclaw:{extensions:['./index.js']}}));
let calls=0, verificationAttempts=0;
const managementScenario=process.env.SWARM_WORKFLOW_TEST_MANAGEMENT==='1';
const interventionScenario=process.env.SWARM_WORKFLOW_TEST_INTERVENTION==='1'||managementScenario;
const retryScenario=process.env.SWARM_WORKFLOW_TEST_RETRY==='1'||interventionScenario;
const execScenario=process.env.SWARM_WORKFLOW_TEST_EXEC==='1';
const formatScenario=process.env.SWARM_WORKFLOW_TEST_FORMAT_FEEDBACK==='1';
const formatFailureScenario=process.env.SWARM_WORKFLOW_TEST_FORMAT_FAILURE;
const schemaFormatScenario=process.env.SWARM_WORKFLOW_TEST_SCHEMA_FORMAT==='1';
if(schemaFormatScenario&&!formatScenario)throw Error('Schema/JSON sequence requires format feedback');
let verifySchemaFailures=0, verifyFormatRequests=0;
let pendingSchemaCall;
const confirmedSchemaCalls=new Set();
const formatFailureOwner=process.env.SWARM_WORKFLOW_TEST_FORMAT_FAILURE_OWNER||'work';
if(!['work','verify'].includes(formatFailureOwner))throw Error('Unsupported format failure owner');
if(formatFailureScenario&&(!formatScenario||!['disconnect','http','http-long'].includes(formatFailureScenario)))throw Error('Unsupported format failure scenario');
const formatInjected=new Set(), formatPending=new Set(), formatFeedbackSeen=new Set();
const nativeExecutionEvidence=new Map();
let providerFailure;
const evidenceOnly=process.env.SWARM_WORKFLOW_TEST_EVIDENCE_ONLY==='1';
const correctionScenario=process.env.SWARM_WORKFLOW_TEST_CORRECTION==='1';
const startCorrection=process.env.SWARM_WORKFLOW_TEST_START_CORRECTION;
const unavailableStartTool='fixture_unavailable_tool';
let startMistakeMade=false, startFeedbackSeen=false;
let startMistakes=0;
let launchToolSurface;
let launchToolSurfaceChanged=false;
const emptyVerification=process.env.SWARM_WORKFLOW_TEST_VERIFICATION_EMPTY==='1';
const exhaustCorrections=process.env.SWARM_WORKFLOW_TEST_CORRECTION_EXHAUST==='1';
let invalidWorkerSubmitted=false,pendingInvalidReply=false,correctionPasses=0,correctionFeedbackSeen=false;
let invalidVerificationSubmitted=false,pendingEmptyReply=false;
let inspectionPassed=false,inspectionExecutions=0;
const inspectionWrites=()=>fs.existsSync(path.join(base,'project/inspection-count.txt'))?fs.readFileSync(path.join(base,'project/inspection-count.txt'),'utf8'):'';
let humanInputSeen=false;
const specialized=process.env.SWARM_WORKFLOW_TEST_AGENT==='reviewer';
const assignment='Use reviewer for inspection and verification.';
const models=[];
const managementReceipts=[];
let releasePauseWork;
let pauseWorkReleased=false;
let pauseWorkHeld=false;
const pauseWork=new Promise(resolve=>{releasePauseWork=resolve;});
const provider=http.createServer((req,res)=>{
 let body='';req.on('data',c=>body+=c);req.on('end',async()=>{try{
  calls++;if(calls>30){res.writeHead(500);res.end('Fixture exceeded expected call count');return;}const input=JSON.parse(body||'{}');
  models.push(input.model);
  console.log('MODEL',calls,input.model,JSON.stringify((input.tools||[]).map(t=>t.function?.name)),(input.messages||[]).length);
  const text=JSON.stringify(input.messages||[]);
  const managementIndex=(input.messages||[]).findLastIndex(m=>m.role==='user'&&JSON.stringify(m.content).includes('fixture-management: '));
  const managementUser=managementIndex<0?null:input.messages[managementIndex];
  const managementContent=typeof managementUser?.content==='string'?managementUser.content:(managementUser?.content||[]).filter(p=>p.type==='text').map(p=>p.text).join('\n');
  const managementMatch=/fixture-management: (\{[^\n]*\})/.exec(managementContent);
  const managementCommand=managementMatch?JSON.parse(managementMatch[1]):null;
  const managementControl=managementCommand&&['pause','resume','stop'].includes(managementCommand.command);
  const managementResponses=(input.messages||[]).slice(managementIndex+1).filter(m=>m.role==='tool').map(m=>{try{const value=JSON.parse(String(m.content));return value.result?.details??value.details??value;}catch{return null;}}).filter(Boolean);
  const managementState=managementResponses.find(m=>m.id&&Number.isInteger(m.revision));
  const managementAccepted=managementResponses.find(m=>m.accepted===true);
  if(managementCommand&&managementAccepted&&!managementReceipts.some(m=>m.command===managementCommand.command))managementReceipts.push({command:managementCommand.command,...managementAccepted});
  // Recognize the admitted request/tool contract, independently of explanatory prose.
  // This only drives the local fixture model; the plugin still authorizes the call.
  const intake=text.includes('swarm_workflow_start') && text.includes('fixture-once:user') && (input.tools||[]).some(t=>['swarm_workflow_start','tool_call'].includes(t.function?.name)) && !(input.messages||[]).some(m=>m.role==='tool'&&String(m.content).includes('Flow accepted.'));
  if(intake&&startMistakeMade)startFeedbackSeen=startCorrection==='prose'?text.includes('No Swarm Workflow has been accepted'):text.includes(unavailableStartTool);
  if(intake){
    const surface=JSON.stringify((input.tools||[]).map(t=>t.function?.name).sort());
    if(launchToolSurface===undefined)launchToolSurface=surface;
    else if(launchToolSurface!==surface)launchToolSurfaceChanged=true;
  }
  const deferred=(input.tools||[]).some(t=>t.function?.name==='tool_call');
  const worker=text.includes('Call swarm_workflow_complete(summary, evidence)');
  const verification=text.includes('Independently inspect every work result');
  const toolMessages=(input.messages||[]).filter(m=>m.role==='tool');
  const inspection=execScenario&&worker&&!intake&&!toolMessages.length;
  if(worker&&toolMessages.some(m=>String(m.content).includes('swarm-inspection-ok')))inspectionPassed=true;
  let toolName=managementCommand?(!managementState?'swarm_workflow_status':managementControl?'swarm_workflow_control':'swarm_workflow_intervene'):intake?'swarm_workflow_start':inspection?'exec':verification?'swarm_workflow_verify':'swarm_workflow_complete';
  let args=intake?{goal:'Read-only smoke check'+(specialized?' '+assignment:''),mode:'auto',sourceRequestId:'fixture-once:user'}:inspection?{command:'node -e "require(\'fs\').appendFileSync(\'inspection-count.txt\',\'1\');process.stdout.write(\'swarm-inspection-ok\')"',workdir:path.join(base,'project')}:verification?{passed:!retryScenario||verificationAttempts>0,...(evidenceOnly?{}:{summary:retryScenario&&verificationAttempts===0?'Missing fixture check':'Verified fixture'}),evidence:['fixture result']}:evidenceOnly?{evidence:'Read-only fixture evidence.'}:{summary:'Read-only fixture evidence.',evidence:['fixture file inspected']};
  if(managementCommand)args=!managementState?{}:{flowId:managementState.id,revision:managementState.revision,action:managementCommand.command,...(!managementControl?{nodeId:managementCommand.nodeId,text:managementCommand.text}:{})};
  // Native post-tool reminders can also be user-role entries. Only the latest
  // dispatched task/correction or literal human input starts a new execution turn.
  const lastUser=(input.messages||[]).findLastIndex(m=>m.role==='user'&&/assignedTask|Submission correction only\.|Continue independent verification with the supplied decision/.test(JSON.stringify(m.content)));
  const turnToolMessages=(input.messages||[]).slice(lastUser+1).filter(m=>m.role==='tool');
  const submitted=turnToolMessages.some(m=>String(m.content).includes('Submission persisted.'));
  if(verification&&text.includes('Human verified fixture prerequisites')){
    const message=input.messages[lastUser];
    const content=typeof message?.content==='string'?message.content:(message?.content||[]).filter(p=>p.type==='text').map(p=>p.text).join('\n');
    if(!content.endsWith('Continue independent verification with the supplied decision')||content.includes('assignedTask')||content.includes('humanInput'))throw Error('Continuation repackaged the human input');
    humanInputSeen=true;
  }
  const formatOwner=verification?'verify':worker&&!intake?'work':null;
  if(schemaFormatScenario&&formatOwner==='verify')verifyFormatRequests++;
  if(formatScenario&&formatPending.has(formatOwner)){
    if(schemaFormatScenario&&formatOwner==='verify'?!text.includes('Call 1: invalid JSON'):(!text.includes('Call 2: invalid JSON (XML-like input; use a JSON object)')||!text.includes('all 2 calls were withheld, including valid siblings')))throw Error('Missing current format feedback in native node request');
    if(text.includes('private-format-parameter'))throw Error('Rejected parameter leaked into correction request');
    if(formatOwner==='work'&&execScenario&&!toolMessages.some(m=>String(m.content).includes('swarm-inspection-ok')))throw Error('Prior inspection result was lost');
    formatPending.delete(formatOwner);formatFeedbackSeen.add(formatOwner);
  }
  if(formatFailureScenario&&formatOwner===formatFailureOwner&&formatFeedbackSeen.has(formatFailureOwner)){
    if(formatFailureScenario==='disconnect'){req.socket.destroy();return;}
    res.writeHead(503,{'Content-Type':'application/json'});
    res.end(JSON.stringify({error:{message:'Synthetic unavailable service'+(formatFailureScenario==='http-long'?' token=synthetic-private-provider-token '+'😀'.repeat(100000):''),type:'service_unavailable'}}));return;
  }
  const premature=correctionScenario&&worker&&pendingInvalidReply&&!submitted;
  if(premature)pendingInvalidReply=false;
  const emptyReply=emptyVerification&&verification&&pendingEmptyReply&&!submitted&&(input.tools||[]).length>0;
  if(emptyReply)pendingEmptyReply=false;
  let calling=managementCommand?(!managementState||(managementCommand.command!=='status'&&!managementAccepted)):!premature&&!emptyReply&&(input.tools||[]).length>0&&(intake||inspection||((worker||verification)&&!submitted));
  if(intake&&startCorrection&&(!startMistakeMade||startCorrection==='exhaust')){startMistakeMade=true;startMistakes++;if(['prose','exhaust'].includes(startCorrection))calling=false;else{toolName=unavailableStartTool;args={};}}
  if(calling&&inspection)inspectionExecutions++;
  if(calling&&((correctionScenario&&worker)||(emptyVerification&&verification))&&!inspection){
    if(text.includes('Submission correction only.')){
      correctionPasses++;correctionFeedbackSeen=text.includes('Latest submission error')&&text.includes(emptyVerification?'passed':'summary');
      if((input.tools||[]).some(t=>['exec','read','write','edit'].includes(t.function?.name)))throw Error('Correction pass retained execution tools');
      console.log('CORRECTION_PASS',correctionPasses,'feedback',correctionFeedbackSeen);
    }
    if(emptyVerification){
      if(!invalidVerificationSubmitted||exhaustCorrections){args={args};invalidVerificationSubmitted=true;pendingEmptyReply=true;}
    }else if(!invalidWorkerSubmitted||exhaustCorrections){args={summary:42,evidence:['fixture evidence']};invalidWorkerSubmitted=true;pendingInvalidReply=true;}
  }
  if(calling&&verification)verificationAttempts++;
  // Alphanumeric IDs survive the native provider sanitizer byte-for-byte, so
  // mixed schema/JSON checks can match each exact preceding tool response.
  const toolCall={id:(schemaFormatScenario?'swarmsubmit':'swarm-submit-')+calls,type:'function',function:{name:deferred?'tool_call':toolName,arguments:JSON.stringify(deferred?{id:toolName,args}:args)}};
  const toolCalls=[toolCall];
  if(schemaFormatScenario&&formatOwner==='verify'){
    if(pendingSchemaCall){
      if(!toolMessages.some(m=>m.tool_call_id===pendingSchemaCall&&String(m.content).includes('Validation failed for tool "swarm_workflow_verify"')))throw Error('Missing exact native schema error for previous call');
      confirmedSchemaCalls.add(pendingSchemaCall);pendingSchemaCall=undefined;
    }
    if(calling&&!formatInjected.has('verify')){
      if(toolMessages.filter(m=>String(m.content).includes('Validation failed for tool "swarm_workflow_verify"')).length<verifySchemaFailures)throw Error('Missing native schema error before next verifier request');
      if(verifySchemaFailures<2){verifySchemaFailures++;pendingSchemaCall=toolCall.id;toolCall.function.arguments=JSON.stringify({arguments:args});}
      else{toolCall.function.arguments='{"arguments": ';formatInjected.add('verify');formatPending.add('verify');}
    }
  }
  if(formatScenario&&formatOwner&&calling&&!inspection&&!formatInjected.has(formatOwner)&&!(schemaFormatScenario&&formatOwner==='verify')){
    formatInjected.add(formatOwner);formatPending.add(formatOwner);
    toolCalls.push({id:'format-invalid-'+calls,type:'function',function:{name:toolCall.function.name,arguments:'<private-format-parameter>'}});
  }
  const output=managementCommand?'Management fixture accepted.':emptyReply?'':text.includes('Planner')||text.includes('Return only JSON')
   ? JSON.stringify({tasks:[{id:'inspect',title:'Inspect',task:'Describe the goal without modifying files.',deps:[],access:'read',batch:null,...(specialized?{agentId:'reviewer',agentRequest:assignment}:{})}],...(specialized?{stages:{verify:{agentId:'reviewer',agentRequest:assignment}}}:{})})
   : verification ? 'Verification complete. This final explanation is deliberately not JSON.'
   : text.includes('Produce the final user-facing answer') ? 'Native flow integration fixture complete.' : 'Read-only fixture evidence.';
  // Pause only after native admission, while this deterministic model turn is held.
  // Pausing an uncertain launch correctly fences it and cannot prove it never ran.
  if(worker&&!intake&&!verification&&!managementCommand&&!schemaFormatScenario&&!formatFailureScenario&&!startCorrection&&!pauseWorkReleased&&!pauseWorkHeld){
    pauseWorkHeld=true;await pauseWork;
    if(res.destroyed||res.writableEnded)return;
  }
  if(input.stream){
   res.writeHead(200,{'Content-Type':'text/event-stream'});
   res.write('data: '+JSON.stringify({id:'test-'+calls,object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:calling?{role:'assistant',tool_calls:toolCalls.map((tool,index)=>({index,...tool}))}:{role:'assistant',content:output},finish_reason:null}]})+'\n\n');
   res.write('data: '+JSON.stringify({id:'test-'+calls,object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{},finish_reason:calling?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}})+'\n\n');
   res.end('data: [DONE]\n\n');
  } else {res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id:'test-'+calls,object:'chat.completion',model:'fixture',choices:[{index:0,message:calling?{role:'assistant',content:null,tool_calls:toolCalls}:{role:'assistant',content:output},finish_reason:calling?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}));}
 }catch(error){providerFailure=error;if(!res.headersSent)res.writeHead(500);res.end('Synthetic flow fixture failed');}});
});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 await new Promise(r=>provider.listen(43132,'127.0.0.1',r));
 const config={...(schemaFormatScenario?{tools:{toolSearch:false}}:{}),gateway:{mode:'local',port:43131,bind:'loopback',auth:{mode:'token',token:'isolated-flow-fixture-token'}},agents:{defaults:{workspace:path.join(base,'project'),skipBootstrap:true,model:{primary:'fixture/fixture'}}},models:{mode:'replace',providers:{fixture:{baseUrl:'http://127.0.0.1:43132/v1',apiKey:'fixture-only',api:'openai-completions',agentRuntime:{id:'openclaw'},request:{allowPrivateNetwork:true},models:[{id:'fixture',name:'fixture',api:'openai-completions',reasoning:false,input:['text'],contextWindow:schemaFormatScenario?256000:32000,maxTokens:4000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]}}},plugins:{allow:['swarm-workflow'],entries:{'swarm-workflow':{enabled:true,config:{availableAgentIds:specialized?['main','reviewer']:['main']}}}}};
 if(specialized){config.agents.ownership='explicit';config.agents.entries={main:{},reviewer:{name:'Reviewer',workspace:path.join(base,'project'),model:'fixture/reviewer'}};config.models.providers.fixture.models.push({...config.models.providers.fixture.models[0],id:'reviewer',name:'reviewer'});}
 fs.writeFileSync(path.join(base,'config.json'),JSON.stringify(config));
 const env={...process.env,OPENCLAW_STATE_DIR:path.join(base,'state'),OPENCLAW_CONFIG_PATH:path.join(base,'config.json'),OPENCLAW_BUNDLED_PLUGINS_DIR:path.join(base,'extensions'),OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR:'1',VITEST:'true',OPENCLAW_SKIP_CHANNELS:'1',OPENCLAW_SKIP_CRON:'1'};
 let log='';
 const launch=()=>{const processHandle=spawn(process.execPath,[path.join(original,runtimeEntry),'gateway','run','--allow-unconfigured','--port','43131','--bind','loopback'],{env,cwd:base,windowsHide:true,stdio:['ignore','pipe','pipe']});processHandle.stdout.on('data',c=>log+=c);processHandle.stderr.on('data',c=>log+=c);return processHandle;};
 let child=launch();
 let socket;
 const connectOnce=async()=>{
  await wait(15000);
  for(let i=0;i<50;i++){
   try{ socket=await new Promise((resolve,reject)=>{const ws=new WebSocket('ws://127.0.0.1:43131');ws.once('open',()=>resolve(ws));ws.once('error',reject);});break;}catch{if(child.exitCode!==null)throw new Error('Gateway exited '+child.exitCode);await wait(1000);}
  }
  if(!socket)throw new Error('Gateway startup timed out');
  const pending=new Map();let seq=0;
  socket.on('message',raw=>{const msg=JSON.parse(raw);if(msg.type==='res'){const p=pending.get(msg.id);if(p){pending.delete(msg.id);msg.ok?p.resolve(msg.payload):p.reject(new Error(JSON.stringify(msg.error)));}}});
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=String(++seq);const timer=setTimeout(()=>{pending.delete(id);reject(new Error('RPC timeout '+method));},20000);pending.set(id,{resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}});socket.send(JSON.stringify({type:'req',id,method,params}));});
  await rpc('connect',{minProtocol:4,maxProtocol:4,client:{id:'cli',version:'test',platform:'win32',mode:'cli'},role:'operator',scopes:['operator.admin','operator.read','operator.write'],auth:{token:'isolated-flow-fixture-token'}});
  console.log('CONNECTED');
  console.log('HEALTH',await rpc('swarmWorkflow.health',{}));
  return rpc;
 };
 const connect=async()=>{
   for(let attempt=0;attempt<3;attempt++){
     try{return await connectOnce();}catch(error){socket?.close();socket=undefined;if(!String(error).includes('startup-sidecars'))throw error;await wait(1000);}
   }
   throw new Error('Gateway sidecars did not become ready');
 };
 try{
  let rpc=await connect();
  let paused=false,restarted=false,retried=false;
  const executionKey=node=>node.runId+'|'+node.sessionKey;
  const assertNativeSettlement=async(node,beforeRestart=false)=>{
    assert.ok(node.runId&&node.sessionKey,'Missing exact native execution identity');
    assert.equal(node.cleanupSettled,true,'Workflow node cleanup was not settled');
    let evidence=nativeExecutionEvidence.get(executionKey(node));
    if(!evidence){
      let observed;
      for(let attempt=0;attempt<30;attempt++){
        observed=await rpc('swarmFixture.describeRun',{runId:node.runId,sessionKey:node.sessionKey});
        if(observed.state?.state==='settled'&&observed.terminal)break;
        await wait(100);
      }
      const expected=node.status==='done'?'ok':'error';
      assert.ok(['done','failed'].includes(node.status),'Workflow execution was not terminal');
      assert.deepEqual({...observed.state,epoch:undefined},{runId:node.runId,sessionKey:node.sessionKey,state:'settled',outcome:expected,
        executionSettled:true,cleanupSettled:true,currentEpoch:true,currentSession:true,epoch:undefined});
      assert.equal(typeof observed.state.epoch,'string');
      assert.equal(observed.terminal.runId,node.runId);
      assert.equal(observed.terminal.sessionKey,node.sessionKey);
      assert.equal(observed.terminal.executionSettled,true);
      assert.equal(observed.terminal.phase,expected==='ok'?'end':'error');
      assert.ok(!observed.terminal.errorTooLong,'Native terminal error exceeded its public budget');
      if(expected==='error')assert.equal(observed.terminal.error,node.error,'Workflow hid the latest native error');
      evidence={kind:node.kind,capturedBeforeRestart:beforeRestart,state:observed.state,terminal:observed.terminal};
      assert.ok(Buffer.byteLength(JSON.stringify(evidence))<4096,'Unbounded native execution evidence');
      nativeExecutionEvidence.set(executionKey(node),evidence);
    }
    assert.equal(evidence.state.runId,node.runId);
    assert.equal(evidence.state.sessionKey,node.sessionKey);
    assert.equal(evidence.state.outcome,node.status==='done'?'ok':'error');
    return evidence;
  };
  const assertFormatNodes=async(flow,beforeRestart=false)=>{
    const evidence=[];
    if(formatScenario)for(const node of flow.nodes.filter(node=>['work','verify'].includes(node.kind)&&['done','failed'].includes(node.status)))
      evidence.push(await assertNativeSettlement(node,beforeRestart));
    return evidence;
  };
  const parentKey='agent:main:justdo:flow-integration';
  const manage=async(command,nodeId,text)=>{
    const receipt=await rpc('chat.send',{sessionKey:parentKey,idempotencyKey:'fixture-manage-'+command,message:'fixture-management: '+JSON.stringify({command,nodeId,text})});
    for(let attempt=0;attempt<40;attempt++){
      const settled=await rpc('agent.wait',{runId:receipt.runId,timeoutMs:1});
      if(settled.status==='ok')return;
      if(settled.status==='error')throw Error('Management native turn failed: '+JSON.stringify(settled));
      await wait(500);
    }throw Error('Management native turn timed out');
  };
  await rpc('sessions.create',{key:parentKey,cwd:path.join(base,'project'),permissionMode:execScenario?'full':'workspace'});
  const startReceipt=await rpc('chat.send',{sessionKey:parentKey,idempotencyKey:'fixture-once',message:'Read-only smoke check'+(specialized?' '+assignment:'')+'\n\n<swarm-workflow mode="auto"/>'});
  // Cold compile, explicit restart and exact cleanup can exceed 70 polls under
  // concurrent artifact verification. Wait for this same flow; never relaunch it.
  const formatDeadline=Date.now()+240000;
  for(let i=0;formatScenario?Date.now()<formatDeadline:i<70;i++){
    if(providerFailure)throw providerFailure;
    const result=await rpc('swarmWorkflow.list',{parentKeys:[parentKey]});let flow=result.flows[0]; if(!flow){
      const source=await rpc('agent.wait',{runId:startReceipt.runId,timeoutMs:1});
      if(startCorrection==='exhaust'){
        const settled=source;
        if(!['pending','timeout'].includes(settled.status)){
          const flows=(await rpc('swarmWorkflow.list',{parentKeys:[parentKey]})).flows;
          if(settled.status!=='ok'||startMistakes!==4||calls!==4||launchToolSurfaceChanged||flows.length!==0)throw Error('Launch correction did not stop safely after 3 rounds: '+JSON.stringify({settled,startMistakes,calls,launchToolSurfaceChanged,flows:flows.length}));
          console.log('PASS',JSON.stringify({calls,startMistakes,correctionRounds:3,bounded:true,flows:0}));return;
        }
      }
      if(['ok','error'].includes(source.status)){
        // The first snapshot may precede acceptance; recheck after source settlement.
        flow=(await rpc('swarmWorkflow.list',{parentKeys:[parentKey]})).flows[0];
        if(!flow)throw Error('Source chat ended without an accepted Swarm Workflow: '+JSON.stringify({runId:startReceipt.runId,status:source.status,error:source.error,calls}));
      }
      if(!flow){await wait(1000);continue;}
    }
    if(i%5===0)console.log('STATE',flow.status,flow.nodes.map(n=>n.id+':'+n.status).join(','));
    if(!schemaFormatScenario && !formatFailureScenario && !startCorrection && !paused && pauseWorkHeld && flow.status==='running' && flow.nodes.some(n=>n.kind==='work'&&n.status==='running'&&n.runId)){
      try{await rpc('swarmWorkflow.control',{parentKeys:[parentKey],id:flow.id,revision:flow.revision,action:'pause'});}
      catch(error){if(String(error).includes('Flow revision conflict.'))continue;throw error;}
      paused=true;pauseWorkReleased=true;releasePauseWork();continue;
    }
    if(paused && !restarted && flow.status==='paused' && !flow.nodes.some(n=>['preparing','running','uncertain'].includes(n.status))){
      await assertFormatNodes(flow,true);
      const before=calls; socket.close();await new Promise(resolve=>{child.once('exit',resolve);child.kill();});socket=undefined;
      child=launch();rpc=await connect();
      const recovered=(await rpc('swarmWorkflow.list',{parentKeys:[parentKey]})).flows[0];
      if(recovered.id!==flow.id || recovered.status!=='paused' || calls!==before)throw new Error('Restart lost state or duplicated work');
      if(managementScenario)await manage('resume');else await rpc('swarmWorkflow.control',{parentKeys:[parentKey],id:recovered.id,revision:recovered.revision,action:'resume'});restarted=true;console.log('RESTART_RECOVERED');continue;
    }
    if(flow.status==='completed'){
      const nativeEvidence=await assertFormatNodes(flow);
      if(formatScenario)assert.equal(nativeEvidence.length,2,'Missing exact work/verify native settlement');
      if(execScenario&&inspectionWrites()!=='1')throw Error('Actual inspection command was not executed exactly once');
      for(const node of flow.nodes){const expected=specialized&&['task-1','verify'].includes(node.id)?'reviewer':'main';if(node.agentId!==expected||!node.sessionKey.startsWith('agent:'+expected+':'))throw new Error('Incorrect node agent binding');}
      if(specialized&&models.filter(model=>model==='reviewer').length!==((retryScenario?6:4)+(execScenario?1:0)+(correctionScenario?2:0)+(emptyVerification?3:0)+(formatScenario?2:0)))throw new Error('Specialist model was not used: '+JSON.stringify(models));
      const work = flow.nodes.find(n => n.id === 'task-1');
      const detail = await rpc('swarmWorkflow.detail', { parentKeys: [parentKey], id: flow.id, nodeId: work.id, sourceId: 'plan' });
      if (detail.submission !== 'submitted' || JSON.parse(detail.dispatch.message).assignedTask !== 'Describe the goal without modifying files.') throw new Error('Missing exact dispatch');
      const nodeHistory = await rpc('chat.history', { sessionKey: detail.sessionKey, limit: 20 });
      if (!JSON.stringify(nodeHistory.messages).includes('Read-only fixture evidence.')) throw new Error('Missing native node execution history');
      if(schemaFormatScenario&&(verifySchemaFailures!==2||confirmedSchemaCalls.size!==2||pendingSchemaCall))throw Error('Schema-to-JSON regression did not exercise two native schema refusals');
      if(formatScenario&&(formatInjected.size!==2||formatFeedbackSeen.size!==2||formatPending.size||work.attempt!==1||flow.nodes.find(n=>n.kind==='verify').attempt!==1))throw Error('Native format correction replayed or replaced a Swarm node');
      const history=await rpc('chat.history',{sessionKey:parentKey,limit:30}); if((!schemaFormatScenario&&!startCorrection&&!restarted) || calls!==((retryScenario?10:8)+(execScenario?1:0)+(correctionScenario?2:0)+(emptyVerification?3:0)+(formatScenario?2:0)+(schemaFormatScenario?2:0)+(managementScenario?9:0)+(startCorrection?1:0)) || !JSON.stringify(history.messages).includes('Native flow integration fixture complete.')) throw new Error('Missing recovery or final chat delivery');if(startCorrection&&(!startMistakeMade||!startFeedbackSeen||launchToolSurfaceChanged||(await rpc('swarmWorkflow.list',{parentKeys:[parentKey]})).flows.length!==1))throw Error('Start correction was lost or created duplicate workflows');if(execScenario&&(!inspectionPassed||inspectionExecutions!==1))throw Error('Inspection command was denied, repeated or did not return evidence');if((correctionScenario||emptyVerification)&&(!correctionFeedbackSeen||correctionPasses!==1||work.attempt!==1||flow.nodes.find(n=>n.kind==='verify').attempt!==1))throw Error('Submission was not corrected in the original task attempt');if(interventionScenario&&!humanInputSeen)throw Error('Continued verifier did not receive human input');if(managementScenario&&(managementReceipts.length!==3||!managementReceipts.some(m=>m.command==='resume'&&m.flow.status==='running')||!JSON.stringify(history.messages).includes('Swarm Workflow needs attention')))throw Error('Missing main-session management or blocker notice');console.log('PASS',JSON.stringify({calls,nodes:flow.nodes.length,delivered:true,restarted,retried,specialized,inspectionPassed,inspectionExecutions,formatFeedbackSeen:[...formatFeedbackSeen],nativeEvidence,schemaFormatScenario,verifySchemaFailures,confirmedSchemaCalls:[...confirmedSchemaCalls],verifyFormatRequests,evidenceOnly,emptyVerification,correctionPasses,correctionFeedbackSeen,startCorrection,startFeedbackSeen,humanInputSeen,managementScenario,managementReceipts:managementReceipts.map(m=>({command:m.command,accepted:m.accepted})),models}));return;
    }
    if(flow.status==='blocked'){
      if(formatFailureScenario){
        if(!flow.canRetry){await wait(500);continue;}
        const work=flow.nodes.find(n=>n.kind===formatFailureOwner);
        const expected=formatFailureScenario==='disconnect'?/couldn't connect to the AI service/i:/the AI service is (?:temporarily overloaded|having trouble)/i;
        const report={failure:formatFailureScenario,owner:formatFailureOwner,calls,schemaFormatScenario,verifySchemaFailures,verifyFormatRequests,inspectionExecutions,inspectionWrites:inspectionWrites(),formatFeedbackSeen:[...formatFeedbackSeen],work:{status:work.status,error:work.error,attempt:work.attempt,runId:work.runId,sessionKey:work.sessionKey},passed:false};
        fs.writeFileSync(path.join(base,'format-failure-result.json'),JSON.stringify(report,null,2));
        report.nativeEvidence=await assertFormatNodes(flow);
        assert.equal(report.nativeEvidence.length,formatFailureOwner==='work'?1:2,'Missing native failure/preceding work settlement');
        if(schemaFormatScenario&&(verifySchemaFailures!==2||confirmedSchemaCalls.size!==2||pendingSchemaCall))throw Error('Mixed schema/JSON failure path was not exercised');
        if(work.status!=='failed'||work.attempt!==1||inspectionExecutions!==1||inspectionWrites()!=='1'||!formatFeedbackSeen.has(formatFailureOwner))throw Error('Unsafe native format failure settlement');
        if(!expected.test(work.error??''))throw Error('Latest model error lost before Swarm node display: '+JSON.stringify(report));
        if(Buffer.byteLength(work.error)>3072||/synthetic-private-provider-token|😀/.test(work.error))throw Error('Unsafe public Swarm error');
        report.passed=true;
        fs.writeFileSync(path.join(base,'format-failure-result.json'),JSON.stringify(report,null,2));
        console.log('PASS native Swarm format failure',JSON.stringify(report));return;
      }
      if(exhaustCorrections){
        if(!flow.canRetry){await wait(500);continue;}
        const work=flow.nodes.find(n=>n.kind===(emptyVerification?'verify':'work'));
        if(correctionPasses!==3||!correctionFeedbackSeen||work.attempt!==1||work.status!=='failed'||!work.error.includes('without an accepted task submission')||calls!==((execScenario?1:0)+(emptyVerification?17:11))||(execScenario&&inspectionExecutions!==1))throw Error('Submission correction did not stop at its bound: '+JSON.stringify({correctionPasses,calls,work}));
        console.log('PASS',JSON.stringify({calls,restarted,correctionPasses,correctionFeedbackSeen,inspectionExecutions,bounded:true,taskReplayed:false}));return;
      }
      if(retryScenario&&!retried){
        if(!flow.canRetry){await wait(500);continue;}
        if(flow.nodes.some(n=>n.kind==='work'&&n.status!=='done'))throw Error('Work failed before verification: '+JSON.stringify(flow.nodes.map(n=>({id:n.id,status:n.status,error:n.error}))));
        const workKeys=flow.nodes.filter(n=>n.kind==='work').map(n=>n.sessionKey);
        const previousVerify=flow.nodes.find(n=>n.kind==='verify');
        let updated;
        if(managementScenario){
          await manage('note',previousVerify.id,'Human verified fixture prerequisites');
          const detail=await rpc('swarmWorkflow.detail',{parentKeys:[parentKey],id:flow.id,nodeId:previousVerify.id});
          if(!detail.canContinue||detail.interventions.length!==1||!detail.interventions[0].text.includes('Relayed by the main assistant'))throw Error('Main-session note was not persisted');
          await manage('continue',previousVerify.id,'Continue independent verification with the supplied decision');
          updated=(await rpc('swarmWorkflow.list',{parentKeys:[parentKey]})).flows[0];
        }else if(interventionScenario){
          const note={id:'human-note',action:'note',text:'Human verified fixture prerequisites'};
          await rpc('swarmWorkflow.intervene',{parentKeys:[parentKey],id:flow.id,nodeId:previousVerify.id,revision:flow.revision,intervention:note});
          const detail=await rpc('swarmWorkflow.detail',{parentKeys:[parentKey],id:flow.id,nodeId:previousVerify.id});
          if(!detail.canContinue||detail.interventions.length!==1)throw Error('Human input was not persisted');
          const params={parentKeys:[parentKey],id:flow.id,nodeId:previousVerify.id,revision:detail.revision,intervention:{id:'human-continue',action:'continue',text:'Continue independent verification with the supplied decision'}};
          updated=await rpc('swarmWorkflow.intervene',params);
          await rpc('swarmWorkflow.intervene',params);
        }else updated=await rpc('swarmWorkflow.control',{parentKeys:[parentKey],id:flow.id,revision:flow.revision,action:'retry'});
        if(JSON.stringify(updated.nodes.filter(n=>n.kind==='work').map(n=>n.sessionKey))!==JSON.stringify(workKeys)||(interventionScenario?updated.nodes.find(n=>n.kind==='verify').sessionKey!==previousVerify.sessionKey:updated.nodes.find(n=>n.kind==='verify').sessionKey===previousVerify.sessionKey))throw Error('Recovery used the wrong native session or replayed work');
        retried=true;console.log('RETRY_RECOVERED');continue;
      }
      throw new Error(JSON.stringify(flow));
    }
    await wait(1000);
  }throw new Error('Flow completion timed out');
 }catch(e){console.error(String(e));console.error(log.slice(-7500));process.exitCode=1;}
 finally{pauseWorkReleased=true;releasePauseWork();socket?.close();child.kill();provider.close();fs.writeFileSync(path.join(base,'gateway.log'),log);console.log('FIXTURE',base);}
})().catch(e=>{console.error(e);provider.close();process.exitCode=1});
