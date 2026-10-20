import { EventEmitter } from 'node:events';
import os from 'node:os';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { startAssets } from '../editor-resource.mjs';

const httpMock = vi.hoisted(() => ({ createServer: vi.fn() }));
vi.mock('node:http', () => ({ createServer: httpMock.createServer }));

type Allocation = number | string | null | Error;

// Chromium net/base/port_util.cc plus the WHATWG-only ports 4190 and 6679.
// Keep this fixture independent of the allocator so omissions fail behaviorally.
const blockedPorts = [
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
];

const fixture = {
  allocations: [] as Allocation[],
  servers: [] as AssetServer[],
  listens: 0,
  closes: 0,
  deferClose: false,
};

class AssetServer extends EventEmitter {
  listening = false;
  allocated: Allocation = null;
  finishClose: (() => void) | undefined;
  closeAllConnections = vi.fn();

  listen(port: number, host: string, callback?: () => void) {
    expect(port).toBe(0);
    expect(host).toBe('127.0.0.1');
    expect(this.listening).toBe(false);
    fixture.listens++;
    this.allocated = fixture.allocations.length
      ? fixture.allocations.shift()!
      : new Error('Unexpected extra allocation');
    if (callback) this.once('listening', callback);
    queueMicrotask(() => {
      if (this.allocated instanceof Error) this.emit('error', this.allocated);
      else {
        this.listening = true;
        this.emit('listening');
      }
    });
    return this;
  }

  address() {
    return typeof this.allocated === 'number'
      ? { address: '127.0.0.1', family: 'IPv4', port: this.allocated }
      : this.allocated;
  }

  close(callback?: () => void) {
    fixture.closes++;
    if (callback) this.once('close', callback);
    const finish = () => {
      this.listening = false;
      this.finishClose = undefined;
      this.emit('close');
    };
    this.finishClose = finish;
    if (!fixture.deferClose) queueMicrotask(finish);
    return this;
  }
}

beforeEach(() => {
  fixture.allocations = [];
  fixture.servers = [];
  fixture.listens = 0;
  fixture.closes = 0;
  fixture.deferClose = false;
  httpMock.createServer.mockReset().mockImplementation(() => {
    const server = new AssetServer();
    fixture.servers.push(server);
    return server;
  });
});

describe('draw.io browser-safe asset ports', () => {
  it('discards an allocated X11 port before advertising the resource origin', async () => {
    fixture.allocations = [6000, 43127];

    const assets = await startAssets(os.tmpdir());

    expect(assets.origin).toBe('http://127.0.0.1:43127');
    expect(assets.base).toMatch(/^http:\/\/127\.0\.0\.1:43127\/[0-9a-f]{48}\/$/);
    expect(fixture.listens).toBe(2);
    expect(fixture.closes).toBe(1);
    expect(fixture.servers.filter(server => server.listening)).toEqual([assets.http]);
    expect(assets.http.listenerCount('error')).toBe(0);
  });

  it.each(blockedPorts)('never exposes browser-restricted port %i', async port => {
    fixture.allocations = [port, 49152];

    const assets = await startAssets(os.tmpdir());

    expect(assets.origin).toBe('http://127.0.0.1:49152');
    expect(fixture.listens).toBe(2);
    expect(fixture.closes).toBe(1);
    expect(fixture.servers.filter(server => server.listening)).toEqual([assets.http]);
  });

  it('waits until a rejected listener closes before requesting another ephemeral port', async () => {
    fixture.allocations = [6000, 43127];
    fixture.deferClose = true;
    let published = false;
    const pending = startAssets(os.tmpdir()).then(assets => {
      published = true;
      return assets;
    });
    await vi.waitFor(() => expect(fixture.closes).toBe(1));

    expect(fixture.listens).toBe(1);
    expect(published).toBe(false);
    fixture.deferClose = false;
    fixture.servers[0].finishClose!();
    const assets = await pending;

    expect(assets.origin).toBe('http://127.0.0.1:43127');
    expect(fixture.listens).toBe(2);
    expect(fixture.servers.filter(server => server.listening)).toEqual([assets.http]);
  });

  it('fails with every rejected listener closed when bounded allocation attempts are exhausted', async () => {
    fixture.allocations = Array<Allocation>(128).fill(6000);

    await expect(startAssets(os.tmpdir())).rejects.toThrow();

    expect(fixture.listens).toBeGreaterThan(1);
    expect(fixture.listens).toBeLessThanOrEqual(64);
    expect(fixture.closes).toBe(fixture.listens);
    expect(fixture.servers.every(server => !server.listening)).toBe(true);
  });

  it('propagates a listen failure without retrying an unrelated socket error', async () => {
    const failure = new Error('listen EADDRINUSE');
    fixture.allocations = [failure, 43127];

    await expect(startAssets(os.tmpdir())).rejects.toBe(failure);

    expect(fixture.listens).toBe(1);
    expect(fixture.servers.every(server => !server.listening)).toBe(true);
    expect(fixture.servers.every(server => server.listenerCount('error') === 0)).toBe(true);
  });

  it.each([null, 'named-pipe'])('does not publish an invalid TCP address %s', async address => {
    fixture.allocations = [address];

    await expect(startAssets(os.tmpdir())).rejects.toThrow();

    expect(fixture.servers.every(server => !server.listening)).toBe(true);
  });

  it.each([43127, 49152, 65535])(
    'retains an allowed allocated port %i without an extra listener',
    async port => {
      fixture.allocations = [port];

      const assets = await startAssets(os.tmpdir());

      expect(assets.origin).toBe(`http://127.0.0.1:${port}`);
      expect(fixture.listens).toBe(1);
      expect(fixture.closes).toBe(0);
      expect(assets.http.listenerCount('error')).toBe(0);
    },
  );
});
