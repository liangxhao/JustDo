import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test } from 'vitest';

const { verifySnapshotPatchArtifacts } = require('./native-runtime.cjs') as {
  verifySnapshotPatchArtifacts: (root: string) => void;
};
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test.each(['dependency', 'support', 'escape'])(
  'rejects a cached runtime with changed %s despite an unchanged bundle', change => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-runtime-proof-'));
    roots.push(root);
    const artifact = change === 'dependency'
      ? 'node_modules/@openclaw/fs-safe/dist/guarded-mutation.js'
      : 'dist/native-support/plugin-directory-publication.mjs';
    const target = path.join(root, artifact);
    const content = Buffer.from('export const receipt = true;\n');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    fs.writeFileSync(path.join(root, 'gateway-bundle.mjs'), 'const gateway = true;\n');
    const manifest = { patchDependencyArtifacts: [{
      path: artifact,
      size: content.length,
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
    }] };
    fs.writeFileSync(path.join(root, 'runtime-patch-manifest.json'), JSON.stringify(manifest));
    expect(() => verifySnapshotPatchArtifacts(root)).not.toThrow();
    if (change === 'escape') {
      manifest.patchDependencyArtifacts[0].path = '../outside.mjs';
      fs.writeFileSync(path.join(root, 'runtime-patch-manifest.json'), JSON.stringify(manifest));
    } else fs.writeFileSync(target, 'export const receipt = null;\n');
    expect(() => verifySnapshotPatchArtifacts(root)).toThrow();
    expect(fs.readFileSync(path.join(root, 'gateway-bundle.mjs'), 'utf8')).toBe('const gateway = true;\n');
  },
);

test.each(['.openclaw-lifecycle-pending', 'dist/openclaw-install-guard', '.openclaw-lifecycle-lock'])(
  'rejects an incomplete cached package lifecycle: %s', marker => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-runtime-proof-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'runtime-patch-manifest.json'), JSON.stringify({ patchDependencyArtifacts: [] }));
    expect(() => verifySnapshotPatchArtifacts(root)).not.toThrow();
    fs.mkdirSync(path.dirname(path.join(root, marker)), { recursive: true });
    fs.writeFileSync(path.join(root, marker), 'pending');
    expect(() => verifySnapshotPatchArtifacts(root)).toThrow(/lifecycle is incomplete or unsettled/);
  },
);
