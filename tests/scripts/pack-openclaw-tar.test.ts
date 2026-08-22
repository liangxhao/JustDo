import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { list as listTar } from 'tar';
import { expect, test } from 'vitest';

const { packMultipleSources } = require('../../scripts/pack-openclaw-tar.cjs') as {
  packMultipleSources: (
    sources: Array<{
      dir: string;
      prefix: string;
      exclude?: string[];
      preservePythonLicenses?: boolean;
    }>,
    outputTar: string,
  ) => void;
};

test('omits source-specific duplicate artifacts without removing runtime entries', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-runtime-tar-'));
  const runtimeRoot = path.join(tempRoot, 'runtime');
  const archivePath = path.join(tempRoot, 'runtime.tar');

  try {
    fs.mkdirSync(path.join(runtimeRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(runtimeRoot, 'gateway.asar'), 'duplicate', 'utf8');
    fs.writeFileSync(path.join(runtimeRoot, 'gateway-bundle.mjs'), 'bundle', 'utf8');
    fs.writeFileSync(path.join(runtimeRoot, 'dist', 'entry.js'), 'entry', 'utf8');

    packMultipleSources(
      [{ dir: runtimeRoot, prefix: 'cfmind', exclude: ['gateway.asar'] }],
      archivePath,
    );

    const entries: string[] = [];
    listTar({
      file: archivePath,
      sync: true,
      onReadEntry: entry => entries.push(entry.path.replace(/\\/g, '/')),
    });

    expect(entries).toContain('cfmind/gateway-bundle.mjs');
    expect(entries).toContain('cfmind/dist/entry.js');
    expect(entries).not.toContain('cfmind/gateway.asar');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('preserves Python runtime and distribution licenses', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-python-license-tar-'));
  const pythonRoot = path.join(tempRoot, 'python-win');
  const distInfoRoot = path.join(
    pythonRoot,
    'Lib',
    'bundled-site-packages',
    'requests-2.34.2.dist-info',
  );
  const archivePath = path.join(tempRoot, 'python.tar');

  try {
    fs.mkdirSync(path.join(distInfoRoot, 'licenses'), { recursive: true });
    fs.writeFileSync(path.join(distInfoRoot, 'licenses', 'LICENSE'), 'license', 'utf8');
    fs.writeFileSync(path.join(distInfoRoot, 'LICENSE.txt'), 'license', 'utf8');
    fs.writeFileSync(path.join(pythonRoot, 'LICENSE.txt'), 'runtime license', 'utf8');

    packMultipleSources(
      [{ dir: pythonRoot, prefix: 'python-win', preservePythonLicenses: true }],
      archivePath,
    );

    const entries: string[] = [];
    listTar({
      file: archivePath,
      sync: true,
      onReadEntry: entry => entries.push(entry.path.replace(/\\/g, '/')),
    });

    expect(entries).toContain(
      'python-win/Lib/bundled-site-packages/requests-2.34.2.dist-info/licenses/LICENSE',
    );
    expect(entries).toContain(
      'python-win/Lib/bundled-site-packages/requests-2.34.2.dist-info/LICENSE.txt',
    );
    expect(entries).toContain('python-win/LICENSE.txt');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
