import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { list } from 'tar';
import { expect, it } from 'vitest';

const { packMultipleSources } = require('../../scripts/openclaw/pack-openclaw-tar.cjs');
it('keeps the closed draw.io asset set while generic package pruning remains active', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-tar-'));
  const runtime = path.join(directory, 'runtime');
  const assetPrefix = 'dist/extensions/drawio/assets/';
  const files = [
    'LICENSE',
    'licenses/sdk/LICENSE',
    'public/editor/README.md',
    'public/editor/js/source.map',
    'public/editor/test/local.js',
  ];
  try {
    for (const file of [
      ...files.map(file => assetPrefix + file),
      'dist/extensions/drawio/skills/drawio-diagrams/SKILL.md',
      'node_modules/example/README.md',
      'node_modules/fixture/examples/demo.js',
    ]) {
      const destination = path.join(runtime, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, 'fixture');
    }
    const archive = path.join(directory, 'runtime.tar');
    packMultipleSources([{ dir: runtime, prefix: 'cfmind' }], archive);
    const entries: string[] = [];
    list({ file: archive, sync: true, onReadEntry: entry => entries.push(entry.path) });
    for (const file of files) expect(entries).toContain('cfmind/' + assetPrefix + file);
    expect(entries).toContain('cfmind/dist/extensions/drawio/skills/drawio-diagrams/SKILL.md');
    expect(entries).toContain('cfmind/node_modules/example/README.md');
    expect(entries).not.toContain('cfmind/node_modules/fixture/examples/demo.js');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it('copies the complete editor separately from generic macOS and Linux filters', () => {
  const config = JSON.parse(fs.readFileSync(path.resolve('electron-builder.json'), 'utf8'));
  for (const target of ['mac', 'linux']) {
    expect(config[target].extraResources).toContainEqual({
      from: 'vendor/openclaw-runtime/current/dist/extensions/drawio/assets',
      to: 'cfmind/dist/extensions/drawio/assets',
      filter: ['**/*'],
    });
  }
});
