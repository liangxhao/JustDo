import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPackage } from '@electron/asar';
import { expect, test } from 'vitest';

test.each(['locked', 'linked'])('verifies notices after dependency hoisting: %s', async layout => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hoisted-legal-'));
  const source = path.join(root, 'source');
  const staged = path.join(root, 'staged');
  try {
    const original = layout === 'locked'
      ? 'node_modules/npm/node_modules/fixture'
      : 'node_modules/.linked-dependencies/node_modules/fixture';
    fs.mkdirSync(path.join(source, original), { recursive: true });
    fs.writeFileSync(
      path.join(source, original, 'package.json'),
      '{"name":"fixture","version":"1.0.0","scripts":{"test":"unused"},"keywords":["unused"],"bugs":"unused"}',
    );
    fs.writeFileSync(path.join(source, original, 'LICENSE'), 'source notice');
    fs.writeFileSync(
      path.join(source, 'package-lock.json'),
      JSON.stringify({ packages: layout === 'locked' ? { [original]: { version: '1.0.0' } } : {} }),
    );
    fs.cpSync(path.join(source, original), path.join(staged, 'node_modules/fixture'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(staged, 'node_modules/fixture/package.json'),
      JSON.stringify({ name: 'fixture', version: '1.0.0' }, null, 2),
    );
    const archive = path.join(root, 'app.asar');
    await createPackage(staged, archive);
    await expect(verifyPackagedApplicationLegalMetadata(archive, source)).resolves.toBe(1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const { verifyPackagedApplicationLegalMetadata } =
  require('../../scripts/packaging/electron-builder-hooks.cjs') as {
    verifyPackagedApplicationLegalMetadata: (archive: string, source: string) => Promise<number>;
  };

test.each(['complete', 'missing', 'changed'])(
  'checks actual packaged dependency notices: %s',
  async state => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packaged-legal-'));
    const source = path.join(root, 'source');
    const staged = path.join(root, 'staged');
    try {
      const files = [
        'LICENSE',
        'node_modules/fixture/package.json',
        'node_modules/fixture/LICENSE.txt',
        'node_modules/fixture/THIRD_PARTY_NOTICES/vendor.txt',
        'node_modules/@scope/fixture/package.json',
        'node_modules/@scope/fixture/COPYING',
      ];
      for (const file of files) {
        const target = path.join(source, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.endsWith('.json') ? '{}' : 'license text');
      }
      fs.cpSync(source, staged, { recursive: true });
      const notice = path.join(staged, 'node_modules/fixture/THIRD_PARTY_NOTICES/vendor.txt');
      if (state === 'missing') fs.rmSync(notice);
      if (state === 'changed') fs.writeFileSync(notice, 'different text');
      const archive = path.join(root, 'app.asar');
      await createPackage(staged, archive);
      if (state === 'complete')
        await expect(verifyPackagedApplicationLegalMetadata(archive, source)).resolves.toBe(4);
      else
        await expect(verifyPackagedApplicationLegalMetadata(archive, source)).rejects.toThrow(
          /THIRD_PARTY_NOTICES\/vendor.txt/,
        );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
