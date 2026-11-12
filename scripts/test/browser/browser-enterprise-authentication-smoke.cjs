const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash, randomInt, X509Certificate } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');

const { build } = require('esbuild');
const forge = require('node-forge');

const repository = path.resolve(__dirname, '../../..');
const fixtureApp = path.join(__dirname, 'browser-enterprise-authentication-fixture.ts');
const helper = 'electron.exe';
const helperAgent = 'EnterpriseAuthFixtureHelper/1';
const fixtureTimeoutMs = 6_000;
const successfulCases = [
  'https-302-headless',
  'https-302-sidebar',
  'script-redirect',
  'meta-redirect-headless',
];

function fixtureCertificate() {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = '01';
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + 86_400_000);
  certificate.setSubject([{ name: 'commonName', value: 'localhost' }]);
  certificate.setIssuer(certificate.subject.attributes);
  certificate.setExtensions([
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
      ],
    },
  ]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  return {
    cert: forge.pki.certificateToPem(certificate),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

async function listen(server, servers, scheme, host) {
  const connections = new Set();
  server.on('connection', socket => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = randomInt(49_152, 65_535);
    try {
      await new Promise((resolve, reject) => {
        const failed = error => reject(error);
        server.once('error', failed);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', failed);
          resolve();
        });
      });
      servers.push({ server, connections });
      return `${scheme}://${host}:${port}`;
    } catch (error) {
      if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
    }
  }
  throw new Error('Could not reserve a local test port');
}

function send(response, status, body = '', headers = {}) {
  response.writeHead(status, { 'cache-control': 'no-store', ...headers }).end(body);
}

