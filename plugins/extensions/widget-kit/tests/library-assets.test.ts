import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const tar = require('tar');
const {
  prepareWidgetLibraryAssets,
  verifyWidgetLibraryAssets,
  verifyWidgetLibraryResource,
  readUpstreams,
} = require('../scripts/prepare.cjs');

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function fixture(source = 'globalThis.d3 = { version: "fixture" };', identity = 'd3') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-library-assets-'));
  roots.push(root);
  const cache = path.join(root, 'cache');
  const packageRoot = path.join(root, 'source', 'package');
  fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
  fs.mkdirSync(cache);
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ name: identity, version: '7.9.0' }),
  );
  fs.writeFileSync(path.join(packageRoot, 'LICENSE'), 'Fixture library license\n');
  fs.writeFileSync(path.join(packageRoot, 'dist/d3.min.js'), source);
  const library = {
    ...readUpstreams().libraries.find((entry: { id: string }) => entry.id === 'd3'),
  };
  const archive = path.join(cache, library.archive);
  await tar.c({ cwd: path.dirname(packageRoot), file: archive, gzip: true, portable: true }, [
    'package',
  ]);
  const archiveBytes = fs.readFileSync(archive);
  library.integrity = `sha512-${crypto.createHash('sha512').update(archiveBytes).digest('base64')}`;
  const manifest = { schemaVersion: 1, libraries: [library] };
  const options = {
    cacheDirectory: cache,
    outputDirectory: path.join(root, 'assets'),
    buildDirectory: path.join(root, 'build'),
    manifest,
  };
  return { root, options, library, archive, archiveBytes };
}

describe('offline widget library preparation', () => {
  it('uses only pinned local archives and retains licenses in a closed, verified payload', async () => {
    const fetch = vi.fn(() => {
      throw new Error('Preparation must remain offline');
    });
    vi.stubGlobal('fetch', fetch);
    const { options, library, archive, archiveBytes } = await fixture();

    const integrity = await prepareWidgetLibraryAssets(options);

    expect(fetch).not.toHaveBeenCalled();
    expect(fs.readFileSync(archive)).toEqual(archiveBytes);
    expect(
      verifyWidgetLibraryAssets(options.outputDirectory, false, { manifest: options.manifest }),
    ).toEqual(integrity);
    const resource = integrity.resources[library.resourcePath];
    expect(resource.file).toBe('libraries/d3-7.9.0.js');
    expect(
      verifyWidgetLibraryResource(
        library.resourcePath,
        fs.readFileSync(path.join(options.outputDirectory, resource.file)),
        integrity,
      ),
    ).toEqual(resource);
    expect(
      fs.readFileSync(path.join(options.outputDirectory, 'licenses/d3-7.9.0/LICENSE'), 'utf8'),
    ).toBe('Fixture library license\n');
    expect(fs.readdirSync(options.buildDirectory)).toEqual([]);
  });

  it('rejects a corrupt archive before replacing a previously prepared payload', async () => {
    const { options, archive } = await fixture();
    const previous = await prepareWidgetLibraryAssets(options);
    fs.appendFileSync(archive, 'corruption');

    await expect(prepareWidgetLibraryAssets(options)).rejects.toThrow('SHA-512 mismatch');

    expect(
      verifyWidgetLibraryAssets(options.outputDirectory, false, { manifest: options.manifest }),
    ).toEqual(previous);
    expect(fs.readdirSync(options.buildDirectory)).toEqual([]);
  });

  it('fails on a missing archive without attempting a package installation or network request', async () => {
    const { options, archive } = await fixture();
    fs.unlinkSync(archive);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(prepareWidgetLibraryAssets(options)).rejects.toThrow(
      'Missing cached widget library archive',
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(fs.existsSync(options.outputDirectory)).toBe(false);
  });

  it('checks the npm package identity even when the archive hash matches', async () => {
    const { options } = await fixture(undefined, 'another-package');

    await expect(prepareWidgetLibraryAssets(options)).rejects.toThrow('archive identity mismatch');

    expect(fs.existsSync(options.outputDirectory)).toBe(false);
  });

  it('rejects script bundles that would fetch dynamic module dependencies', async () => {
    const { options } = await fixture('globalThis.d3 = () => import("./missing-module.js");');

    await expect(prepareWidgetLibraryAssets(options)).rejects.toThrow('dynamic import');

    expect(fs.existsSync(options.outputDirectory)).toBe(false);
  });

  it.each(['altered', 'missing', 'unexpected'] as const)(
    'detects %s runtime assets',
    async state => {
      const { options } = await fixture();
      await prepareWidgetLibraryAssets(options);
      const file = path.join(options.outputDirectory, 'libraries/d3-7.9.0.js');
      if (state === 'altered') fs.appendFileSync(file, '\n// changed');
      else if (state === 'missing') fs.unlinkSync(file);
      else
        fs.writeFileSync(
          path.join(options.outputDirectory, 'unregistered.js'),
          'globalThis.extra = true;',
        );

      expect(() =>
        verifyWidgetLibraryAssets(options.outputDirectory, false, { manifest: options.manifest }),
      ).toThrow(state === 'missing' ? 'Missing widget library asset' : 'integrity mismatch');
    },
  );

  it('verifies the actual bytes returned by a reader and rejects unknown resource routes', async () => {
    const { options, library } = await fixture();
    const integrity = await prepareWidgetLibraryAssets(options);
    const entry = integrity.resources[library.resourcePath];
    const body = fs.readFileSync(path.join(options.outputDirectory, entry.file));
    body[0] ^= 1;

    expect(() => verifyWidgetLibraryResource(library.resourcePath, body, integrity)).toThrow(
      'integrity mismatch',
    );
    expect(() => verifyWidgetLibraryResource('/unregistered.js', body, integrity)).toThrow(
      'integrity mismatch',
    );
  });

  it('rejects manifests that could select files outside a package or cache directory', async () => {
    const { options } = await fixture();
    options.manifest.libraries[0].archive = '../outside.tgz';

    await expect(prepareWidgetLibraryAssets(options)).rejects.toThrow(
      'Invalid widget library upstream entry',
    );

    expect(fs.existsSync(options.outputDirectory)).toBe(false);
  });
});
