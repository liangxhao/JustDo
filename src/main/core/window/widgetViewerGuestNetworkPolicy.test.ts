import { describe, expect, it } from 'vitest';

import type { WidgetNetworkCreate } from '../../../shared/widgets/network';
import {
  classifyNetworkRequest,
  createNetworkPolicy,
  normalizedNetworkBinding,
  privateNetworkHost,
  sanitizedWidgetRequestHeaders,
  strictProxyRoute,
} from './widgetViewerGuestNetworkPolicy';

const mountId = '2e4ec192-521e-4b76-b132-e34598e41bb2';
const sandboxUrl = `http://127.0.0.1:18790/mcp-app-sandbox?csp=YWJj&v=${'a'.repeat(64)}`;
const resourceUrl = `http://127.0.0.1:18789/__openclaw__/cap/${'a'.repeat(24)}/__smart_canvas__/image-loading.js`;
const input: WidgetNetworkCreate = {
  mountId,
  nonce: 'fixture',
  gatewayOrigin: 'http://127.0.0.1:18789',
  sandboxUrl,
  resourceUrls: [resourceUrl],
  binding: {
    connectionGeneration: 1,
    agentId: 'main',
    sessionKey: 'agent:main:chat',
    sessionId: 'session',
    lifecycleRevision: 'lifecycle',
    name: 'globe',
    revision: 1,
    instanceId: 'native-instance',
    viewGeneration: 'view',
    grantState: 'granted',
    netOrigins: ['https://assets.example'],
  },
};
const policy = () => createNetworkPolicy(input, 'http://127.0.0.1:43127/index.html', false);