function page(response, title, content) {
  send(
    response,
    200,
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${title}</title>` +
      '<style>body{font:17px system-ui;max-width:44rem;margin:6rem auto;padding:0 2rem;color:#182238}' +
      'h1{font-size:2.5rem;margin:0 0 1rem}p{line-height:1.6}</style>' +
      content,
    { 'content-type': 'text/html; charset=utf-8' },
  );
}

async function form(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 4_096) throw new Error('Oversized fixture request');
  }
  return new URLSearchParams(body);
}

function fakeLoginPage(response, name, localEndpoint) {
  page(
    response,
    '本地模拟登录',
    '<h1>模拟登录</h1><p id="status">正在验证本地测试凭证。</p>' +
      '<form method="post" action="/spes-login"><input type="hidden" name="scenario"><input type="hidden" name="key"></form>' +
      `<script>(async () => {
      const scenario = ${JSON.stringify(name)};
      const local = await fetch(${JSON.stringify(localEndpoint)}, {
        method: 'POST', headers: { 'x-fixture': '1' }, body: new URLSearchParams({ scenario }),
      });
      const key = new URLSearchParams(await local.text()).get('key');
      const verify = await fetch('/spes-verify', { method: 'POST', body: new URLSearchParams({ scenario, key }) });
      if ((await verify.json()).result.code !== '200') {
        document.querySelector('#status').textContent = '模拟认证未通过，页面停留在登录入口。';
        return;
      }
      const form = document.querySelector('form');
      form.elements.scenario.value = scenario;
      form.elements.key.value = key;
      form.submit();
    })().catch(() => { document.querySelector('#status').textContent = '本地模拟服务连接失败。'; });</script>`,
  );
}

async function startSites(names, tls, servers) {
  const counts = Object.fromEntries(
    names.map(name => [name, { helperPosts: 0, logins: 0, authenticatedGets: 0 }]),
  );
  let providerOrigin;
  let businessOrigin;
  const local = https.createServer(tls, async (request, response) => {
    const cors = {
      'access-control-allow-origin': providerOrigin,
      'access-control-allow-headers': 'x-fixture',
      'access-control-allow-methods': 'POST',
    };
    if (request.url !== '/getSpesInfo' || request.headers.origin !== providerOrigin)
      return send(response, 404);
    if (request.method === 'OPTIONS') return send(response, 204, '', cors);
    if (request.method !== 'POST') return send(response, 405);
    try {
      const name = (await form(request)).get('scenario');
      if (!names.includes(name)) return send(response, 400);
      const fromHelper = request.headers['user-agent']?.includes(helperAgent) === true;
      if (fromHelper) counts[name].helperPosts++;
      const accepted = fromHelper && (name !== 'helper-timeout' || counts[name].helperPosts > 1);
      const key = accepted ? 'fixture-pass' : 'fixture-rejected';
      send(response, 200, `key=${key}&content=synthetic`, {
        ...cors,
        'content-type': 'application/x-www-form-urlencoded',
      });
    } catch {
      send(response, 400);
    }
  });
  const localOrigin = await listen(local, servers, 'https', 'localhost');
  const localEndpoint = `${localOrigin}/getSpesInfo`;

  const provider = https.createServer(tls, async (request, response) => {
    const name = request.url?.replace(/^\/login\//u, '');
    if (request.method === 'GET' && names.includes(name))
      return fakeLoginPage(response, name, localEndpoint);
    if (request.method !== 'POST' || !['/spes-verify', '/spes-login'].includes(request.url))
      return send(response, 404);
    try {
      const fields = await form(request);
      const scenario = fields.get('scenario');
      if (!names.includes(scenario)) return send(response, 400);
      const verified = fields.get('key') === 'fixture-pass';
      if (request.url === '/spes-verify') {
        return send(response, 200, JSON.stringify({ result: { code: verified ? '200' : '-1' } }), {
          'content-type': 'application/json',
        });
      }
      if (!verified) return send(response, 403);
      counts[scenario].logins++;
      send(response, 303, '', { location: `${businessOrigin}/finish/${scenario}` });
    } catch {
      send(response, 400);
    }
  });
  providerOrigin = await listen(provider, servers, 'https', 'localhost');

  const business = https.createServer(tls, (request, response) => {
    const [, route, name] = request.url.split('/');
    if (!names.includes(name)) return send(response, 404);
    if (route === 'finish') {
      return send(response, 200, 'Fixture login returned to the business origin.', {
        'set-cookie': `fixture-auth=${name}; HttpOnly; Secure; SameSite=Strict; Path=/`,
      });
    }
    if (route !== 'business') return send(response, 404);
    if (
      name !== 'script-replay-still-redirects' &&
      request.headers.cookie?.split(/; */u).includes(`fixture-auth=${name}`)
    ) {
      counts[name].authenticatedGets++;
      return page(
        response,
        '本地测试业务站',
        '<h1>模拟自动登录成功</h1><p>当前业务页已收到交接的登录 Cookie，重新访问仍可保持登录。</p>',
      );
    }
    const location = `${providerOrigin}/login/${name}`;
    if (name === 'meta-redirect-headless') {
      return page(
        response,
        '本地测试业务站',
        `<meta http-equiv="refresh" content="0;url=${location}">`,
      );
    }
    if (name === 'script-redirect' || name === 'script-replay-still-redirects') {
      return page(
        response,
        '本地测试业务站',
        '<h1>正在转到模拟登录</h1>' +
          `<script>location.replace(${JSON.stringify(location)});</script>`,
      );
    }
    send(response, 302, '', { location });
  });
  businessOrigin = await listen(business, servers, 'https', '127.0.0.1');
  const upgrade = http.createServer((request, response) => {
    if (request.url !== '/business/http-upgrade') return send(response, 404);
    send(response, 301, '', { location: `${businessOrigin}/business/http-upgrade` });
  });
  const upgradeOrigin = await listen(upgrade, servers, 'http', '127.0.0.1');
  return { counts, localEndpoint, providerOrigin, businessOrigin, upgradeOrigin };
}

async function stageRuntime(scratch, sites) {
  const electron = require('electron');
  const runtime = path.join(scratch, 'runtime');
  const application = path.join(runtime, 'resources', 'app');
  fs.mkdirSync(application, { recursive: true });
  const executable = path.join(runtime, 'BrowserAuthenticationFixture.exe');
  fs.linkSync(electron, executable);
  fs.linkSync(electron, path.join(runtime, helper));
  for (const entry of fs.readdirSync(path.dirname(electron), { withFileTypes: true })) {
    if (
      entry.isFile() &&
      (/\.(?:dll|pak|dat|bin)$/iu.test(entry.name) || entry.name === 'vk_swiftshader_icd.json')
    ) {
      fs.linkSync(path.join(path.dirname(electron), entry.name), path.join(runtime, entry.name));
    }
  }
  fs.cpSync(path.join(path.dirname(electron), 'locales'), path.join(runtime, 'locales'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(application, 'package.json'),
    JSON.stringify({ name: 'browser-authentication-fixture', main: 'main.cjs' }),
  );
  const timeoutEntry = JSON.stringify(`${sites.businessOrigin}/business/helper-timeout`);
  const fixtureReplacements = new Map([
    [
      'src/main/browser/authentication/browserAuthenticationHelper.ts',
      ['https://localhost:18080/getSpesInfo', sites.localEndpoint],
    ],
    [
      'src/main/browser/authentication/browserAuthenticationProcess.ts',
      [
        'setTimeout(retire, BROWSER_AUTHENTICATION_TIMEOUT_MS)',
        `setTimeout(retire, entry.href === ${timeoutEntry} ? ${fixtureTimeoutMs} : BROWSER_AUTHENTICATION_TIMEOUT_MS)`,
      ],
    ],
    [
      'src/main/browser/browserAuthenticationNavigation.ts',
      [
        'AbortSignal.timeout(authenticationTimeoutMs)',
        `AbortSignal.timeout(entry === ${timeoutEntry} ? ${fixtureTimeoutMs} : authenticationTimeoutMs)`,
      ],
    ],
  ]);
  await build({
    stdin: {
      contents: `import ${JSON.stringify(fixtureApp)}; import './src/main/main.ts';`,
      resolveDir: repository,
    },
    outfile: path.join(application, 'main.cjs'),
    bundle: true,
    external: ['electron'],
    format: 'cjs',
    platform: 'node',
    plugins: [
      {
        name: 'local-authentication-fixture',
        setup(builder) {
          builder.onLoad(
            {
              filter:
                /(?:browserAuthentication(?:Helper|Process)?|browserAuthenticationNavigation|storageBootstrap)\.ts$/,
            },
            args => {
              if (args.path === path.join(repository, 'src/config/browserAuthentication.ts')) {
                return {
                  loader: 'ts',
                  contents: `export const BROWSER_AUTHENTICATION_CONFIG = ${JSON.stringify({
                    providerOrigin: sites.providerOrigin,
                    executableName: helper,
                  })};`,
                };
              }
              if (args.path === path.join(repository, 'src/main/storage/storageBootstrap.ts')) {
                return {
                  loader: 'ts',
                  contents: `export { runFixtureBrowser as runStorageBootstrap } from ${JSON.stringify(fixtureApp)};`,
                };
              }
              const relativePath = path.relative(repository, args.path).split(path.sep).join('/');
              const replacement = fixtureReplacements.get(relativePath);
              if (!replacement) return;
              const [original, fixtureValue] = replacement;
              const source = fs.readFileSync(args.path, 'utf8');
              assert(source.includes(original), `Fixture replacement missing in ${relativePath}`);
              return { loader: 'ts', contents: source.replace(original, fixtureValue) };
            },
          );
        },
      },
    ],
  });
  return executable;
}

function validateReport(results, scenarios, counts) {
  assert.equal(results.length, scenarios.length);
  for (const [index, result] of results.entries()) {
    const { name } = scenarios[index];
    assert.equal(result.name, name);
    if (successfulCases.includes(name)) {
      assert.equal(result.outcome, 'authenticated', name);
      assert.equal(result.reload, 'authenticated', name);
      assert.deepEqual(counts[name], { helperPosts: 1, logins: 1, authenticatedGets: 2 }, name);
    } else if (name === 'script-replay-still-redirects') {
      assert.equal(result.outcome, 'login-page', name);
      assert.deepEqual(counts[name], { helperPosts: 1, logins: 1, authenticatedGets: 0 }, name);
    } else if (name === 'helper-timeout') {
      assert.equal(result.outcome, 'login-page', name);
      assert(result.elapsedMs >= fixtureTimeoutMs, 'Expected the helper to time out');
      assert.equal(result.retry, 'authenticated', name);
      assert.equal(result.reload, 'authenticated', name);
      assert.deepEqual(counts[name], { helperPosts: 2, logins: 1, authenticatedGets: 2 }, name);
    } else {
      assert.equal(result.outcome, 'login-page', name);
      assert.deepEqual(counts[name], { helperPosts: 0, logins: 0, authenticatedGets: 0 }, name);
    }
  }
}

async function main() {
  assert.equal(process.platform, 'win32', 'This fixture runs on Windows');
  const args = process.argv.slice(2);
  assert(
    args.every(argument => ['--show', '--with-timeout'].includes(argument)),
    'Use --show and/or --with-timeout',
  );
  const show = args.includes('--show');
  const names = [
    'https-302-headless',
    'http-upgrade',
    'script-redirect',
    'meta-redirect-headless',
    'script-replay-still-redirects',
    ...(args.includes('--with-timeout') ? ['helper-timeout'] : []),
    'https-302-sidebar',
  ];
  const buildRoot = path.join(repository, 'build');
  fs.mkdirSync(buildRoot, { recursive: true });
  const workspace = fs.realpathSync(buildRoot);
  const scratch = fs.mkdtempSync(path.join(workspace, 'enterprise-authentication-fixture-'));
  const servers = [];
  try {
    const tls = fixtureCertificate();
    const publicKey = new X509Certificate(tls.cert).publicKey.export({
      type: 'spki',
      format: 'der',
    });
    const certificatePin = createHash('sha256').update(publicKey).digest('base64');
    const sites = await startSites(names, tls, servers);
    const executable = await stageRuntime(scratch, sites);
    const profile = fs.mkdtempSync(path.join(scratch, 'profile-'));
    const temp = fs.mkdtempSync(path.join(scratch, 'temp-'));
    const scenarios = names.map(name => ({
      name,
      url: `${name === 'http-upgrade' ? sites.upgradeOrigin : sites.businessOrigin}/business/${name}`,
      businessUrl: `${sites.businessOrigin}/business/${name}`,
      providerUrl: `${sites.providerOrigin}/login/${name}`,
      headless: name.endsWith('-headless'),
      show: show && name === 'https-302-sidebar',
    }));
    const env = {
      ...process.env,
      ELECTRON_FORCE_IS_PACKAGED: '1',
      BROWSER_AUTHENTICATION_FIXTURE: JSON.stringify({
        certificatePin,
        helper,
        helperAgent,
        profile,
        temp,
        scenarios,
      }),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.NODE_OPTIONS;
    console.log('Running isolated browser authentication against local HTTPS sites.');
    const child = spawn(executable, [], {
      env,
      windowsHide: !show,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    let reported = false;
    let reportError;
    const timer = setTimeout(() => child.kill(), 90_000);
    const disconnect = () => {
      if (child.connected) child.disconnect();
    };
    process.once('SIGINT', disconnect);
    child.once('message', message => {
      try {
        const report = message?.results;
        assert(Array.isArray(report), 'The fixture did not produce a result');
        validateReport(report, scenarios, sites.counts);
        console.table(report.map(result => ({ ...result, ...sites.counts[result.name] })));
        reported = true;
        if (show) {
          clearTimeout(timer);
          console.log('Close the local test window when finished.');
        }
      } catch (error) {
        reportError = error;
        disconnect();
      }
    });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    }).finally(() => {
      clearTimeout(timer);
      process.removeListener('SIGINT', disconnect);
    });
    if (reportError) throw reportError;
    assert.equal(code, 0, 'The staged Electron fixture exited before completing');
    assert(reported, 'The fixture did not produce a result');
    console.log('PASS: all local authentication scenarios matched the expected behavior.');
  } finally {
    await Promise.all(
      servers.map(
        ({ server, connections }) =>
          new Promise(resolve => {
            server.close(resolve);
            for (const socket of connections) socket.destroy();
          }),
      ),
    );
    const resolved = fs.realpathSync(scratch);
    assert.equal(path.dirname(resolved), workspace);
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 4 });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
