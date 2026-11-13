const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const { X509Certificate } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { promisify } = require('node:util');

const { createPackage } = require('@electron/asar');
const forge = require('node-forge');

const { build } = require('esbuild');

const run = promisify(execFile);
const { productName } = require('../../../package.json');
const body = 'challenge=fixture';

const fixture = String.raw`
const { app, BrowserWindow, session } = require('electron');
const { X509Certificate } = require('node:crypto');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const {
  prepareBrowserAuthenticationTransport,
  stopBrowserAuthenticationTransport,
} = require('../../../src/main/browser/authentication/browserAuthenticationTransport');
const { configureBrowserSessionUi } = require('../../../src/main/browser/browserSessionPolicy');
const { applyBrowserProxyPreference } = require('../../../src/main/core/network/systemProxyPreference');
const { profile, fingerprint, aliasName, businessPort, loginPort, localEndpoint } =
  JSON.parse(process.env.AUTH_TRANSPORT_FIXTURE);

app.setPath('userData', profile);
app.setPath('sessionData', profile);
const launch = async () => {
  await prepareBrowserAuthenticationTransport();
  const current = app.commandLine.getSwitchValue('host-resolver-rules');
  assert.equal(Boolean(current), Boolean(aliasName));
  assert.equal(app.isReady(), false);
  app.commandLine.removeSwitch('host-resolver-rules');
  app.commandLine.appendSwitch('host-resolver-rules',
    [current, 'MAP provider.example 127.0.0.1', 'MAP business.example 127.0.0.1'].filter(Boolean).join(', '));
  await app.whenReady();
  await applyBrowserProxyPreference({ browserProxy: { mode: 'direct' } });

  const configureSession = async browserSession => {
    browserSession.setCertificateVerifyProc((request, callback) => {
      const cert = new X509Certificate(request.certificate.data);
      callback(cert.fingerprint256 === fingerprint ? 0 : -3);
    });
    await browserSession.setProxy({ mode: 'direct' });
  };
  const provider = 'https://provider.example:' + loginPort;
  const business = 'http://business.example:' + businessPort;
  const request = 'fetch(' + JSON.stringify(localEndpoint) +
    ',{method:"POST",headers:{"Content-Type":"application/json"},body:"challenge=fixture"}).then(r=>r.text())';
  const partition = session.fromPartition('persist:auth-transport-smoke');
  await configureSession(partition);
  const window = new BrowserWindow({ show: false, webPreferences: { session: partition, sandbox: true } });
  configureBrowserSessionUi(partition, Symbol(), { ownsGuest: guest => guest === window.webContents });
  await window.loadURL(business + '/redirect');
  assert.equal(new URL(window.webContents.getURL()).origin, provider);
  assert.equal(await window.webContents.executeJavaScript(request), 'fixture-ok');

  await window.loadURL(business + '/overlay');
  const frame = window.webContents.mainFrame.frames.find(candidate => candidate.origin === provider);
  assert.ok(frame);
  assert.equal(await frame.executeJavaScript(request), 'fixture-ok');
  assert.equal(new URL(window.webContents.getURL()).origin, business);
  const echo = await frame.executeJavaScript('document.cookie');
  assert.equal(echo, 'existing=fixture');

  if (aliasName) {
    const unowned = new BrowserWindow({ show: false });
    await configureSession(unowned.webContents.session);
    await unowned.loadURL(provider);
    await assert.rejects(unowned.webContents.executeJavaScript(request));
    unowned.destroy();
    const port = Number(current.split(':').at(-1));
    const directRelay = 'fetch(' + JSON.stringify('https://localhost:' + port + '/getSpesInfo') + ')';
    await assert.rejects(frame.executeJavaScript(directRelay));
    const untrusted = net.connect(port, '127.0.0.1');
    await once(untrusted, 'connect');
    untrusted.on('error', () => {});
    await new Promise(resolve => untrusted.once('close', resolve));
  }
  window.destroy();
  await stopBrowserAuthenticationTransport();
  app.quit();
};
launch().catch(error => {
  console.error(error);
  app.exit(1);
});
`;
function createCertificate() {
  const { publicKey, privateKey } = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = publicKey;
  certificate.serialNumber = '01';
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + 3_600_000);
  const subject = [{ name: 'commonName', value: 'localhost' }];
  certificate.setSubject(subject);
  certificate.setIssuer(subject);
  certificate.setExtensions([{
    name: 'subjectAltName',
    altNames: ['localhost', 'provider.example', 'business.example'].map(value => ({ type: 2, value })),
  }]);
  certificate.sign(privateKey, forge.md.sha256.create());
  const cert = forge.pki.certificateToPem(certificate);
  return {
    cert,
    key: forge.pki.privateKeyToPem(privateKey),
    fingerprint: new X509Certificate(cert).fingerprint256,
  };
}

