import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

import { createOfflineHtmlContentKind } from '../libraries/content-kind';
import {
  createOfflineLibraryResourceReader,
  OFFLINE_LIBRARY_RESOURCES,
} from '../libraries/resources';

const assetRoot = new URL('../assets/', import.meta.url);
const assetsDirectory = fileURLToPath(assetRoot);
const kind = createOfflineHtmlContentKind(assetRoot);
const resourceUrls = Object.fromEntries(
  OFFLINE_LIBRARY_RESOURCES.map(resource => [resource.path, resource.path]),
);

describe('offline HTML document composition', () => {
  it('loads only selected libraries synchronously before the exact authored source', () => {
    const html =
      '\n<style>#scene { height: 300px }</style><div id="scene"></div><script>window.authorRan = true;</script>\n';
    const composed = kind.composeDocument({
      source: JSON.stringify({ version: 1, libraries: ['matter', 'three'], html }),
      title: 'Scene',
      promptGranted: false,
      resourceUrls,
    });
    expect(composed.endsWith(html)).toBe(true);
    const dom = new JSDOM(composed);
    try {
      const scripts = [...dom.window.document.querySelectorAll('script[src]')];
      expect(scripts.map(script => script.getAttribute('src'))).toEqual(
        ['matter', 'three'].map(
          id => OFFLINE_LIBRARY_RESOURCES.find(resource => resource.id === id)!.path,
        ),
      );
      for (const script of scripts) {
        for (const name of ['type', 'async', 'defer', 'crossorigin'])
          expect(script.hasAttribute(name)).toBe(false);
      }
      expect(dom.window.document.querySelectorAll('script').length).toBe(4);
    } finally {
      dom.window.close();
    }
  });

  it('requires only selected resources and safely encodes their URLs', () => {
    const selected = OFFLINE_LIBRARY_RESOURCES.find(resource => resource.id === 'd3')!;
    const url = 'https://library.invalid/resource?a=1&b="untrusted"';
    const composed = kind.composeDocument({
      source: JSON.stringify({ version: 1, libraries: ['d3'], html: '<p>Chart</p>' }),
      title: 'Chart',
      promptGranted: false,
      resourceUrls: { [selected.path]: url },
    });
    const dom = new JSDOM(composed);
    try {
      expect(dom.window.document.querySelector('script[src]')!.getAttribute('src')).toBe(url);
      expect(dom.window.document.querySelectorAll('script[src]').length).toBe(1);
    } finally {
      dom.window.close();
    }
    expect(() =>
      kind.composeDocument({
        source: JSON.stringify({ version: 1, libraries: ['d3'], html: '<p>Chart</p>' }),
        title: 'Chart',
        promptGranted: false,
        resourceUrls: {},
      }),
    ).toThrow('Offline widget library resource unavailable');
  });
});

describe('offline library resource boundary', () => {
  it('serves the six prepared JavaScript resources and rejects every unregistered path', async () => {
    expect(kind.resources.paths).toEqual(OFFLINE_LIBRARY_RESOURCES.map(resource => resource.path));
    for (const resource of OFFLINE_LIBRARY_RESOURCES) {
      const response = await kind.resources.readPublicResource(resource.path);
      expect(response?.contentType).toBe('text/javascript; charset=utf-8');
      expect(response?.body.byteLength).toBeGreaterThan(1000);
    }
    for (const candidate of [
      '/__widget_kit__/libraries/three-latest.js',
      '/__widget_kit__/libraries/../integrity.json',
      '/__widget_kit__/libraries/%2e%2e/integrity.json',
      '/__widget_kit__/libraries/three.js?token=private',
      '/mcp-app-sandbox',
      '/integrity.json',
    ])
      expect(await kind.resources.readPublicResource(candidate)).toBeUndefined();
  });

  it('rejects missing or modified bytes with a fixed error', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'widget-library-reader-'));
    try {
      const root = pathToFileURL(temporary + path.sep);
      const resource = OFFLINE_LIBRARY_RESOURCES.find(resource => resource.id === 'matter')!;
      const filename = path.join(temporary, resource.file);
      await mkdir(path.dirname(filename), { recursive: true });
      await copyFile(
        path.join(assetsDirectory, 'integrity.json'),
        path.join(temporary, 'integrity.json'),
      );
      const reader = createOfflineLibraryResourceReader(root);
      await expect(reader(resource.path)).rejects.toThrow(
        'Offline widget library resource unavailable',
      );
      await copyFile(path.join(assetsDirectory, resource.file), filename);
      expect((await reader(resource.path))?.body.byteLength).toBeGreaterThan(1000);
      const body = await readFile(filename);
      body[body.length - 1] ^= 1;
      await writeFile(filename, body);
      await expect(reader(resource.path)).rejects.toThrow(
        'Offline widget library resource unavailable',
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it('does not follow a resource directory outside the asset root', async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'widget-library-link-'));
    try {
      const inside = path.join(temporary, 'assets');
      const outside = path.join(temporary, 'outside');
      await mkdir(inside);
      await mkdir(outside);
      const resource = OFFLINE_LIBRARY_RESOURCES.find(resource => resource.id === 'matter')!;
      await copyFile(
        path.join(assetsDirectory, resource.file),
        path.join(outside, path.basename(resource.file)),
      );
      await copyFile(
        path.join(assetsDirectory, 'integrity.json'),
        path.join(inside, 'integrity.json'),
      );
      await symlink(
        outside,
        path.join(inside, 'libraries'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const reader = createOfflineLibraryResourceReader(pathToFileURL(inside + path.sep));
      await expect(reader(resource.path)).rejects.toThrow(
        'Offline widget library resource unavailable',
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
