// Render the real discussion component in an isolated, hidden Electron window.
// The bridge is a deterministic fixture; this does not launch the user's app.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { build } = require('esbuild');
(async () => {
  const root = path.resolve(__dirname, '../../..');
  const target = path.join(root, '.tmp', 'agent-team-ui');
  fs.mkdirSync(target, { recursive: true });
  const roster = [
    { id: 'main', name: '主助手', enabled: true },
    { id: 'alice', name: '架构助手', enabled: true },
    { id: 'bob', name: '产品助手', enabled: true },
  ];
  const mocks = {
    '@/services/config':
      'export const configService={getConfig:()=>({voice:{inputEnabled:true,recognitionMode:"online"}})};',
    '../collaboration/CollaborationMemberHistory': 'export default function History(){return null}',
    './CollaborationMemberHistory': 'export default function History(){return null}',
    '@/store': `import {configureStore} from '@reduxjs/toolkit';import cowork from ${JSON.stringify(path.join(root, 'src/renderer/features/cowork/coworkSlice.ts'))};export const store=configureStore({reducer:{cowork,agent:(state=${JSON.stringify({ agents: roster })})=>state},preloadedState:{cowork:{...cowork(undefined,{type:'fixture/init'}),currentSession:{id:'source',agentId:'main'}}}});`,
    '@/features/cowork/coworkService': 'export const coworkService={loadSession:async()=>null};',
    'react-redux': `import {useSyncExternalStore} from 'react';import {store} from '@/store';export const useSelector=select=>select(useSyncExternalStore(store.subscribe,store.getState));`,
    '@/services/i18n': `import {translations} from ${JSON.stringify(path.join(root, 'src/renderer/services/i18n/translations.ts'))}; export const i18nService={getLanguage:()=> 'zh',onLanguageChange:()=>()=>{},t:key=>translations.zh[key]??key};`,
  };
  const entry = `
import React from 'react'; import {createRoot} from 'react-dom/client';
import AgentTeamSettingsDialog from './src/renderer/features/plugins/extensions/AgentTeamSettingsDialog';
import {defaultAgentTeamSettings} from './src/shared/cowork/agent-team/agentTeamSettings';
import TeamDiscussionView from './src/renderer/features/cowork/components/discussions/TeamDiscussionView';
import AgentTeamPanel from './src/renderer/features/cowork/components/display/AgentTeamPanel';
import {CollaborationMemberLinks} from './src/renderer/features/cowork/components/collaboration/CollaborationPanel';
import {useSelector} from 'react-redux';import {store} from '@/store';
import {removeDraftMessageQuotes} from './src/renderer/features/cowork/coworkSlice';
import MessageQuoteCards from './src/renderer/features/cowork/components/composer/MessageQuoteCards';
const room={id:'fixture',sourceSessionId:'source',title:'新版 Agent Team 交互设计讨论',cwd:'C:/项目/团队讨论',permissionMode:'ask',readOnly:true,summarySource:{agentId:'main',sessionKey:'agent:main:justdo:source',sessionId:'native-source',lifecycleRevision:'revision'},members:[{agentId:'alice',name:'架构助手'},{agentId:'bob',name:'产品助手'}],rounds:2,revision:1,state:'ready',latestRun:{discussionId:'batch',requestId:'fixture-request',state:'completed'}};
const taskRoom={id:'task-room',anchorSessionId:'source',members:[{agentId:'main',sessionId:'source',sessionKey:'agent:main:justdo:source'},{agentId:'alice',sessionId:'worker',sessionKey:'agent:alice:justdo:worker'},{agentId:'bob',sessionId:'reviewer',sessionKey:'agent:bob:justdo:reviewer'}]};
const taskDeliveries=Array.from({length:8},(_,index)=>({id:'review-delivery-'+index,roomId:'task-room',roundId:'task-batch',from:'main',to:'bob',toolCallId:'call-'+index,sourceRunId:'source-run',runId:'review-run-'+index,state:'accepted',createdAt:index,updatedAt:index}));
const taskReviews=taskDeliveries.map((delivery,index)=>({id:'review-'+index,roomId:'task-room',roundId:'task-batch',reviewerAgentId:'bob',reviewDeliveryId:delivery.id,runId:delivery.runId,createdAt:index,deliveryIds:['work-'+index],state:index===7?'pending':'confirmed',verdict:index===0?'changes_requested':'passed'}));
const taskRounds=[{id:'older-batch',state:'settled',pending:0},{id:'task-batch',state:'open',pending:1}];taskRoom.rounds=taskRounds;
const olderDelivery={...taskDeliveries[0],id:'older-review-delivery',roundId:'older-batch',runId:'older-review-run'};taskDeliveries.unshift(olderDelivery);
taskReviews.unshift({...taskReviews[0],id:'older-review',roundId:'older-batch',reviewDeliveryId:olderDelivery.id,runId:olderDelivery.runId,verdict:'passed'});
const groups=[room,{...room,id:'architecture-group',title:'架构方案讨论'},{...room,id:'risks-group',title:'实施风险讨论'}];
const messages=[{id:'u',role:'user',text:'请讨论群聊模式的界面：如何避免所有助手同时回复造成干扰？',timestamp:1,mediaUrls:[]},{id:'a',role:'assistant',agentId:'alice',text:'建议由原生讨论引擎控制轮数。\\n\\n- 首轮通知选定成员\\n- 后续轮次仅由相关成员继续\\n- 使用 **停止讨论** 随时结束',timestamp:2,mediaUrls:[]},{id:'b',role:'assistant',agentId:'bob',text:'界面保留一条公开时间线，并把成员信息放进抽屉。\\n\\n用户可以引用某条消息，再在输入框输入 @ 选择参与者。',timestamp:3,mediaUrls:[]}].map((message,index)=>({...message,discussionId:'batch',sequence:index+1}));
if(new URLSearchParams(location.search).has('short'))messages[0].text='还在吗大家';
const defaults={version:1,revision:0,value:defaultAgentTeamSettings()};
window.electron={agentTeamSettings:{read:async()=>({success:true,value:defaults}),save:async value=>({success:true,value:{...defaults,value}}),readTeam:async (kind,id)=>({success:true,value:{global:defaults,team:{revision:0,value:{}},memberCount:kind==='discussion'?2:3}}),saveTeam:async()=>({success:true})},onlineAsr:{getStatus:async()=>({available:true}),onEvent:()=>()=>{}},localSpeechModels:{onChanged:()=>()=>{}},cowork:{onSessionsChanged:()=>()=>{}},collaboration:{list:async()=>({success:true,value:[taskRoom]}),read:async()=>({success:true,value:{room:taskRoom,deliveries:taskDeliveries,reviews:taskReviews,rounds:taskRounds}})},extensions:{list:async()=>({success:true,extensions:[{id:'agent-team',enabled:true}]}),onChanged:()=>()=>{}},teamDiscussion:{list:async()=>({success:true,value:groups}),read:async id=>({success:true,value:{room:groups.find(item=>item.id===id)??room,messages,historyUnavailable:false,latestRun:{state:'completed',discussionId:'batch'},runs:[{discussionId:'batch',state:'completed'}],organizer:{agentId:'main',name:'主助手',sourceSessionId:'source'},summary:{discussionId:'batch',state:'delivered'}}})}};
const draft=new URLSearchParams(location.search).has('draft');
const graph=new URLSearchParams(location.search).has('graph');
function TeamFixture(){
 const [selection,setSelection]=React.useState({key:graph?undefined:'group:fixture',version:0});
 const quotes=useSelector(state=>state.cowork.draftMessageQuotes.source??[]);const sourceInput=React.useRef(null);
 return <div className="flex h-full min-h-0 flex-col"><header className="flex h-10 shrink-0 justify-end overflow-hidden border-b border-border px-2"><CollaborationMemberLinks sessionId="source" onOpen={entry=>setSelection(current=>({key:entry.key,version:current.version+1}))}/></header><div className="flex min-h-0 flex-1 flex-col md:flex-row">{quotes.length>0&&<aside data-source-composer className="shrink-0 border-r border-border p-3 md:w-80"><p className="mb-2 text-sm">主会话输入框</p><MessageQuoteCards quotes={quotes} onRemove={id=>store.dispatch(removeDraftMessageQuotes({draftKey:'source',ids:[id]}))}/><textarea ref={sourceInput} aria-label="主会话要求" className="w-full rounded-lg border border-border p-2" defaultValue="原有的主会话要求"/></aside>}<div className="min-h-0 min-w-0 flex-1"><AgentTeamPanel source={{id:'source',agentId:'main',cwd:room.cwd}} selectionRequest={selection} onFocusComposer={()=>requestAnimationFrame(()=>sourceInput.current?.focus())} onSelect={()=>{}}/></div></div></div>;
}
createRoot(document.getElementById('root')).render(new URLSearchParams(location.search).has('settings')?<AgentTeamSettingsDialog onClose={()=>{}}/>:draft?<TeamDiscussionView entry={{cwd:room.cwd,draft:'讨论一下方案'}} onClose={()=>{}}/>:<TeamFixture/>);
`;
  await build({
    stdin: { contents: entry, resolveDir: root, loader: 'tsx' },
    outfile: path.join(target, 'view.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    alias: { '@': path.join(root, 'src/renderer'), '@shared': path.join(root, 'src/shared') },
    plugins: [
      {
        name: 'fixture-bridge',
        setup(build) {
          build.onResolve({ filter: /.*/ }, args =>
            Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'fixture' } : undefined,
          );
          build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({
            contents: mocks[args.path],
            loader: 'js',
            resolveDir: root,
          }));
        },
      },
    ],
  });
  const styles = fs
    .readdirSync(path.join(root, 'dist/assets'))
    .filter(file => file.endsWith('.css'));
  fs.writeFileSync(
    path.join(target, 'index.html'),
    `<!doctype html><html lang="zh"><head><meta charset="utf-8">${styles.map(file => `<link rel="stylesheet" href="${pathToFileURL(path.join(root, 'dist/assets', file))}">`).join('')}<style>html,body,#root{height:100%;margin:0}body{--color-surface:248 249 251}</style></head><body><div id="root"></div><script src="view.js"></script></body></html>`,
  );
  fs.writeFileSync(
    path.join(target, 'capture.cjs'),
    `
const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const path=require('node:path');
app.setPath('userData',path.join(__dirname,'profile'));app.disableHardwareAcceleration();
app.whenReady().then(async()=>{try{
 const window=new BrowserWindow({width:1100,height:820,show:false,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});
 const capture=async name=>{await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');fs.writeFileSync(path.join(__dirname,name+'.png'),(await window.webContents.capturePage()).toPNG());};
 const failures=[];window.webContents.on('console-message',(_e,params,legacyMessage)=>{const level=typeof params==='object'?params.level:params;const message=typeof params==='object'?params.message:legacyMessage;if(level==='error'||level>=3){failures.push(message);console.error(message)}});
 for(const [name,width,draft,graph] of [['desktop',1100,false,false],['narrow',560,false,false],['small',360,false,false],['draft',900,true,false],['graph',1100,false,true],['graph-narrow',560,false,true]]){
   window.setSize(width,820);await window.loadFile(path.join(__dirname,'index.html'),{query:draft?{draft:'1'}:graph?{graph:'1'}:{}});
   await new Promise(resolve=>setTimeout(resolve,600));
   const state=await window.webContents.executeJavaScript('({articles:document.querySelectorAll("[data-discussion-message]").length,aligned:[...document.querySelectorAll("[data-discussion-message]")].every(row=>{const avatar=row.querySelector(".chat-avatar");if(!avatar)return false;const a=avatar.getBoundingClientRect();const b=row.getBoundingClientRect();return row.dataset.messageRole==="user"?a.left>b.left+b.width/2:a.right<b.left+b.width/2}),overflow:document.documentElement.scrollWidth>innerWidth,text:document.body.innerText.includes("群组讨论")})');
   if((!draft&&!graph&&(state.articles!==3||!state.aligned))||state.overflow||!state.text)throw new Error(JSON.stringify({name,state,failures}));
   if(!draft){const tabs=await window.webContents.executeJavaScript('({count:document.querySelectorAll("nav button").length,selected:[...document.querySelectorAll("nav button")].filter(button=>button.getAttribute("aria-pressed")==="true").length})');if(tabs.count!==5||tabs.selected!==1)throw new Error(JSON.stringify({name,tabs}));}
   if(!draft&&!graph){await window.webContents.executeJavaScript('document.querySelector("[data-discussion-message]").closest(".overflow-auto").scrollTo({top:0,behavior:"instant"})');await new Promise(resolve=>setTimeout(resolve,250));}
   if(graph){const layout=await window.webContents.executeJavaScript('(()=>{const svg=[...document.querySelectorAll("svg")].find(svg=>svg.getAttribute("viewBox")?.startsWith("0 0 500"));const bounds=svg?.getBoundingClientRect();return {height:bounds?.height,bottom:bounds?.bottom,reviews:document.body.innerText.includes("独立验收"),pending:document.body.innerText.includes("等待执行确认")}})()');if(!layout.height||layout.height<120||layout.bottom>820||!layout.reviews||!layout.pending)throw new Error(JSON.stringify({name,layout}));}
   await capture(name);
   if(graph){
     await window.webContents.executeJavaScript('[...document.querySelectorAll("nav button")].find(button=>button.innerText==="任务协作 · 1").click()');await new Promise(resolve=>setTimeout(resolve,250));
     const historical=await window.webContents.executeJavaScript('({reports:[...document.querySelectorAll("button")].filter(button=>button.innerText.startsWith("独立验收")).length,pending:document.body.innerText.includes("等待执行确认"),overflow:document.documentElement.scrollWidth>innerWidth})');
     if(historical.reports!==1||historical.pending||historical.overflow)throw new Error(JSON.stringify({name,historical}));
     await capture(name+'-historical');
   }
   if(!draft&&!graph){
     const timelineWidth=await window.webContents.executeJavaScript('document.querySelector("[data-discussion-message]").closest(".overflow-auto").clientWidth');
     await window.webContents.executeJavaScript('[...document.querySelectorAll("header button")].find(button=>button.getAttribute("aria-label")==="成员").click()');
     const drawer=await window.webContents.executeJavaScript('(()=>{const bounds=document.querySelector("aside")?.getBoundingClientRect();return {visible:!!bounds&&bounds.left>=0&&bounds.right<=innerWidth,timelineWidth:document.querySelector("[data-discussion-message]").closest(".overflow-auto").clientWidth,overflow:document.documentElement.scrollWidth>innerWidth}})()');
     if(!drawer.visible||drawer.timelineWidth!==timelineWidth||drawer.overflow)throw new Error(JSON.stringify({name,drawer,timelineWidth}));
     await capture(name+'-members');
     await window.webContents.executeJavaScript('[...document.querySelectorAll("header button")].find(button=>button.getAttribute("aria-label")==="成员").click()');
     await window.webContents.executeJavaScript('(()=>{const field=document.querySelector("textarea");field.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(field,"@产");field.setSelectionRange(2,2);field.dispatchEvent(new Event("input",{bubbles:true}));})()');
     await new Promise(resolve=>setTimeout(resolve,100));
     const suggestions=await window.webContents.executeJavaScript('({count:document.querySelectorAll("[role=option]").length,name:document.querySelector("[role=option]")?.innerText,overflow:document.documentElement.scrollWidth>innerWidth})');
     if(suggestions.count!==1||!suggestions.name.includes("产品助手")||suggestions.overflow)throw new Error(JSON.stringify({name,suggestions}));
     await capture(name+'-mentions');
     await window.webContents.executeJavaScript('document.querySelector("[role=option]").click()');
     await new Promise(resolve=>setTimeout(resolve,100));
     if(await window.webContents.executeJavaScript('!!document.querySelector("[role=listbox]")||document.querySelector("textarea").value!==""'))throw new Error('Mention selection failed');
     await window.webContents.executeJavaScript('document.querySelector("footer button[aria-label^=移除通知对象]").click()');
     await window.webContents.executeJavaScript('const input=document.querySelector("textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(input,"保留的回复草稿");input.dispatchEvent(new Event("input",{bubbles:true}));');
     await window.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(button=>button.getAttribute("aria-label")==="回复该助手 · 产品助手").click()');
     await new Promise(resolve=>setTimeout(resolve,100));
     const reply=await window.webContents.executeJavaScript('({text:document.querySelector("textarea").value,focused:document.activeElement===document.querySelector("textarea"),selected:[...document.querySelectorAll("footer button[aria-label^=移除通知对象]")].map(button=>button.innerText).filter(text=>text.startsWith("@")),quote:[...document.querySelectorAll("footer button")].some(button=>button.innerText.startsWith("引用:")&&button.innerText.includes("界面保留一条公开时间线")),overflow:document.documentElement.scrollWidth>innerWidth})');
     if(reply.text!=="保留的回复草稿"||!reply.focused||reply.selected.length!==1||!reply.selected[0].includes("产品助手")||!reply.quote||reply.overflow)throw new Error(JSON.stringify({name,reply}));
     await capture(name+'-reply');
     await window.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(button=>button.getAttribute("aria-label")==="Agent Team").click()');
     const menu=await window.webContents.executeJavaScript('(()=>{const menu=document.querySelector("[role=menu]");const bounds=menu?.getBoundingClientRect();return {count:menu?.querySelectorAll("[role=menuitem]").length,portal:menu?.parentElement===document.body,visible:!!bounds&&bounds.left>=0&&bounds.right<=innerWidth&&bounds.top>=0&&bounds.bottom<=innerHeight,metadata:menu?.innerText.includes("团队成员: 3")&&menu?.innerText.includes("已结束")&&menu?.innerText.includes("群组讨论 · 实施风险讨论"),selected:[...document.querySelectorAll("nav button")].find(button=>button.getAttribute("aria-pressed")==="true")?.innerText}})()');
     if(menu.count!==5||!menu.portal||!menu.visible||!menu.metadata||!menu.selected?.includes("新版 Agent Team"))throw new Error(JSON.stringify({name,menu}));
     await capture(name+'-team-menu');
     await window.webContents.executeJavaScript('[...document.querySelectorAll("[role=menuitem]")].find(button=>button.title==="任务协作 · 1").click()');await new Promise(resolve=>setTimeout(resolve,200));
     const selectedHistorical=await window.webContents.executeJavaScript('({selected:[...document.querySelectorAll("nav button")].find(button=>button.getAttribute("aria-pressed")==="true")?.innerText,reports:[...document.querySelectorAll("button")].filter(button=>button.innerText.startsWith("独立验收")).length,closed:!document.querySelector("[role=menu]")})');
     if(selectedHistorical.selected!=="任务协作 · 1"||selectedHistorical.reports!==1||!selectedHistorical.closed)throw new Error(JSON.stringify({name,selectedHistorical}));
     await window.webContents.executeJavaScript('[...document.querySelectorAll("nav button")].find(button=>button.title.includes("新版 Agent Team")).click()');await new Promise(resolve=>setTimeout(resolve,100));
     await window.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(button=>button.getAttribute("aria-label")==="Agent Team").click()');
     await window.webContents.executeJavaScript('[...document.querySelectorAll("[role=menuitem]")].find(button=>button.title==="任务协作 · 1").click()');await new Promise(resolve=>setTimeout(resolve,200));
     const repeated=await window.webContents.executeJavaScript('[...document.querySelectorAll("nav button")].find(button=>button.getAttribute("aria-pressed")==="true")?.innerText');
     if(repeated!=="任务协作 · 1")throw new Error(JSON.stringify({name,repeated}));
     await window.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(button=>button.getAttribute("aria-label")==="Agent Team").click()');
     await window.webContents.executeJavaScript('[...document.querySelectorAll("[role=menuitem]")].find(button=>button.title.includes("实施风险讨论")).click()');await new Promise(resolve=>setTimeout(resolve,200));
     const namedGroup=await window.webContents.executeJavaScript('document.querySelector("h1")?.innerText');
     if(namedGroup!=="实施风险讨论")throw new Error(JSON.stringify({name,namedGroup}));
     await window.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(button=>button.getAttribute("aria-label")==="Agent Team").click()');
     await window.webContents.executeJavaScript('[...document.querySelectorAll("[role=menuitem]")].find(button=>button.title.includes("新版 Agent Team")).click()');await new Promise(resolve=>setTimeout(resolve,200));
     const restored=await window.webContents.executeJavaScript('({text:document.querySelector("textarea")?.value,selected:[...document.querySelectorAll("footer button[aria-label^=移除通知对象]")].map(button=>button.innerText).filter(text=>text.startsWith("@")),quote:[...document.querySelectorAll("footer button")].some(button=>button.innerText.startsWith("引用:")&&button.innerText.includes("界面保留一条公开时间线")),overflow:document.documentElement.scrollWidth>innerWidth})');
     if(restored.text!=="保留的回复草稿"||restored.selected.length!==1||!restored.selected[0].includes("产品助手")||!restored.quote||restored.overflow)throw new Error(JSON.stringify({name,restored}));
     await window.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(button=>button.getAttribute("aria-label")==="引用到主会话").click()');await new Promise(resolve=>setTimeout(resolve,100));
     await window.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(button=>button.getAttribute("aria-label")==="引用到主会话").click()');await new Promise(resolve=>setTimeout(resolve,100));
     await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
     const reference=await window.webContents.executeJavaScript('({cards:document.querySelectorAll("[data-source-composer] blockquote").length,title:document.querySelector("[data-source-composer] blockquote")?.textContent,label:document.querySelector("[data-source-composer]")?.textContent.includes("讨论引用"),mainText:document.querySelector("[data-source-composer] textarea")?.value,groupText:document.querySelector("footer textarea")?.value,focused:document.activeElement===document.querySelector("[data-source-composer] textarea"),dialog:!!document.querySelector("[role=dialog]"),overflow:document.documentElement.scrollWidth>innerWidth})');
     if(reference.cards!==1||reference.title!=="新版 Agent Team 交互设计讨论"||!reference.label||reference.mainText!=="原有的主会话要求"||reference.groupText!=="保留的回复草稿"||!reference.focused||reference.dialog||reference.overflow)throw new Error(JSON.stringify({name,reference}));
     await capture(name+'-discussion-reference');
     await window.webContents.executeJavaScript('[...document.querySelectorAll("button")].find(button=>button.getAttribute("aria-label")==="更多操作").click()');
     await window.webContents.executeJavaScript('[...document.querySelectorAll("[role=menuitem]")].find(button=>button.innerText==="本团队设置").click()');await new Promise(resolve=>setTimeout(resolve,100));
     const teamSettings=await window.webContents.executeJavaScript('({dialog:!!document.querySelector("[role=dialog]"),controls:document.querySelector("[role=dialog]")?.querySelectorAll("select").length,overflow:document.documentElement.scrollWidth>innerWidth})');
     if(!teamSettings.dialog||teamSettings.controls!==3||teamSettings.overflow)throw new Error(JSON.stringify({name,teamSettings}));
     await capture(name+'-settings');
     await window.webContents.executeJavaScript('[...document.querySelectorAll("[role=dialog] button")].find(button=>button.innerText==="取消").click()');
     if(await window.webContents.executeJavaScript('document.querySelector("footer textarea").value!=="保留的回复草稿"'))throw new Error('Settings lost composer draft');
     await window.webContents.executeJavaScript('document.querySelector("[data-source-composer] button").click()');
     const removed=await window.webContents.executeJavaScript('!document.querySelector("[data-source-composer] blockquote")');
     if(!removed)throw new Error('Discussion reference card could not be removed');
   }
 }
 window.setSize(900,820);await window.loadFile(path.join(__dirname,'index.html'),{query:{short:'1'}});await new Promise(resolve=>setTimeout(resolve,250));
 const messageLayout=await window.webContents.executeJavaScript('(()=>{const user=document.querySelector("[data-message-role=user]");const assistant=document.querySelector("[data-message-role=assistant]");const bubble=user.querySelector(".team-discussion-message-content");const avatar=assistant.querySelector("button");const first=assistant.querySelector(".file-preview-markdown>:first-child");return {bubbleWidth:bubble.getBoundingClientRect().width,bubbleHeight:bubble.getBoundingClientRect().height,aligned:Math.abs(first.getBoundingClientRect().top-avatar.getBoundingClientRect().top)<=8,names:[user,assistant].every(row=>row.querySelector("time").previousElementSibling.tagName==="SPAN"),overflow:document.documentElement.scrollWidth>innerWidth}})()');
 if(messageLayout.bubbleWidth>130||messageLayout.bubbleHeight>60||!messageLayout.aligned||!messageLayout.names||messageLayout.overflow)throw new Error(JSON.stringify({messageLayout}));
 await capture('compact-messages');
 for(const width of [1100,560,360]) {
   window.setSize(width,820);await window.loadFile(path.join(__dirname,'index.html'),{query:{settings:'1'}});await new Promise(resolve=>setTimeout(resolve,200));
   const settings=await window.webContents.executeJavaScript('({dialog:!!document.querySelector("[role=dialog]"),selects:document.querySelectorAll("select").length,body:document.body.innerText,overflow:document.documentElement.scrollWidth>innerWidth})');
   if(!settings.dialog||settings.selects!==7||settings.overflow||!settings.body.includes("Agent Team 设置"))throw new Error(JSON.stringify({width,settings}));
   await capture('defaults-'+width);
 }
 if(failures.length)throw new Error(failures.join('\\n'));
 console.log('Agent Team UI: desktop, narrow, header menu, exact and repeated team selection, draft preservation, five team tabs, batch isolation, discussion reference cards, directed reply, settings dialogs and Graph review checks passed.');window.destroy();app.exit(0);
}catch(error){console.error(error);app.exit(1)}});
`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [path.join(target, 'capture.cjs')], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