async function getOwner(socket) {
  const { localPort, remotePort } = socket;
  const command =
    `$c = Get-NetTCPConnection -LocalPort ${remotePort} -RemotePort ${localPort} -State Established` +
    ' | Select-Object -First 1\n' +
    'if (!$c) { throw "Fixture TCP connection is unavailable" }\n' +
    '(Get-Process -Id $c.OwningProcess).Path';
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    timeout: 10_000,
    windowsHide: true,
  });
  return path.basename(stdout.trim()).toLowerCase();
}

async function listen(tls, onRequest, port = 0) {
  const server = tls ? https.createServer(tls) : http.createServer();
  server.on('request', (request, response) => {
    void onRequest(request, response).catch(error => {
      console.error(error.message);
      response.writeHead(500).end();
    });
  });
  server.listen(port, '::');
  await once(server, 'listening');
  return server;
}

async function stage(root, sourceExecutable) {
  const source = path.dirname(sourceExecutable);
  const runtime = path.join(root, 'runtime');
  await fs.mkdir(path.join(runtime, 'resources', 'browser-transport'), { recursive: true });
  await fs.cp(path.join(source, 'locales'), path.join(runtime, 'locales'), { recursive: true });
  for (const file of await fs.readdir(source, { withFileTypes: true })) {
    if (file.isFile() && /\.(?:dll|pak|dat|bin|json)$/iu.test(file.name))
      await fs.copyFile(path.join(source, file.name), path.join(runtime, file.name));
  }
  const executablePath = path.join(runtime, `${productName}.exe`);
  await fs.copyFile(sourceExecutable, executablePath);
  for (const aliasName of ['electron.exe', 'chrome.exe']) {
    if (path.basename(executablePath).toLowerCase() !== aliasName)
      await fs.link(executablePath, path.join(runtime, aliasName));
  }
  await fs.copyFile(
    path.resolve(__dirname, '../../../src/main/browser/authentication/browserTransportRelay.cjs'),
    path.join(runtime, 'resources', 'browser-transport', 'relay.cjs'),
  );
  return executablePath;
}

