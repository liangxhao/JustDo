const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');

async function main() {
  const build = path.resolve(__dirname, '../../../build');
  fs.mkdirSync(build, { recursive: true });
  const workspace = fs.realpathSync(build);
  const root = fs.mkdtempSync(path.join(workspace, 'auth-redirect-native-'));
  let before = 0;
  let after = 0;
  let login = '';
  const business = createServer((request, response) => {
    if (request.headers.cookie?.includes('session=handoff')) {
      after++;
      response.writeHead(200).end('authenticated');
    } else {
      before++;
      response.writeHead(302, { location: login }).end();
    }
  });
  try {
    await new Promise(resolve => business.listen(0, '127.0.0.1', resolve));
    const target = 'http://127.0.0.1:' + business.address().port + '/protected';
    login = 'http://localhost:' + business.address().port + '/login';
    const module = [
      "const {app, BrowserWindow, session}=require('electron');",
      "for(const key of ['appData','userData','sessionData'])app.setPath(key,__dirname);",
      'app.whenReady().then(async()=>{',
      "const ses=session.fromPartition('handoff');let firstId, redirectId, relayed=false;",
      'ses.webRequest.onBeforeRedirect(details=>{if(details.redirectURL===process.env.TEST_LOGIN)redirectId=details.id;});',
      'ses.webRequest.onBeforeRequest((details,reply)=>{',
      'if(details.url===process.env.TEST_TARGET&&!firstId)firstId=details.id;',
      'if(details.url!==process.env.TEST_LOGIN){reply({});return;}',
      'if(relayed||redirectId!==details.id||firstId!==details.id){reply({cancel:true});return;}',
      'relayed=true;',
      "ses.cookies.set({url:process.env.TEST_TARGET,name:'session',value:'handoff',sameSite:'strict',httpOnly:true}).then(()=>reply({redirectURL:process.env.TEST_TARGET}),()=>reply({cancel:true}));",
      '});const window=new BrowserWindow({show:false,webPreferences:{session:ses,sandbox:true}});',
      'try{await window.loadURL(process.env.TEST_TARGET);app.exit(relayed?0:1)}catch{app.exit(1)}',
      '}).catch(()=>app.exit(1));',
    ].join('\n');
    fs.writeFileSync(path.join(root, 'package.json'), '{"main":"main.cjs"}');
    fs.writeFileSync(path.join(root, 'main.cjs'), module);
    const env = { ...process.env, TEST_TARGET: target, TEST_LOGIN: login };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require('electron'), [root], {
      env,
      windowsHide: true,
      stdio: 'ignore',
    });
    const timeout = setTimeout(() => child.kill(), 16000);
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    }).finally(() => clearTimeout(timeout));
    assert.deepEqual({ code, before, after }, { code: 0, before: 1, after: 1 });
    console.log(
      'PASS: an intercepted real redirect retained the navigation and sent the imported Strict cookie.',
    );
  } finally {
    await new Promise(resolve => business.close(resolve));
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), workspace);
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3 });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
