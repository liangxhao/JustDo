import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, test } from 'vitest';

const patch =
  require('../../../../scripts/patches/v2026.7.1-2/047-openai-compatible-embedding-env-proxy.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    verifyPatch: (runtimeDir: string) => void;
    __testing: {
      AUDIT_CONTEXT: string;
      MARKER: string;
      PATCHED_REQUEST_PATTERN: RegExp;
      PROXY_CONTRACT: string;
      transformEmbeddingProvider: (content: string, filePath: string) => string;
    };
  };

const runtimeRoot = path.resolve('vendor/openclaw-runtime/current');
const runtimeDist = path.join(runtimeRoot, 'dist');
const bundlePath = path.join(runtimeRoot, 'gateway-bundle.mjs');

function findEmbeddingProviderSource(): string {
  const candidate = fs.readdirSync(runtimeDist).find(fileName => {
    if (!fileName.endsWith('.js')) return false;
    const content = fs.readFileSync(path.join(runtimeDist, fileName), 'utf8');
    return (
      content.includes('async function postEmbeddingRequest(params) {') &&
      content.includes(patch.__testing.AUDIT_CONTEXT)
    );
  });
  if (!candidate) throw new Error('OpenAI-compatible embedding provider source was not found');
  return path.join(runtimeDist, candidate);
}

const sourcePath = findEmbeddingProviderSource();