async function runFixture(root, executablePath, settings) {
  const aliasName = settings.aliasName ?? '';
  const fixturePath = path.join(root, aliasName || 'baseline');
  await fs.mkdir(fixturePath);
  await build({
    stdin: { contents: fixture, loader: 'js', resolveDir: __dirname },
    bundle: true, platform: 'node', external: ['electron'],
    outfile: path.join(fixturePath, 'main.cjs'),
    plugins: [{
      name: 'fixture-config',
      setup(plugin) {
        plugin.onLoad({ filter: /[\\/]src[\\/]config[\\/]browserAuthentication\.ts$/ }, () => ({
          contents: 'export const BROWSER_AUTHENTICATION_CONFIG = ' + JSON.stringify({
            executableName: aliasName,
            localEndpoint: settings.localEndpoint,
          }),
          loader: 'ts',
        }));
      },
    }],
  });
  await fs.writeFile(path.join(fixturePath, 'package.json'), '{"name":"auth-transport-fixture","main":"main.cjs"}');
  await createPackage(fixturePath, path.join(path.dirname(executablePath), 'resources', 'app.asar'));
  const profile = path.join(root, (aliasName || 'baseline') + '-profile');
  await fs.mkdir(profile);
  const child = spawn(executablePath, [], {
    env: { ...process.env, AUTH_TRANSPORT_FIXTURE: JSON.stringify({ profile, ...settings }) },
    stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
  });
  const timeout = setTimeout(() => child.kill(), 45_000);
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 0);
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  assert.equal(process.platform, 'win32');
  const buildRoot = path.join(__dirname, '../../../build');
  await fs.mkdir(buildRoot, { recursive: true });
  const root = await fs.mkdtemp(path.join(buildRoot, 'auth-transport-smoke-'));
  const servers = [];
  try {
    const executablePath = await stage(root, path.resolve(process.argv[2] ?? require('electron')));
    const tls = createCertificate();
    const siteOwners = [];
    const authRequests = [];
    const login = await listen(tls, async (request, response) => {
      siteOwners.push(await getOwner(request.socket));
      response.writeHead(200, {
        'content-type': 'text/html',
        'set-cookie': 'existing=fixture; Secure; SameSite=None; Path=/',
      }).end('<title>Local fixture</title>');
    });
    servers.push(login);
    const loginPort = login.address().port;
    const origin = `https://provider.example:${loginPort}`;
    const business = await listen(null, async (request, response) => {
      siteOwners.push(await getOwner(request.socket));
      if (request.url === '/redirect') {
        response.writeHead(302, { location: origin }).end();
      } else {
        response.writeHead(200, { 'content-type': 'text/html' })
          .end(`<iframe src="${origin}"></iframe>`);
      }
    });
    servers.push(business);
    const respondToAuthentication = async (request, response) => {
      const headers = {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'POST',
        'access-control-allow-headers': 'content-type',
      };
      let payload = '';
      for await (const part of request) payload += part;
      authRequests.push({
        owner: await getOwner(request.socket),
        url: request.url, method: request.method, host: request.headers.host,
        origin: request.headers.origin, sni: request.socket.servername, payload,
      });
      if (request.method === 'OPTIONS') return response.writeHead(204, headers).end();
      response.writeHead(200, headers).end('fixture-ok');
    };
    const destination = await listen(tls, respondToAuthentication, 18080);
    servers.push(destination);
    const customDestination = await listen(tls, respondToAuthentication);
    servers.push(customDestination);

    const branded = path.basename(executablePath).toLowerCase();
    for (const aliasName of [null, 'electron.exe', 'chrome.exe']) {
      const localEndpoint = aliasName === 'chrome.exe'
        ? new URL(`https://localhost:${customDestination.address().port}/auth/info`)
        : new URL('https://localhost:18080/getSpesInfo');
      authRequests.length = 0;
      siteOwners.length = 0;
      await runFixture(root, executablePath, {
        loginPort, businessPort: business.address().port, fingerprint: tls.fingerprint,
        aliasName, localEndpoint: localEndpoint.href,
      });
      assert.ok(siteOwners.length >= 4);
      assert.ok(siteOwners.every(owner => owner === branded));
      assert.deepEqual(authRequests.map(request => request.method), ['OPTIONS', 'POST', 'OPTIONS', 'POST']);
      for (const request of authRequests) {
        assert.deepEqual(request, {
          owner: aliasName ?? branded, url: localEndpoint.pathname, method: request.method,
          host: localEndpoint.host, origin, sni: 'localhost',
          payload: request.method === 'POST' ? body : '',
        });
      }
      console.log(`${aliasName ?? 'Baseline'}: native redirects, iframe, TLS POST and socket ownership verified.`);
    }
  } finally {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
  }
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