describe('network widget policy', () => {
  it('admits the actual Vite renderer-root module graph only for the fixed viewer', () => {
    const p = createNetworkPolicy(input, 'http://127.0.0.1:43127/index.html', true);
    const modules = ['viewer', 'host', 'draft', 'links', 'messaging', 'sizing', 'viewport-fit'].map(
      name => `/libs/openclaw-chat/components/native-widget/${name}.ts`,
    );
    const viteEnvironment = new URL(
      `/@fs/${path.resolve('node_modules/vite/dist/client/env.mjs').replace(/\\/gu, '/')}`,
      p.applicationOrigin,
    ).pathname;
    for (const module of [
      ...modules,
      '/@vite/client',
      '/@vite/env',
      '/@react-refresh',
      viteEnvironment,
    ]) {
      for (const query of ['', '?t=1793000000000', '?v=a1b2c3d4', '?t=1793000000000&v=a1b2c3d4']) {
        const request = {
          url: p.applicationOrigin + module + query,
          method: 'GET',
          resourceType: 'script',
        };
        expect(classifyNetworkRequest(p, request, 'viewer'), module + query).toBe('transport');
        expect(classifyNetworkRequest(p, request, 'widget')).toBe('denied');
        expect(classifyNetworkRequest(policy(), request, 'viewer')).toBe('denied');
      }
    }
    for (const candidate of [
      '/libs/openclaw-chat/components/native-widget/view.ts',
      '/libs/openclaw-chat/components/native-board-widget/controller.ts',
      '/src/renderer/index.ts',
      '/node_modules/react/index.js',
      '/@fs/E:/secrets/config.json',
      '/@id/arbitrary',
      modules[0] + '?token=secret',
      modules[0] + '?raw',
      modules[0] + '?t=1',
      modules[0] + '?t=1793000000000&t=1793000000001',
      modules[0] + '?v=a1b2c3d4&import',
      modules[0] + '?%74=1793000000000',
    ]) {
      expect(
        classifyNetworkRequest(
          p,
          { url: p.applicationOrigin + candidate, method: 'GET', resourceType: 'script' },
          'viewer',
        ),
        candidate,
      ).toBe('denied');
    }
  });
  it('permits only the exact transport and the correct requesting frame role', () => {
    const p = policy();
    for (const [url, resourceType, role] of [
      [p.viewerUrl, 'mainFrame', 'viewer'],
      [sandboxUrl, 'subFrame', 'sandbox'],
      [resourceUrl, 'script', 'widget'],
    ] as const) {
      expect(classifyNetworkRequest(p, { url, resourceType, method: 'GET' }, role)).toBe(
        'transport',
      );
      expect(classifyNetworkRequest(p, { url, resourceType, method: 'GET' }, 'unknown')).toBe(
        'denied',
      );
      expect(
        classifyNetworkRequest(p, { url: url + '&token=extra', resourceType, method: 'GET' }, role),
      ).toBe('denied');
    }
    expect(
      classifyNetworkRequest(p, { url: resourceUrl, resourceType: 'xhr', method: 'GET' }, 'widget'),
    ).toBe('denied');
    expect(
      classifyNetworkRequest(
        p,
        { url: p.applicationOrigin + '/index.html', resourceType: 'mainFrame', method: 'GET' },
        'viewer',
      ),
    ).toBe('denied');
    expect(
      classifyNetworkRequest(
        p,
        {
          url: p.applicationOrigin + '/assets/viewer-123.js',
          resourceType: 'script',
          method: 'GET',
        },
        'widget',
      ),
    ).toBe('denied');
  });

  it('leaves resource origins to native CSP without requiring another data-access grant', () => {
    const p = policy();
    for (const resourceType of ['script', 'stylesheet', 'font', 'image', 'media']) {
      for (const url of ['https://cdn.jsdelivr.net/resource', 'https://other.example/resource']) {
        const request = { url, resourceType, method: 'GET' };
        expect(classifyNetworkRequest(p, request, 'widget')).toBe('resource');
        expect(classifyNetworkRequest(p, { ...request, method: 'HEAD' }, 'widget')).toBe(
          'resource',
        );
        expect(classifyNetworkRequest(p, { ...request, method: 'POST' }, 'widget')).toBe('denied');
        expect(
          classifyNetworkRequest(p, { ...request, uploadData: [{ bytes: [1] }] }, 'widget'),
        ).toBe('denied');
        expect(classifyNetworkRequest(p, { ...request, resourceType: 'xhr' }, 'widget')).toBe(
          'denied',
        );
        for (const role of ['viewer', 'sandbox', 'unknown'] as const)
          expect(classifyNetworkRequest(p, request, role)).toBe('denied');
      }
    }
    const secure = createNetworkPolicy(
      {
        ...input,
        gatewayOrigin: 'https://gateway.example:18789',
        sandboxUrl: sandboxUrl.replace('http://127.0.0.1', 'https://gateway.example'),
        resourceUrls: [resourceUrl.replace('http://127.0.0.1', 'https://gateway.example')],
      },
      'https://application.example:43127/index.html',
      false,
    );
    for (const origin of [
      secure.applicationOrigin,
      secure.gatewayOrigin,
      new URL(secure.sandboxUrl).origin,
    ])
      expect(
        classifyNetworkRequest(
          secure,
          { url: origin + '/arbitrary.js', resourceType: 'script', method: 'GET' },
          'widget',
        ),
      ).toBe('denied');
  });

  it('blocks uploads, ungranted data access, and websocket even for approved origins', () => {
    const p = policy();
    const request = { url: 'https://assets.example/earth.jpg', resourceType: 'xhr', method: 'GET' };
    expect(classifyNetworkRequest(p, request, 'widget')).toBe('business');
    for (const change of [
      { method: 'POST' },
      { method: 'DELETE' },
      { uploadData: [{ bytes: new Uint8Array([1]) }] },
      { url: 'https://other.example/image' },
      { resourceType: 'webSocket' },
      { url: 'wss://assets.example/socket' },
      { url: 'https://user:password@assets.example/image' },
    ]) {
      expect(classifyNetworkRequest(p, { ...request, ...change }, 'widget')).toBe('denied');
    }
    expect(classifyNetworkRequest(p, request, 'viewer')).toBe('denied');
  });

  it('rejects private literal origins and transport disguised as business origins', () => {
    for (const host of [
      '127.0.0.1',
      '10.0.0.2',
      '172.20.1.4',
      '192.168.1.1',
      'localhost',
      'host.localhost',
      '[::1]',
      '[fc00::1]',
      '[::ffff:7f00:1]',
      '192.0.0.5',
      '169.254.1.1',
    ])
      expect(privateNetworkHost(host)).toBe(true);
    expect(privateNetworkHost('assets.example')).toBe(false);
    expect(privateNetworkHost('8.8.8.8')).toBe(false);
    expect(() =>
      normalizedNetworkBinding({ ...input.binding, netOrigins: ['https://127.0.0.1'] }),
    ).toThrow();
    expect(() =>
      normalizedNetworkBinding({ ...input.binding, netOrigins: ['https://assets.example/path'] }),
    ).toThrow();
    expect(() =>
      normalizedNetworkBinding({ ...input.binding, netOrigins: ['https://*.example'] }),
    ).toThrow();
    expect(() =>
      createNetworkPolicy(
        { ...input, resourceUrls: [resourceUrl.replace('/image-loading.js', '/secrets.js')] },
        'http://127.0.0.1:43127/index.html',
        false,
      ),
    ).toThrow();
  });

  it('requires a proxy-only route including every PAC fallback', () => {
    expect(strictProxyRoute('PROXY proxy.example:8080')).toBe(true);
    expect(strictProxyRoute('PROXY proxy.example:8080; HTTPS fallback.example:443')).toBe(true);
    for (const route of [
      '',
      'DIRECT',
      'PROXY proxy.example:8080; DIRECT',
      'DIRECT; PROXY proxy.example:8080',
      'PROXY proxy.example',
      'SOCKS proxy.example:1080;',
    ])
      expect(strictProxyRoute(route)).toBe(false);
  });

  it('strips source credentials and admits only genuine read-method preflight headers', () => {
    expect(
      sanitizedWidgetRequestHeaders(
        {
          Cookie: 'source=secret',
          Authorization: 'secret',
          'Proxy-Authorization': 'caller',
          Accept: 'image/png',
        },
        false,
      ),
    ).toEqual({ Accept: 'image/png' });
    expect(
      sanitizedWidgetRequestHeaders(
        {
          Origin: 'null',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'range',
        },
        true,
      ),
    ).toBeDefined();
    expect(
      sanitizedWidgetRequestHeaders(
        { Origin: 'null', 'Access-Control-Request-Method': 'POST' },
        true,
      ),
    ).toBeUndefined();
    expect(
      sanitizedWidgetRequestHeaders(
        { Origin: 'https://assets.example', 'Access-Control-Request-Method': 'GET' },
        true,
      ),
    ).toBeUndefined();
    expect(
      sanitizedWidgetRequestHeaders(
        {
          Origin: 'null',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'authorization',
        },
        true,
      ),
    ).toBeUndefined();
  });
});
import path from 'node:path';
