// Real built packages, trust receipt store, discovery, Main registry and Electron SQLite.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { buildAppPlugin } from '../../plugins/build-app-plugins.mjs';

const require = createRequire(import.meta.url);
const useNode = process.argv.includes('--node');
const temporary = await mkdtemp(path.join(tmpdir(), 'app-retained-recovery-'));
let child;
try {
  const source = path.join(temporary, 'source');
  await mkdir(source);
  await writeFile(
    path.join(source, 'package.json'),
    JSON.stringify({
      name: 'recovery-fixture',
      version: '1.0.0',
      type: 'module',
      openclaw: { extensions: ['./index.js'] },
      app: { main: './main.js', browser: './browser.js' },
    }),
  );
  await writeFile(
    path.join(source, 'openclaw.plugin.json'),
    JSON.stringify({ id: 'recovery-fixture', configSchema: { type: 'object', properties: {} } }),
  );
  await writeFile(
    path.join(source, 'app.plugin.json'),
    JSON.stringify({
      manifestVersion: 1,
      apiVersion: 1,
      id: 'recovery-fixture',
      nativePluginId: 'recovery-fixture',
      version: '1.0.0',
      entries: { main: 'main.mjs', browser: 'browser.mjs' },
      capabilities: [],
      commands: [],
      slots: [],
    }),
  );
  await writeFile(
    path.join(source, 'index.js'),
    "export default {id:'recovery-fixture',register(){}};\n",
  );
  await writeFile(path.join(source, 'browser.js'), 'export function register(){}\n');
  const oldSource = label => `
const audit=globalThis[Symbol.for('app-retained-recovery.fixture')];audit.imports.push(${JSON.stringify(label)});
export function register(host){audit.registrations.push(${JSON.stringify(label)});let off;return{commands:[],
schemas:[{id:'old.schema',initialize(){audit.schemas++;throw new Error('Old schema must not run');}}],
resources:{protectedResources(){audit.inventory++;throw new Error('Old inventory must not run');},expandResources:ids=>[...ids],acquireDeletion(){audit.leases++;return()=>audit.releases++;},isDeleting:()=>false,isManaged:()=>false,
prepareDelete:async()=>{host.getDatabase().prepare('UPDATE old_metadata SET cleanup_done=1 WHERE resource_id=?').run('source');audit.cleanup++;},deleteManaged:async()=>false},
activate(){if(audit.failActivation)throw new Error('Old activation failed');off=host.onExecutionReceipt(()=>audit.receipts++);},dispose(){off?.();},beforePackageMutation:async()=>{}};}
`;
  await writeFile(path.join(source, 'main.js'), oldSource('referenced'));
  const referenced = await buildAppPlugin(source, path.join(temporary, 'old'));
  await writeFile(path.join(source, 'main.js'), oldSource('unreferenced'));
  const unreferenced = await buildAppPlugin(source, path.join(temporary, 'unused'));
  await writeFile(
    path.join(source, 'main.js'),
    `const gate=globalThis[Symbol.for('app-retained-recovery.fixture')];gate.delayedImportStarted=true;await gate.activationGate;\n` +
      oldSource('delayed'),
  );
  const delayed = await buildAppPlugin(source, path.join(temporary, 'delayed'));
  await writeFile(
    path.join(source, 'main.js'),
    `export function register(){return{commands:[],resources:{protectedResources:()=>[],adoptResources:()=>false,expandResources:ids=>[...ids],acquireDeletion:()=>()=>{},isDeleting:()=>false,isManaged:()=>false,prepareDelete:async()=>{},deleteManaged:async()=>false},beforePackageMutation:async()=>{}};}`,
  );
  const current = await buildAppPlugin(source, path.join(temporary, 'current'));
  const bundled = path.join(temporary, 'bundled');
  await mkdir(bundled);
  await writeFile(path.join(bundled, 'catalog.json'), '[]');
  const hostModule = path.join(temporary, 'host.cjs');
  await build({
    stdin: {
      resolveDir: process.cwd(),
      loader: 'ts',
      contents: `
export {AppPluginManager,discoverAppCandidates} from './src/main/plugins/app/manager';
export {AppApprovalStore} from './src/main/plugins/app/approvalStore';
export {inspectAppArtifact,retainAppArtifact} from './src/main/plugins/app/artifact';
`,
    },
    outfile: hostModule,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  const runner = path.join(temporary, 'recovery.cjs');
  await writeFile(
    runner,
    `
const assert=require('node:assert/strict');const{AppPluginManager,discoverAppCandidates,AppApprovalStore,inspectAppArtifact,retainAppArtifact}=require(${JSON.stringify(hostModule)});
const Database=require(${JSON.stringify(require.resolve('better-sqlite3'))});const database=new Database(':memory:');
const audit={imports:[],registrations:[],schemas:0,inventory:0,leases:0,releases:0,cleanup:0,receipts:0};globalThis[Symbol.for('app-retained-recovery.fixture')]=audit;
const referenced=${JSON.stringify(referenced)},unreferenced=${JSON.stringify(unreferenced)},delayed=${JSON.stringify(delayed)},current=${JSON.stringify(current)};
const retention=${JSON.stringify(path.join(temporary, 'retained'))};const trust=new AppApprovalStore(${JSON.stringify(path.join(temporary, 'approvals.json'))});let runtimeReady=false;const subscriptions=new Set();let manager;
(async()=>{try{
for(const artifact of[referenced,unreferenced,delayed,current]){await retainAppArtifact(await inspectAppArtifact(artifact.root),retention);await trust.approve(artifact.id,artifact.hash);}
const candidates=await discoverAppCandidates(${JSON.stringify(bundled)},null,[{id:current.id,installPath:current.packageRoot}],await trust.read(),retention,await trust.history());
const dependencies={retentionRoot:retention,candidates:async()=>candidates,readDesiredEnabled:()=>false,isGatewayConnected:()=>false,broadcast(){},withStoppedGateway:async operation=>operation(),resources:{getDatabase:()=>database,getNativeStateDirectory:()=>${JSON.stringify(path.join(temporary, 'state'))},onNativeEvent:listener=>{if(!runtimeReady)throw new Error('Runtime not created');subscriptions.add(listener);return()=>subscriptions.delete(listener);}}};
manager=new AppPluginManager(dependencies);
await manager.prepare();const checks={historyNotImportedDuringPrepare:audit.imports.length===0};
database.exec('CREATE TABLE app_plugin_resources(owner_id TEXT NOT NULL,artifact_hash TEXT NOT NULL,resource_id TEXT NOT NULL,PRIMARY KEY(owner_id,resource_id));CREATE TABLE old_metadata(resource_id TEXT PRIMARY KEY,cleanup_done INTEGER NOT NULL)');
database.prepare('INSERT INTO app_plugin_resources VALUES(?,?,?)').run(current.id,referenced.hash,'source');database.prepare('INSERT INTO old_metadata VALUES(?,0)').run('source');
manager.initializeDatabase(database);let blocked=false;try{manager.sessions.acquireDeletion(['source'])();}catch{blocked=true;}checks.referencedOwnerFencedBeforeRecovery=blocked;
runtimeReady=true;await manager.activate();
checks.onlyReferencedTrustedVersionLoaded=JSON.stringify(audit.imports)==='["referenced"]'&&JSON.stringify(audit.registrations)==='["referenced"]';
checks.oldSchemasAndInventoryNotRun=audit.schemas===0&&audit.inventory===0;
for(const listener of subscriptions)listener({event:'agent',payload:{stream:'lifecycle',sessionKey:'key',runId:'run',data:{phase:'end',executionSettled:true}}});
checks.cleanupReceiptActiveAfterRuntimeReady=audit.receipts===1;
const release=manager.sessions.acquireDeletion(['source']);await manager.sessions.prepareDelete(['source']);release();
checks.oldMetadataCleanupRemainsUsable=audit.cleanup===1&&audit.leases===1&&audit.releases===1&&database.prepare('SELECT cleanup_done FROM old_metadata').get().cleanup_done===1;
checks.oldVersionNeverPublishesBusinessUi=manager.snapshot().length===1&&manager.snapshot()[0].state==='cleanup';
manager.dispose();checks.oldReceiptSubscriptionDisposed=subscriptions.size===0;
audit.failActivation=true;manager=new AppPluginManager(dependencies);await manager.prepare();manager.initializeDatabase(database);await manager.activate();
blocked=false;try{manager.sessions.acquireDeletion(['source'])();}catch{blocked=true;}checks.failedCleanupActivationKeepsResourceFence=blocked;
let packageEffects=0;blocked=false;try{await manager.mutatePackage(async()=>{packageEffects++;});}catch{blocked=true;}
checks.failedReferencedCleanupOwnerVetoesPackageMutation=blocked&&packageEffects===0;
manager.dispose();audit.failActivation=false;
database.prepare('UPDATE app_plugin_resources SET artifact_hash=? WHERE resource_id=?').run(delayed.hash,'source');
let releaseActivation;audit.activationGate=new Promise(resolve=>{releaseActivation=resolve;});
manager=new AppPluginManager(dependencies);await manager.prepare();manager.initializeDatabase(database);const pendingActivation=manager.activate();
for(let attempt=0;!audit.delayedImportStarted&&attempt<100;attempt++)await new Promise(resolve=>setTimeout(resolve,1));
assert.equal(audit.delayedImportStarted,true,'Probe must overlap an actual retained Main import');
manager.dispose();releaseActivation();await pendingActivation;
checks.disposeDuringRetainedImportCannotReviveSubscriptions=subscriptions.size===0;
console.log(JSON.stringify({actualBuiltPackages:true,realTrustReceipts:true,realElectronSqlite:Boolean(process.versions.electron),checks}));assert.ok(Object.values(checks).every(Boolean));
}finally{manager?.dispose();database.close();}})().catch(error=>{console.error(error.stack);process.exitCode=1;});
`,
  );
  child = spawn(useNode ? process.execPath : require('electron'), [runner], {
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', bytes => {
    output += bytes;
  });
  child.stderr.on('data', bytes => {
    output += bytes;
  });
  const timeout = setTimeout(() => child.kill(), 30000);
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  clearTimeout(timeout);
  assert.equal(code, 0, output);
  process.stdout.write(output);
} finally {
  child?.kill();
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(tmpdir()));
  assert.ok(path.basename(temporary).startsWith('app-retained-recovery-'));
  await rm(temporary, { recursive: true, force: true });
}
