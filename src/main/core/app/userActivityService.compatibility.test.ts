import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import ts from 'typescript';
import { expect, test, vi } from 'vitest';

import { UserActivityService } from './userActivityService';

test('a new client tolerates an old HTTP service and resumes reporting after its upgrade', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-rollout-'));
  const userInfoPath = path.join(directory, 'user.json');
  fs.writeFileSync(userInfoPath, JSON.stringify({ 'X-User-Account': 'alice' }));
  let status = 404;
  let responseBody = 'old service: unsupported endpoint';
  const reports: Array<{ path: string; body: string }> = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk.toString(); });
    request.on('end', () => {
      reports.push({ path: request.url ?? '', body });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(responseBody);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test HTTP listener unavailable');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const service = new UserActivityService({
    getCredential: () => ({ userAccount: 'alice', accessToken: 'synthetic-jwt', expiresAt: Number.MAX_SAFE_INTEGER }),
    baseUrl: `http://127.0.0.1:${address.port}/v1`, productName: 'Example', version: '1', userInfoPath,
    fetch: globalThis.fetch,
  });
  try {
    for (const rejectedStatus of [404, 405, 400, 500]) {
      status = rejectedStatus;
      await expect(service.sync()).resolves.toBeUndefined();
    }
    status = 200;
    responseBody = '<html>unknown endpoint fallback</html>';
    await expect(service.sync()).resolves.toBeUndefined();
    responseBody = '{"ok":true}';
    await service.sync();
    await service.sync();
    expect(reports.map(report => report.path)).toEqual(Array(7).fill('/user/activity'));
    const first = JSON.parse(reports[0].body);
    for (const report of reports.slice(0, 6)) expect(report.body).toBe(reports[0].body);
    const next = JSON.parse(reports[6].body);
    expect(next.event_type).toBe('heartbeat');
    expect(next.event_id).not.toBe(first.event_id);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  } finally {
    service.stop();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});

test('the real login callback finishes while optional activity reporting remains pending', async () => {
  const source = ts.createSourceFile('main.ts', fs.readFileSync(new URL('../../main.ts', import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest, true);
  let initializer: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'refreshAfterLogin') {
      initializer = node.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!initializer) throw new Error('Login callback unavailable');
  const javascript = ts.transpileModule(`const login = ${initializer.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const calls: string[] = [];
  const sync = vi.fn(() => new Promise<void>(() => {}));
  const dependencies = {
    updateOutboundHeaderUserInfoCache: () => { calls.push('headers'); },
    getBuiltinModelTokenExchange: () => ({ resume: () => { calls.push('credentials'); } }),
    refreshBuiltinModelCredentialFromLoginFile: async () => { calls.push('models'); },
    userActivityService: { start: () => { calls.push('activity'); }, sync },
  };
  const login = new Function(...Object.keys(dependencies), `${javascript}; return login;`)(
    ...Object.values(dependencies),
  ) as () => Promise<void>;
  let finished = false;
  void login().then(() => { finished = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(finished).toBe(true);
  expect(calls).toEqual(['headers', 'credentials', 'models', 'activity']);
  expect(sync).toHaveBeenCalledOnce();
});