describe('OpenAI-compatible embedding environment proxy patch', () => {
  test('adds the eligible environment proxy option to source and bundle idempotently', () => {
    for (const filePath of [sourcePath, bundlePath]) {
      const original = fs.readFileSync(filePath, 'utf8');
      const transformed = patch.__testing.transformEmbeddingProvider(original, filePath);

      expect(transformed).toMatch(patch.__testing.PATCHED_REQUEST_PATTERN);
      expect(transformed).toContain(patch.__testing.PROXY_CONTRACT);
      expect(patch.__testing.transformEmbeddingProvider(transformed, filePath)).toBe(transformed);
    }
  });

  test('rejects partial and ambiguous embedding request contracts', () => {
    const original = `async function postEmbeddingRequest(params) {
  return await fetchWithSsrFGuard({
    auditContext: "embedding-provider:openai-compatible"
  });
}`;
    const transformed = patch.__testing.transformEmbeddingProvider(original, 'embedding.js');
    const partial = transformed.replace(patch.__testing.PROXY_CONTRACT, 'mode: "strict"');

    expect(() => patch.__testing.transformEmbeddingProvider(partial, 'embedding.js')).toThrow(
      'partial OpenAI-compatible embedding env-proxy patch',
    );
    expect(() =>
      patch.__testing.transformEmbeddingProvider(
        `${original}\n${patch.__testing.AUDIT_CONTEXT};`,
        'embedding.js',
      ),
    ).toThrow('audit context count is 2, expected 1');
  });

  test('applies and verifies the real source and bundle targets atomically', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-embedding-proxy-patch-'));
    const fixtureDist = path.join(fixtureRoot, 'dist');
    fs.mkdirSync(fixtureDist, { recursive: true });
    fs.copyFileSync(sourcePath, path.join(fixtureDist, path.basename(sourcePath)));
    fs.copyFileSync(bundlePath, path.join(fixtureRoot, 'gateway-bundle.mjs'));

    try {
      const changed = patch.applyPatch(fixtureRoot);
      expect(changed.every(filePath => filePath.endsWith('.js') || filePath.endsWith('.mjs'))).toBe(
        true,
      );
      expect(() => patch.verifyPatch(fixtureRoot)).not.toThrow();
      expect(patch.applyPatch(fixtureRoot)).toEqual([]);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('does not write the source when the bundle contract is ambiguous', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-embedding-proxy-atomic-'));
    const fixtureDist = path.join(fixtureRoot, 'dist');
    const sourceFixturePath = path.join(fixtureDist, 'embedding-provider.js');
    const bundleFixturePath = path.join(fixtureRoot, 'gateway-bundle.mjs');
    const pristine = `async function postEmbeddingRequest(params) {
  return await fetchWithSsrFGuard({
    auditContext: "embedding-provider:openai-compatible"
  });
}`;
    fs.mkdirSync(fixtureDist, { recursive: true });
    fs.writeFileSync(sourceFixturePath, pristine);
    fs.writeFileSync(bundleFixturePath, `${pristine}\n${patch.__testing.AUDIT_CONTEXT};`);

    try {
      expect(() => patch.applyPatch(fixtureRoot)).toThrow(
        'audit context count is 2, expected 1',
      );
      expect(fs.readFileSync(sourceFixturePath, 'utf8')).toBe(pristine);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('the guarded fetch option sends an eligible request through HTTP_PROXY', async () => {
    const proxyRequests: Array<{ url: string | undefined; probe: string | undefined }> = [];
    const proxyServer = http.createServer((request, response) => {
      proxyRequests.push({
        url: request.url,
        probe: request.headers['x-embedding-proxy-probe'],
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"data":[]}');
    });
    proxyServer.on('connect', (request, socket) => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      let tunneledRequest = '';
      socket.on('data', chunk => {
        tunneledRequest += chunk.toString('latin1');
        if (!tunneledRequest.includes('\r\n\r\n')) return;
        const probe = /^x-embedding-proxy-probe:\s*(.+)$/im.exec(tunneledRequest)?.[1]?.trim();
        proxyRequests.push({ url: `connect:${request.url}`, probe });
        socket.end(
          'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{"data":[]}',
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      proxyServer.once('error', reject);
      proxyServer.listen(0, '127.0.0.1', resolve);
    });

    const proxyKeys = [
      'HTTP_PROXY',
      'http_proxy',
      'HTTPS_PROXY',
      'https_proxy',
      'ALL_PROXY',
      'all_proxy',
      'NO_PROXY',
      'no_proxy',
      'OPENCLAW_PROXY_ACTIVE',
    ] as const;
    const previousEnvironment = new Map(
      proxyKeys.map(key => [key, process.env[key]] as const),
    );
    const address = proxyServer.address() as AddressInfo;
    const proxyUrl = `http://127.0.0.1:${address.port}`;
    const targetUrl = 'http://example.com/embeddings';

    try {
      for (const key of proxyKeys) delete process.env[key];
      process.env.HTTP_PROXY = proxyUrl;
      process.env.http_proxy = proxyUrl;

      const infra = (await import(
        pathToFileURL(path.join(runtimeDist, 'plugin-sdk', 'infra-runtime.js')).href
      )) as {
        fetchWithSsrFGuard: (params: Record<string, unknown>) => Promise<{
          response: Response;
          release: () => Promise<void>;
        }>;
        ssrfPolicyFromHttpBaseUrlAllowedHostname: (url: string) => unknown;
        shouldUseEnvHttpProxyForUrl: (url: string) => boolean;
      };
      expect(infra.shouldUseEnvHttpProxyForUrl(targetUrl)).toBe(true);
      const guarded = await infra.fetchWithSsrFGuard({
        url: targetUrl,
        init: {
          method: 'POST',
          headers: { 'x-embedding-proxy-probe': 'routed' },
          body: '{}',
        },
        policy: infra.ssrfPolicyFromHttpBaseUrlAllowedHostname(targetUrl),
        useEnvProxyForEligibleUrls: true,
        auditContext: 'embedding-provider:openai-compatible',
        signal: AbortSignal.timeout(20_000),
      });
      try {
        expect(guarded.response.status).toBe(200);
        await guarded.response.text();
      } finally {
        await guarded.release();
      }

      expect(proxyRequests).toHaveLength(1);
      expect(proxyRequests[0]?.url).toContain('example.com');
      expect(proxyRequests[0]?.probe).toBe('routed');
    } finally {
      for (const [key, value] of previousEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await new Promise<void>((resolve, reject) => {
        proxyServer.close(error => (error ? reject(error) : resolve()));
      });
    }
  }, 30_000);
});
