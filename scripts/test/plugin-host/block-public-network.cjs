'use strict';

// Test-only cold-start guard. Load before the Gateway with NODE_OPTIONS=--require=...
// It changes no system firewall settings and records only bounded host names.
const fs = require('node:fs');
const net = require('node:net');
const dns = require('node:dns');
const dgram = require('node:dgram');
const { syncBuiltinESMExports } = require('node:module');

const logFile = process.env.APP_PLUGIN_OFFLINE_ATTEMPT_LOG;
let attempts = 0;
function isLoopback(value) {
  const host = String(value ?? 'localhost').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return host === 'localhost' || host === '::1' ||
    (net.isIPv4(host) && host.startsWith('127.')) ||
    (host.startsWith('::ffff:') && net.isIPv4(host.slice(7)) && host.slice(7).startsWith('127.'));
}
function blocked(operation, host) {
  if (logFile && ++attempts <= 100) {
    try {
      const label = /^[a-z0-9.:[\]-]{1,255}$/i.test(String(host)) ? String(host) : '<invalid-host>';
      if (!fs.existsSync(logFile) || fs.statSync(logFile).size < 64 * 1024)
        fs.appendFileSync(logFile, JSON.stringify({ operation, host: label }) + '\n');
    } catch { /* A diagnostic failure must never permit the connection. */ }
  }
  return Object.assign(new Error(`Test offline guard blocked ${operation}`), {
    code: 'NETWORK_BLOCKED',
  });
}
function assertLocal(operation, host) {
  if (!isLoopback(host)) throw blocked(operation, host);
}
function socketHost(args) {
  const values = Array.isArray(args[0]) ? args[0] : args;
  const target = values[0];
  if (target && typeof target === 'object')
    return target.path !== undefined ? null : target.host ?? 'localhost';
  if (typeof target === 'number' || (typeof target === 'string' && /^\d+$/.test(target)))
    return typeof values[1] === 'string' ? values[1] : 'localhost';
  return null; // Unix sockets and Windows named pipes are local IPC.
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const host = socketHost(args);
  if (host !== null) assertLocal('tcp.connect', host);
  return Reflect.apply(connect, this, args);
};
for (const name of Object.keys(dns).filter(name => /^(?:lookup|resolve|reverse)/.test(name))) {
  if (typeof dns[name] !== 'function') continue;
  const original = dns[name];
  dns[name] = function (host, ...args) {
    if (!isLoopback(host)) {
      const error = blocked(`dns.${name}`, host);
      const callback = args.at(-1);
      if (typeof callback === 'function') return process.nextTick(callback, error);
      throw error;
    }
    return Reflect.apply(original, this, [host, ...args]);
  };
}
for (const name of Object.keys(dns.promises).filter(name => /^(?:lookup|resolve|reverse)/.test(name))) {
  const original = dns.promises[name];
  if (typeof original !== 'function') continue;
  dns.promises[name] = async function (host, ...args) {
    assertLocal(`dns.promises.${name}`, host);
    return Reflect.apply(original, this, [host, ...args]);
  };
}
for (const [Resolver, asynchronous] of [[dns.Resolver, false], [dns.promises.Resolver, true]]) {
  for (const name of Object.getOwnPropertyNames(Resolver.prototype).filter(name => /^(?:resolve|reverse)/.test(name))) {
    const original = Resolver.prototype[name];
    Resolver.prototype[name] = function (host, ...args) {
      if (!isLoopback(host)) {
        const error = blocked(`dns.resolver.${name}`, host);
        if (asynchronous) return Promise.reject(error);
        const callback = args.at(-1);
        if (typeof callback === 'function') return process.nextTick(callback, error);
        throw error;
      }
      return Reflect.apply(original, this, [host, ...args]);
    };
  }
}
for (const name of ['send', 'connect']) {
  const original = dgram.Socket.prototype[name];
  dgram.Socket.prototype[name] = function (...args) {
    const host = name === 'connect' ? args[1] : args.slice(1).findLast(value => typeof value === 'string');
    assertLocal(`udp.${name}`, host);
    return Reflect.apply(original, this, args);
  };
}
function httpHost(target) {
  if (typeof target === 'string' || target instanceof URL) return new URL(target).hostname;
  return target?.hostname ?? target?.host ?? 'localhost';
}
for (const protocol of ['http', 'https']) {
  const module = require(`node:${protocol}`);
  for (const name of ['request', 'get']) {
    const original = module[name];
    module[name] = function (...args) {
      assertLocal(`${protocol}.${name}`, httpHost(args[0]));
      return Reflect.apply(original, this, args);
    };
  }
}
if (typeof globalThis.fetch === 'function') {
  const fetch = globalThis.fetch;
  globalThis.fetch = async function (input, options) {
    assertLocal('fetch', httpHost(input instanceof URL ? input : input?.url ?? input));
    return Reflect.apply(fetch, this, [input, options]);
  };
}
syncBuiltinESMExports();
