import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, it } from 'vitest';

const pristine = process.env.JUSTDO_EXECUTION_PRISTINE_DIR;

it.skipIf(!pristine || process.platform !== 'win32')(
  'native canonical validation keys unify Windows namespace aliases for existing and missing files',
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-readiness-'));
    try {
      const parent = path.join(root, '项目 with spaces');
      fs.mkdirSync(parent);
      const existing = path.join(parent, 'sessions.sqlite');
      fs.writeFileSync(existing, 'identity fixture');
      const dist = path.join(pristine!, 'dist');
      const file = path.join(dist, 'sqlite-worker-identity-BRNRpRyc.mjs');
      const source = fs.readFileSync(file, 'utf8');
      const exported = source.match(/resolveDatabasePathKey as (\w+)/)![1];
      const native = await import(pathToFileURL(file).href);
      for (const target of [existing, path.join(parent, 'missing', 'sessions.sqlite')]) {
        expect(native[exported](target)).toBe(native[exported](path.toNamespacedPath(target)));
      }
      const receipt = fs.readFileSync(path.join(dist, 'openclaw-agent-db-validation-cache-Blfx-KfM.mjs'), 'utf8');
      expect(receipt).toContain('validatedPaths.get(resolveDatabasePathKey(pathname))');
      expect(receipt).toContain('for (const alias of aliases) validatedPaths.set(alias,');
    } finally {
      expect(path.dirname(root)).toBe(os.tmpdir());
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
