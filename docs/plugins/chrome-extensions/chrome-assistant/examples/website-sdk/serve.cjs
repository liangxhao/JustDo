'use strict';

const { existsSync, readFileSync } = require('node:fs');
const { createServer } = require('node:http');
const path = require('node:path');

const port = Number(process.argv[2] ?? 4178);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Pass a port between 1 and 65535.');
}

const sdk = path.resolve(
  __dirname,
  '../../../../../../build/chrome-extension/chrome-extension/chrome-assistant.js',
);
if (!existsSync(sdk)) {
  console.error('Run npm run chrome-extension:prepare from the repository root first.');
  process.exitCode = 1;
} else {
  const routes = new Map([
    ['/', ['text/html; charset=utf-8', readFileSync(path.join(__dirname, 'index.html'))]],
    ['/demo.js', ['text/javascript; charset=utf-8', readFileSync(path.join(__dirname, 'demo.js'))]],
    ['/chrome-assistant.js', ['text/javascript; charset=utf-8', readFileSync(sdk)]],
  ]);
  createServer((request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const asset = routes.get(request.url);
    if (!asset) {
      response.writeHead(404).end();
      return;
    }
    const [contentType, body] = asset;
    response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : body);
  }).listen(port, '127.0.0.1', () => {
    console.log(`Website SDK example: http://127.0.0.1:${port}`);
  });
}
