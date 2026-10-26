import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';

import react from '@vitejs/plugin-react';
import ts from 'typescript';
import { createServer } from 'vite';
import { expect, it } from 'vitest';

import { classifyNetworkRequest, createNetworkPolicy } from './widgetViewerGuestNetworkPolicy';

/** A Vite-only server: never loads the Electron app plugin, Gateway or user state. */
it('admits every actual development viewer module without admitting arbitrary application files', async () => {
  const build = path.resolve('build');
  await mkdir(build, { recursive: true });
  const cacheDir = await mkdtemp(path.join(build, 'widget-viewer-vite-'));
  const server = await createServer({
    configFile: false,
    root: path.resolve('src/renderer'),
    cacheDir,
    plugins: [react()],
    server: { host: '127.0.0.1', port: 0, watch: null },
    optimizeDeps: { noDiscovery: true, entries: [], include: [] },
    logLevel: 'error',
  });
  try {
    await server.listen();
    const origin = new URL(server.resolvedUrls!.local[0]).origin;
    const mountId = '2e4ec192-521e-4b76-b132-e34598e41bb2';
    const policy = createNetworkPolicy(
      {
        mountId,
        nonce: 'synthetic',
        gatewayOrigin: 'http://127.0.0.1:18789',
        sandboxUrl: `http://127.0.0.1:18790/mcp-app-sandbox?csp=YWJj&v=${'a'.repeat(64)}`,
        resourceUrls: [],
        binding: {
          connectionGeneration: 1,
          agentId: 'main',
          sessionKey: 'agent:main:chat',
          sessionId: 'synthetic-session',
          lifecycleRevision: 'synthetic-lifecycle',
          name: 'diagram',
          revision: 1,
          instanceId: 'synthetic-instance',
          viewGeneration: 'synthetic-view',
          grantState: 'granted',
          netOrigins: ['https://assets.example'],
        },
      },
      `${origin}/index.html`,
      true,
    );
    const html = await (await fetch(`${origin}/widget-viewer.html?mount=${mountId}`)).text();
    const pending = new Set<string>();
    const visited = new Set<string>();
    const imports = (source: string) => {
      const module = ts.createSourceFile(
        'module.js',
        source,
        ts.ScriptTarget.Latest,
        false,
        ts.ScriptKind.JS,
      );
      for (const statement of module.statements) {
        if (
          (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
          statement.moduleSpecifier &&
          ts.isStringLiteral(statement.moduleSpecifier)
        ) {
          pending.add(statement.moduleSpecifier.text);
        }
      }
    };
    for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/giu)) {
      const src = /\bsrc="([^"]+)"/iu.exec(script[1])?.[1];
      if (src) pending.add(src);
      else imports(script[2]);
    }
    while (pending.size) {
      const next = pending.values().next().value!;
      pending.delete(next);
      if (visited.has(next)) continue;
      expect(next.startsWith('/'), `Unexpected external development import ${next}`).toBe(true);
      expect(visited.size).toBeLessThan(20);
      visited.add(next);
      const request = { url: origin + next, method: 'GET', resourceType: 'script' };
      expect(classifyNetworkRequest(policy, request, 'viewer'), next).toBe('transport');
      expect(classifyNetworkRequest(policy, request, 'widget'), next).toBe('denied');
      const response = await fetch(request.url);
      expect(response.status, next).toBe(200);
      imports(await response.text());
    }
    expect(visited).toContain('/libs/openclaw-chat/components/native-widget/viewer.ts');
    expect(visited).toContain('/@vite/client');
    expect([...visited].some(item => item.endsWith('/vite/dist/client/env.mjs'))).toBe(true);
    expect(
      classifyNetworkRequest(
        policy,
        {
          url: `${origin}/libs/openclaw-chat/gateway/client.ts`,
          method: 'GET',
          resourceType: 'script',
        },
        'viewer',
      ),
    ).toBe('denied');
  } finally {
    await server.close();
  }
}, 30_000);
