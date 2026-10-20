import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

test('blocks non-loopback transports and DNS before I/O while retaining local HTTP and IPC', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'app-offline-guard-'));
  const attemptLog = path.join(temporary, 'blocked.jsonl');
  try {
    const output = execFileSync(process.execPath, [
      '--require', path.resolve('scripts/test/plugin-host/block-public-network.cjs'),
      '--input-type=module', '--eval', `
        import assert from 'node:assert/strict';
        import net from 'node:net';
        import dns from 'node:dns';
        import http from 'node:http';
        import https from 'node:https';
        import dgram from 'node:dgram';
        const blocked = { code: 'NETWORK_BLOCKED' };
        assert.throws(() => net.connect({ host: '203.0.113.1', port: 80 }), blocked);
        await assert.rejects(new Promise((resolve, reject) => dns.lookup('offline.invalid', error => error ? reject(error) : resolve())), blocked);
        await assert.rejects(dns.promises.lookup('offline.invalid'), blocked);
        await assert.rejects(new Promise((resolve, reject) => new dns.Resolver().resolve4('offline.invalid', error => error ? reject(error) : resolve())), blocked);
        await assert.rejects(new dns.promises.Resolver().resolve4('offline.invalid'), blocked);
        assert.throws(() => http.get('http://offline.invalid/'), blocked);
        assert.throws(() => https.request('https://offline.invalid/'), blocked);
        await assert.rejects(fetch('https://offline.invalid/'), blocked);
        const udp = dgram.createSocket('udp4');
        assert.throws(() => udp.send(Buffer.from('fixture'), 53, '203.0.113.1'), blocked);
        assert.throws(() => udp.connect(53, '203.0.113.1'), blocked);
        udp.close();
        const server = http.createServer((_request, response) => response.end('local'));
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const url = 'http://127.0.0.1:' + server.address().port;
        assert.equal(await (await fetch(url)).text(), 'local');
        await new Promise((resolve, reject) => http.get(url, response => { response.resume(); response.once('end', resolve); }).once('error', reject));
        const stopped = new Promise(resolve => server.close(resolve));
        server.closeAllConnections(); await stopped;
        const ipc = net.createServer(socket => socket.end('local-ipc'));
        const address = process.platform === 'win32' ? '\\\\\\\\.\\\\pipe\\\\app-offline-fixture-' + process.pid : ${JSON.stringify(path.join(temporary, 'fixture.sock'))};
        await new Promise(resolve => ipc.listen(address, resolve));
        await new Promise((resolve, reject) => { const socket = net.connect(address); socket.resume(); socket.once('end', resolve); socket.once('error', reject); });
        await new Promise(resolve => ipc.close(resolve));
        console.log(JSON.stringify({ nonLoopbackBlocked: true, loopbackHttpAllowed: true, localIpcAllowed: true }));
      `,
    ], {
      env: { ...process.env, APP_PLUGIN_OFFLINE_ATTEMPT_LOG: attemptLog },
      encoding: 'utf8', windowsHide: true, timeout: 10_000,
    });
    expect(JSON.parse(output.trim())).toEqual({
      nonLoopbackBlocked: true, loopbackHttpAllowed: true, localIpcAllowed: true,
    });
    const attempts = fs.readFileSync(attemptLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(attempts).toHaveLength(10);
    expect(attempts.every(item => ['203.0.113.1', 'offline.invalid'].includes(item.host))).toBe(true);
  } finally {
    expect(path.dirname(temporary)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(temporary)).toMatch(/^app-offline-guard-/u);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
