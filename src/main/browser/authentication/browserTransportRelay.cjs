'use strict';

const net = require('node:net');

const upstreamPort = Number(process.argv[2]);
const CONNECT_TIMEOUT_MS = 8_000;
const IDLE_TIMEOUT_MS = 120_000;
const CONNECTION_LIMIT = 32;
const CLIENT_HELLO_LIMIT = 64 * 1024;
const TLS_RECORD_LIMIT = 16 * 1024;
const CLIENT_HELLO_TIMEOUT_MS = 4_000;
const LOCALHOST = Buffer.from('localhost');
const HTTP2 = Buffer.from('h2');

function isLocalServerName(extension) {
  // The only supported name type is host_name. Require a single entry.
  return (
    extension.length === 5 + LOCALHOST.length &&
    extension.readUInt16BE(0) === extension.length - 2 &&
    extension[2] === 0 &&
    extension.readUInt16BE(3) === LOCALHOST.length &&
    extension.subarray(5).equals(LOCALHOST)
  );
}

function offersHttp2(extension) {
  if (extension.length < 3 || extension.readUInt16BE(0) !== extension.length - 2) return false;
  let offered = false;
  let cursor = 2;
  while (cursor < extension.length) {
    const length = extension[cursor++];
    const end = cursor + length;
    if (!length || end > extension.length) return false;
    if (extension.subarray(cursor, end).equals(HTTP2)) offered = true;
    cursor = end;
  }
  return offered;
}

function permitsClientHello(hello) {
  // legacy_version and random, then session id, cipher suites and compression.
  if (hello.length < 40 || hello[0] !== 3 || hello[1] !== 3) return false;
  let cursor = 34;
  const sessionLength = hello[cursor++];
  cursor += sessionLength;
  if (sessionLength > 32 || cursor + 2 > hello.length) return false;
  const ciphersLength = hello.readUInt16BE(cursor);
  cursor += 2 + ciphersLength;
  if (ciphersLength < 2 || ciphersLength % 2 !== 0 || cursor >= hello.length) return false;
  const compressionLength = hello[cursor++];
  cursor += compressionLength;
  if (!compressionLength || cursor + 2 > hello.length) return false;
  const extensionsLength = hello.readUInt16BE(cursor);
  cursor += 2;
  if (cursor + extensionsLength !== hello.length) return false;

  let localhost = false;
  let http2 = false;
  const seen = new Set();
  while (cursor < hello.length) {
    if (cursor + 4 > hello.length) return false;
    const type = hello.readUInt16BE(cursor);
    const length = hello.readUInt16BE(cursor + 2);
    cursor += 4;
    const end = cursor + length;
    if (seen.has(type) || end > hello.length) return false;
    seen.add(type);
    if (type === 0) localhost = isLocalServerName(hello.subarray(cursor, end));
    if (type === 16) http2 = offersHttp2(hello.subarray(cursor, end));
    cursor = end;
  }
  return localhost && http2;
}

