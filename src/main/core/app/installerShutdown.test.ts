import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { afterEach, expect, test, vi } from 'vitest';

import { INSTALLER_QUIT_SWITCH } from '../appConstants';
import { createInstallerShutdownListener, installerShutdownPipe } from './installerShutdown';

const listeners: ReturnType<typeof createInstallerShutdownListener>[] = [];
let sequence = 0;
const fixture = async () => {
  const onQuit = vi.fn();
  const pipe = installerShutdownPipe(process.pid) + `-test-${sequence++}`;
  const listener = createInstallerShutdownListener(onQuit, pipe);
  listeners.push(listener);
  await listener.ready;
  return { onQuit, pipe, listener };
};

afterEach(() => {
  for (const listener of listeners.splice(0)) listener.stop();
});

test('a compatibility quit invocation hands off to an incumbent or exits without starting application services', () => {
  const main = readFileSync(path.resolve(__dirname, '../../application.ts'), 'utf8');
  const dispatch = main.slice(main.indexOf('const gotTheLock = agentBridgeArgv'),
    main.indexOf('  const releaseRuntimeDevLease =')) + 'normalStart(); }';
  for (const lock of [false, true]) {
    const app = { requestSingleInstanceLock: () => lock, quit: vi.fn(), exit: vi.fn() };
    const normalStart = vi.fn();
    runInNewContext(dispatch, { app, normalStart, agentBridgeArgv: null, isDev: false,
      process: { argv: ['app.exe', INSTALLER_QUIT_SWITCH] }, INSTALLER_QUIT_SWITCH });
    expect(normalStart).not.toHaveBeenCalled();
    if (lock) expect(app.exit).toHaveBeenCalledExactlyOnceWith(0);
    else expect(app.quit).toHaveBeenCalledOnce();
  }
  const normalStart = vi.fn();
  runInNewContext(dispatch, { app: { requestSingleInstanceLock: () => true }, normalStart,
    agentBridgeArgv: null, process: { argv: ['app.exe'] }, INSTALLER_QUIT_SWITCH });
  expect(normalStart).toHaveBeenCalledOnce();
});

test.runIf(process.platform === 'win32')('accepts a fragmented quit request once and acknowledges retries during cleanup', async () => {
  const { onQuit, pipe } = await fixture();
  const client = createConnection(pipe);
  const closed = once(client, 'close');
  let response = '';
  client.on('data', data => { response += data.toString(); });
  await once(client, 'connect');
  client.write('quit-for-');
  await new Promise(resolve => setImmediate(resolve));
  expect(onQuit).not.toHaveBeenCalled();
  client.write('update\n');
  await closed;
  expect(response).toBe('accepted\n');
  expect(onQuit).toHaveBeenCalledOnce();
  const retry = createConnection(pipe);
  const retried = once(retry, 'close');
  let retryResponse = '';
  retry.on('data', data => { retryResponse += data.toString(); });
  retry.end('quit-for-update\n');
  await retried;
  expect(retryResponse).toBe('accepted\n');
  expect(onQuit).toHaveBeenCalledOnce();
});

test.runIf(process.platform === 'win32')('acknowledges an application already quitting without restarting cleanup', async () => {
  const { onQuit, pipe, listener } = await fixture();
  listener.markQuitting();
  const client = createConnection(pipe);
  const closed = once(client, 'close');
  let response = '';
  client.on('data', data => { response += data.toString(); });
  client.end('quit-for-update\n');
  await closed;
  expect(response).toBe('accepted\n');
  expect(onQuit).not.toHaveBeenCalled();
});

test.runIf(process.platform === 'win32')('rejects malformed and oversized requests without quitting', async () => {
  const { onQuit, pipe } = await fixture();
  for (const request of ['quit\n', 'quit-for-update\nextra', '\u00f1uit-for-update\n']) {
    const client = createConnection(pipe);
    const closed = once(client, 'close');
    client.on('error', () => undefined);
    await once(client, 'connect');
    client.write(request);
    await closed;
  }
  expect(onQuit).not.toHaveBeenCalled();
});

test.runIf(process.platform === 'win32')('bounds incomplete requests and retires open sockets during shutdown', async () => {
  const { onQuit, pipe, listener } = await fixture();
  const incomplete = createConnection(pipe);
  const expired = once(incomplete, 'close');
  await once(incomplete, 'connect');
  incomplete.write('quit');
  await expired;
  const pending = createConnection(pipe);
  const closed = once(pending, 'close');
  await once(pending, 'connect');
  listener.stop();
  await closed;
  expect(onQuit).not.toHaveBeenCalled();
});
