import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

const patch = require('../../../../scripts/patches/v2026.9.8/037-terminal-product-banner.cjs');
const { CONTRACT, NATIVE_BODY, transform } = patch.__testing;
const native = `function composeTerminalIntroBanner() { ${NATIVE_BODY} }`;
const render = (source: string) => vm.runInNewContext(`${source}; composeTerminalIntroBanner();`);

describe('product terminal welcome', () => {
  it.each(['LocalDesk', 'Assistant'])('uses productName %s and preserves terminal spacing and ANSI theme colors', brand => {
    const patched = transform(native, brand, 'native.mjs');
    expect(render(patched)).toBe(`\r\n\x1b[33mWelcome to the ${brand}.\x1b[0m\r\n\r\n`);
    expect(patched).not.toContain('Welcome to the Claw');
    expect(patched).not.toContain('TERMINAL_INTRO_ART');
    expect(transform(patched, brand, 'native.mjs')).toBe(patched);
    const compiled = transformSync(patched, { minifySyntax: true, legalComments: 'none' }).code;
    expect(transform(compiled, brand, 'gateway-bundle.mjs')).toBe(compiled);
    expect(render(compiled)).toBe(render(patched));
  });

  it('rejects invalid product metadata and old or partial intros instead of updating them', () => {
    for (const brand of ['', 'Name\nInjected', 'Name\x1b[2J', 'CON'])
      expect(() => transform(native, brand, 'native.mjs')).toThrow(/productName/);
    const patched = transform(native, 'LocalDesk', 'native.mjs');
    for (const source of [
      patched.replace(CONTRACT, CONTRACT.replace('V2026_9_8', 'V2026_9_6')),
      patched.replace('Welcome to the LocalDesk.', 'Welcome to the OtherDesk.'),
      patched.replace(`// ${CONTRACT}\n`, ''),
      `// ${CONTRACT}\n${native}`,
      native.replace('Welcome to the Claw.', 'Unexpected native intro'),
    ]) expect(() => transform(source, 'LocalDesk', 'native.mjs')).toThrow();
    expect(() => transform(patched, 'OtherDesk', 'native.mjs')).toThrow(/pristine/);
  });

  it('reads the build repository metadata and checks every copy before writing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-brand-test-'));
    try {
      const dist = path.join(root, 'dist');
      fs.mkdirSync(dist);
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ productName: 'LocalDesk' }));
      const manager = path.join(dist, 'manager.mjs');
      const recovery = path.join(dist, 'recovery.mjs');
      const nativeWorker = transformSync(native, { minifySyntax: true, minifyWhitespace: true }).code;
      for (const name of ['worker.mjs', 'sqlite-store.worker.mjs'])
        fs.writeFileSync(path.join(dist, name), nativeWorker);
      fs.writeFileSync(manager, native);
      fs.writeFileSync(recovery, native.replace('Welcome to the Claw.', 'Changed upstream'));
      expect(() => patch.applyPatch(root, { repoRoot: root })).toThrow();
      expect(fs.readFileSync(manager, 'utf8')).toBe(native);
      fs.writeFileSync(recovery, native);
      expect(patch.applyPatch(root, { repoRoot: root })).toHaveLength(4);
      expect(render(fs.readFileSync(manager, 'utf8'))).toContain('Welcome to the LocalDesk.');
      expect(patch.verifyPatch(root, { repoRoot: root })).toEqual([]);
      expect(patch.applyPatch(root, { repoRoot: root })).toEqual([]);
      fs.writeFileSync(recovery, native);
      expect(() => patch.applyPatch(root, { repoRoot: root })).toThrow(/Mixed pristine/);
      fs.writeFileSync(recovery, fs.readFileSync(manager));
      fs.writeFileSync(path.join(root, 'gateway-bundle.mjs'), transformSync(
        fs.readFileSync(manager, 'utf8'), { legalComments: 'none' },
      ).code);
      expect(patch.verifyPatch(root, { repoRoot: root })).toEqual([]);
      fs.writeFileSync(path.join(root, 'gateway-bundle.mjs'), native);
      expect(() => patch.verifyPatch(root, { repoRoot: root })).toThrow(/missing/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