/** Reads only the first handshake, then puts the exact received bytes back. */
function readClientHello(socket) {
  return new Promise(resolve => {
    const records = Buffer.alloc(CLIENT_HELLO_LIMIT);
    const hello = Buffer.alloc(CLIENT_HELLO_LIMIT);
    let recordBytes = 0;
    let recordStart = 0;
    let helloBytes = 0;
    const timer = setTimeout(() => finish(false), CLIENT_HELLO_TIMEOUT_MS);

    function finish(allowed) {
      clearTimeout(timer);
      socket.off('readable', inspect);
      socket.off('error', reject);
      socket.off('end', reject);
      socket.off('close', reject);
      if (allowed && !socket.destroyed) {
        socket.unshift(records.subarray(0, recordBytes));
        resolve(true);
      } else resolve(false);
    }

    function reject() {
      finish(false);
    }

    function inspect() {
      try {
        read();
      } catch {
        finish(false);
      }
    }

    function read() {
      // Read up to the declared record boundary to keep the unread stream and
      // recorded prefix independent of the network's chunk boundaries.
      while (recordStart + 5 <= CLIENT_HELLO_LIMIT) {
        const headerEnd = recordStart + 5;
        if (recordBytes < headerEnd && !readThrough(headerEnd)) return;
        const length = records.readUInt16BE(recordStart + 3);
        if (
          records[recordStart] !== 22 ||
          records[recordStart + 1] !== 3 ||
          records[recordStart + 2] < 1 ||
          records[recordStart + 2] > 3 ||
          !length ||
          length > TLS_RECORD_LIMIT ||
          headerEnd + length > CLIENT_HELLO_LIMIT
        ) {
          finish(false);
          return;
        }
        if (!readThrough(headerEnd + length)) return;
        records.copy(hello, helloBytes, headerEnd, recordBytes);
        helloBytes += length;
        recordStart = recordBytes;
        if (hello[0] !== 1) {
          finish(false);
          return;
        }
        if (helloBytes < 4) continue;
        const helloEnd = 4 + hello.readUIntBE(1, 3);
        if (helloEnd > CLIENT_HELLO_LIMIT) {
          finish(false);
          return;
        }
        if (helloBytes >= helloEnd) {
          finish(permitsClientHello(hello.subarray(4, helloEnd)));
          return;
        }
      }
      finish(false);
    }

    function readThrough(end) {
      if (recordBytes >= end) return true;
      const chunk = socket.read(end - recordBytes);
      if (!chunk) return false;
      chunk.copy(records, recordBytes);
      recordBytes += chunk.length;
      return recordBytes === end;
    }

    socket.once('error', reject);
    socket.once('end', reject);
    socket.once('close', reject);
    socket.on('readable', inspect);
  });
}

function openUpstream(client, connections) {
  // Keep the browser's existing TLS and HTTP connection byte-for-byte.
  // Resolve localhost only to numeric loopback addresses.
  const upstream = net.connect({
    host: 'localhost',
    port: upstreamPort,
    allowHalfOpen: true,
    autoSelectFamily: true,
    lookup(_hostname, _options, callback) {
      callback(null, [
        { address: '::1', family: 6 },
        { address: '127.0.0.1', family: 4 },
      ]);
    },
  });
  connections.add(upstream);
  const timer = setTimeout(() => upstream.destroy(), CONNECT_TIMEOUT_MS);
  upstream.once('connect', () => {
    clearTimeout(timer);
    const retire = () => {
      client.destroy();
      upstream.destroy();
    };
    // Each forwarded byte is I/O on both sockets.
    upstream.setTimeout(IDLE_TIMEOUT_MS, retire);
    client.pipe(upstream).pipe(client);
  });
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
  upstream.once('close', () => {
    clearTimeout(timer);
    connections.delete(upstream);
    if (!client.destroyed) client.end();
  });
  client.once('close', () => {
    if (!upstream.destroyed) upstream.destroy();
  });
}

if (process.platform === 'win32' && process.connected && process.send &&
    /^\d+$/u.test(process.argv[2] ?? '') && upstreamPort >= 1 && upstreamPort <= 65_535) {
  const connections = new Set();
  const clients = new Set();
  process.once('disconnect', () => {
    for (const socket of connections) socket.destroy();
  });
  process.on('message', (message, client) => {
    if (!(client instanceof net.Socket)) return;
    if (message !== 'connect' || clients.size >= CONNECTION_LIMIT) {
      client.destroy();
      return;
    }
    connections.add(client);
    clients.add(client);
    client.once('close', () => {
      connections.delete(client);
      clients.delete(client);
    });
    void readClientHello(client)
      .then(allowed => {
        if (allowed && process.connected && !client.destroyed) openUpstream(client, connections);
        else client.destroy();
      })
      .catch(() => client.destroy());
  });
  process.send('ready', error => {
    if (error && process.connected) process.disconnect();
  });
}
