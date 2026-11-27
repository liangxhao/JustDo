import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

const { includeEditorAsset, packPublicAssets, verifyDrawioAssets } = require('../scripts/prepare.cjs');
const upstream = require('../upstream.json');

it('filters Java-server files and source maps before closing the editor asset manifest', () => {
  for (const file of ['WEB-INF', 'WEB-INF/lib/server.jar', 'META-INF/manifest.xml', 'service-worker.js.map'])
    expect(includeEditorAsset(file), file).toBe(false);
  for (const file of ['', 'index.html', 'js/app.min.js', 'math4/es5/drawio-mathjax.min.js', 'README.md', 'licenses/LICENSE'])
    expect(includeEditorAsset(file), file).toBe(true);
});
it('rejects missing, changed, extra and unpinned packaged diagram assets', async () => {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-integrity-'));
  const directory = path.join(staging, 'assets');
  const publicSource = path.join(staging, 'public');
  const names = [
    'server.cjs',
    'editor-resource.cjs',
    'app.js',
    'app.css',
    'LICENSE',
  ];
  const files: Record<string, string> = {};
  try {
    for (const name of names) {
      const file = path.join(directory, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'fixture');
      files[name] = createHash('sha256').update('fixture').digest('hex');
    }
    for (const name of ['editor/index.html', 'editor/js/app.min.js']) {
      const file = path.join(publicSource, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'fixture');
    }
    const archive = path.join(directory, 'public.pack');
    const publicFiles = await packPublicAssets(publicSource, archive);
    files['public.pack'] = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    const writeManifest = (commit = upstream.commit) =>
      fs.writeFileSync(
        path.join(directory, 'integrity.json'),
        JSON.stringify({ commit, files, publicFiles }),
      );
    writeManifest();
    expect(() => verifyDrawioAssets(directory, false)).not.toThrow();
    const index = publicFiles['editor/index.html'];
    publicFiles['editor/index.html'] = { ...index, offset: index.offset + 1 };
    writeManifest();
    expect(() => verifyDrawioAssets(directory, false)).toThrow('archive member integrity mismatch');
    publicFiles['editor/index.html'] = index;
    writeManifest();
    fs.writeFileSync(path.join(directory, 'app.js'), 'changed');
    expect(() => verifyDrawioAssets(directory, false)).toThrow('integrity mismatch');
    fs.writeFileSync(path.join(directory, 'app.js'), 'fixture');
    fs.writeFileSync(path.join(directory, 'extra.js'), 'unexpected');
    expect(() => verifyDrawioAssets(directory, false)).toThrow('integrity mismatch');
    fs.unlinkSync(path.join(directory, 'extra.js'));
    fs.unlinkSync(path.join(directory, 'LICENSE'));
    expect(() => verifyDrawioAssets(directory, false)).toThrow('Missing');
    writeManifest('unknown');
    expect(() => verifyDrawioAssets(directory, false)).toThrow('stale');
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
});
