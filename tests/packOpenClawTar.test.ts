import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { list as listTar } from 'tar';
import { expect, test } from 'vitest';

const { packMultipleSources } = require('../scripts/pack-openclaw-tar.cjs') as {
  packMultipleSources: (
    sources: Array<{ dir: string; prefix: string; exclude?: string[] }>,
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
