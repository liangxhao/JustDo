import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  type ApplicationRendererHost,
  startApplicationRendererHost,
} from './applicationRendererHost';

type Reply = { status: number; headers: Record<string, unknown>; body: string };
const read = (
  host: ApplicationRendererHost,
  pathname = '/index.html',
  options: { method?: string; headers?: Record<string, string> | string[] } = {},
): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const url = new URL(host.origin);
    const call = request(
      { hostname: url.hostname, port: url.port, path: pathname, ...options },
      response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () =>
          resolve({
            status: response.statusCode!,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    call.on('error', reject);
    call.setTimeout(3000, () => call.destroy(new Error('Request timed out')));
    call.end();
  });

describe('packaged application renderer host', () => {
  let directory: string;
  let dist: string;
  let host: ApplicationRendererHost | undefined;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'justdo-renderer-host-'));
    dist = path.join(directory, 'dist');
    await mkdir(path.join(dist, 'assets'), { recursive: true });
    await mkdir(path.join(dist, 'pdfjs', 'wasm'), { recursive: true });
    await writeFile(
      path.join(dist, 'index.html'),
      '<html><script>document.documentElement.dataset.theme="local";</script><script src="./assets/main.js"></script></html>',
    );
    await writeFile(
      path.join(dist, 'image-preview.html'),
      '<html><body>Image preview</body></html>',
    );
    await writeFile(
      path.join(dist, 'workspace.html'),
      '<html><body><div id="workspace-root">Workspace</div></body></html>',
    );
    await writeFile(path.join(dist, 'assets', 'main.js'), 'globalThis.ready = true;');
    await writeFile(path.join(dist, 'assets', 'theme.css'), ':root { color: black; }');
    await writeFile(path.join(dist, 'pdfjs', 'wasm', 'decoder.wasm'), 'fixture');
    await writeFile(path.join(directory, 'secret.js'), 'SECRET');
  });
  afterEach(async () => {
    await host?.close();
    host = undefined;
    // Every test-created path stays under this explicit temporary root.
    expect(path.relative(os.tmpdir(), directory)).not.toMatch(/^\.\./u);
    await rm(directory, { recursive: true, force: true });
  });

  it('uses an ephemeral IPv4 loopback origin and serves only packaged artifacts', async () => {
    host = await startApplicationRendererHost(dist);
    expect(host.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(host.url).toBe(`${host.origin}/index.html`);
    const index = await read(host);
    expect(index.status).toBe(200);
    expect(index.body).toContain('dataset.theme');
    expect((await read(host, '/')).body).toBe(index.body);
    expect((await read(host, '/image-preview.html')).body).toContain('Image preview');
    expect((await read(host, '/assets/main.js')).body).toBe('globalThis.ready = true;');
    expect((await read(host, '/pdfjs/wasm/decoder.wasm')).headers['content-type']).toBe(
      'application/wasm',
    );
    expect(index.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(index.headers['access-control-allow-origin']).toBeUndefined();
    expect(index.headers['referrer-policy']).toBe('origin');
    expect(index.headers['cache-control']).toBe('no-store');
  });

  it.each(['\r\n', '\r'])(
    'admits trusted scripts using browser-normalized line endings (%j)',
    async lineEnding => {
      const browserScript = '\nwindow.bootstrapReady = true;\nwindow.bootstrapCount = 1;\n';
      const sourceScript = browserScript.split('\n').join(lineEnding);
      await writeFile(
        path.join(dist, 'index.html'),
        `<html><script>${sourceScript}</script></html>`,
      );
      host = await startApplicationRendererHost(dist);

      const policy = (await read(host)).headers['content-security-policy'] as string;
      const expectedHash = createHash('sha256').update(browserScript).digest('base64');
      const scripts = policy.split('; ').find(directive => directive.startsWith('script-src'));
      expect(scripts).toContain(`'sha256-${expectedHash}'`);
      expect(scripts).not.toContain("'unsafe-inline'");
      expect(scripts).not.toContain("'unsafe-eval'");
    },
  );

  it('preserves trusted entry scripts with hashes and keeps eval/inline code disabled', async () => {
    host = await startApplicationRendererHost(dist);
    const policy = String((await read(host)).headers['content-security-policy']);
    const scripts = policy.split('; ').find(value => value.startsWith('script-src'))!;
    expect(scripts).toMatch(/'sha256-[A-Za-z0-9+/]{43}='/u);
    expect(scripts).toContain("'wasm-unsafe-eval'");
    expect(scripts).not.toContain("'unsafe-inline'");
    expect(scripts).not.toContain("'unsafe-eval'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
  });

  it('serves the same-origin workspace entry with only a bounded native generation query', async () => {
    host = await startApplicationRendererHost(dist);
    const generation = '320f66b4-a1f5-4cab-84fb-818e6b469648';
    const pathname = `/workspace.html?generation=${generation}`;
    const reply = await read(host, pathname, {
      headers: { Origin: host.origin, 'Sec-Fetch-Site': 'same-origin' },
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toContain('workspace-root');
    expect(reply.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(reply.headers['content-security-policy']).toBe(
      (await read(host)).headers['content-security-policy'],
    );
    expect((await read(host, pathname, { method: 'HEAD' })).body).toBe('');
    expect((await read(host, '/workspace.html')).status).toBe(200);
    for (const target of [
      '/workspace.html?',
      '/workspace.html?generation=',
      '/workspace.html?generation=not-a-native-generation',
      `/workspace.html?generation=${generation}&generation=${generation}`,
      `/workspace.html?generation=${generation}&token=unowned`,
      `/workspace.html?source=${generation}`,
      `/workspace.html?generation=${generation}#fragment`,
      `/workspace.html?generation=${generation}/../index.html`,
      `/assets/main.js?generation=${generation}`,
      `/index.html?generation=${generation}`,
      `/image-preview.html?generation=${generation}`,
    ])
      expect((await read(host, target)).status, target).toBe(404);
    expect(
      (await read(host, pathname, { headers: { Origin: 'https://attacker.example' } })).status,
    ).toBe(403);
  });

  it('supports installation paths and artifact names containing Chinese and spaces', async () => {
    const installation = path.join(directory, '安装 空间');
    await mkdir(installation);
    const movedDist = path.join(installation, 'dist');
    await rename(dist, movedDist);
    await writeFile(path.join(movedDist, 'assets', '图标 image.png'), 'image bytes');
    host = await startApplicationRendererHost(movedDist);
    expect((await read(host)).status).toBe(200);
    expect((await read(host, `/assets/${encodeURIComponent('图标 image.png')}`)).body).toBe(
      'image bytes',
    );
  });

  it('supports HEAD without a body and rejects mutating methods', async () => {
    host = await startApplicationRendererHost(dist);
    const reply = await read(host, '/assets/main.js', { method: 'HEAD' });
    expect(reply.status).toBe(200);
    expect(reply.body).toBe('');
    expect(reply.headers['content-length']).toBe(String('globalThis.ready = true;'.length));
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      expect((await read(host, '/index.html', { method })).status).toBe(405);
    }
  });

  it('rejects alternate/duplicate Host values and cross-origin browser requests', async () => {
    host = await startApplicationRendererHost(dist);
    const port = new URL(host.origin).port;
    for (const headers of [
      { Host: `localhost:${port}` },
      { Host: 'attacker.example' },
      { Origin: 'https://attacker.example' },
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Site': 'same-site' },
    ])
      expect((await read(host, '/index.html', { headers })).status).toBe(403);
    expect(
      (
        await read(host, '/index.html', {
          headers: ['Host', `127.0.0.1:${port}`, 'Host', `127.0.0.1:${port}`],
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await read(host, '/index.html', {
          headers: { Origin: host.origin, 'Sec-Fetch-Site': 'same-origin' },
        })
      ).status,
    ).toBe(200);
  });

  it('rejects raw and encoded traversal, separators, devices and absolute-form targets', async () => {
    host = await startApplicationRendererHost(dist);
    for (const target of [
      '/../secret.js',
      '/assets/../../secret.js',
      '/assets/%2e%2e/%2e%2e/secret.js',
      '/assets%2fmain.js',
      '/assets%5cmain.js',
      '/assets/..%5csecret.js',
      '/assets/main.js%00',
      '/assets/main.js:stream',
      '/assets/%252e%252e/secret.js',
      '//assets/main.js',
      '/assets/main.js?source=secret',
      '/assets/%ZZ.js',
      `${host.origin}/index.html`,
    ])
      expect((await read(host, target)).status, target).toBe(404);
  });

  it('excludes credential/config/source files and assets added after startup', async () => {
    await writeFile(path.join(dist, 'user_info.json'), '{"token":"SECRET"}');
    await writeFile(path.join(dist, 'assets', 'main.js.map'), 'SOURCE');
    await writeFile(path.join(dist, 'assets', '.credentials.js'), 'SECRET');
    await writeFile(path.join(dist, 'error.html'), 'unowned entry');
    host = await startApplicationRendererHost(dist);
    await writeFile(path.join(dist, 'assets', 'new.js'), 'new');
    for (const target of [
      '/user_info.json',
      '/assets/main.js.map',
      '/assets/.credentials.js',
      '/error.html',
      '/assets/new.js',
      '/secret.js',
    ]) {
      const reply = await read(host, target);
      expect(reply.status, target).toBe(404);
      expect(reply.body).not.toContain('SECRET');
    }
  });

  it('does not follow a symlink/junction outside the packaged directory', async () => {
    const external = path.join(directory, 'external');
    await mkdir(external);
    await writeFile(path.join(external, 'main.js'), 'SECRET');
    await symlink(
      external,
      path.join(dist, 'assets', 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    host = await startApplicationRendererHost(dist);
    expect((await read(host, '/assets/linked/main.js')).status).toBe(404);
  });

  it('revalidates real paths when an asset directory is replaced with an external link', async () => {
    host = await startApplicationRendererHost(dist);
    const external = path.join(directory, 'external');
    await mkdir(external);
    await writeFile(path.join(external, 'main.js'), 'SECRET');
    await rename(path.join(dist, 'assets'), path.join(dist, 'original-assets'));
    await symlink(
      external,
      path.join(dist, 'assets'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const reply = await read(host, '/assets/main.js');
    expect(reply.status).toBe(404);
    expect(reply.body).not.toContain('SECRET');
  });

  it('fails closed for changed packaged bytes and missing entries', async () => {
    host = await startApplicationRendererHost(dist);
    await writeFile(path.join(dist, 'assets', 'main.js'), 'changed bytes');
    expect((await read(host, '/assets/main.js')).status).toBe(404);
    const noEntry = path.join(directory, 'no-entry');
    await mkdir(noEntry);
    await expect(startApplicationRendererHost(noEntry)).rejects.toThrow('entry missing');
  });

  it('rejects replacement content even when its size and timestamp are restored', async () => {
    const asset = path.join(dist, 'assets', 'main.js');
    const timestamp = new Date('2026-01-01T00:00:00.000Z');
    await utimes(asset, timestamp, timestamp);
    const original = await stat(asset);
    host = await startApplicationRendererHost(dist);

    await writeFile(asset, 'globalThis.ready = null;');
    await utimes(asset, timestamp, timestamp);
    const replaced = await stat(asset);

    expect(replaced.size).toBe(original.size);
    expect(replaced.mtimeMs).toBe(original.mtimeMs);
    const reply = await read(host, '/assets/main.js');
    expect(reply.status).toBe(404);
    expect(reply.body).not.toContain('null');
  });

  it('closes active sockets and the listener idempotently', async () => {
    host = await startApplicationRendererHost(dist);
    expect((await read(host)).status).toBe(200);
    const firstClose = host.close();
    expect(host.close()).toBe(firstClose);
    await firstClose;
    await expect(read(host)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});
