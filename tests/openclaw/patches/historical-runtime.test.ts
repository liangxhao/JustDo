import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { admitHistoricalRuntime } from './historical-runtime';

const roots: string[] = [];
function runtime(version?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-version-admission-'));
  roots.push(root);
  if (version) fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'openclaw', version }));
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('runtime-version-admission-'))
      throw new Error('Invalid historical runtime fixture cleanup');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('historical runtime evidence admission', () => {
  it('admits only the matching historical package', () => {
    const source = runtime('2026.10.6');
    expect(admitHistoricalRuntime(source, '2026.10.6', {})).toBe(source);
    expect(admitHistoricalRuntime(source, '2026.10.4', {})).toBeUndefined();
  });

  it('does not execute the current default artifact as historical evidence', () => {
    expect(admitHistoricalRuntime(runtime('2026.10.7'), '2026.10.6', {})).toBeUndefined();
    expect(admitHistoricalRuntime(runtime(), '2026.10.6', {})).toBeUndefined();
  });

  it.each(['OPENCLAW_RUNTIME_DIR', 'OPENCLAW_PRISTINE_DIR', 'JUSTDO_EXECUTION_PRISTINE_DIR', 'OPENCLAW_TEST_NATIVE_RUNTIME_DIR'])
    ('rejects an explicitly supplied wrong version through %s', key => {
      const source = runtime('2026.10.7');
      expect(() => admitHistoricalRuntime(source, '2026.10.6', { [key]: source }))
        .toThrow('Historical runtime admission failed');
    });

  it('rejects missing and malformed explicitly supplied metadata', () => {
    const source = runtime();
    const environment = { OPENCLAW_RUNTIME_DIR: source };
    expect(() => admitHistoricalRuntime(source, '2026.10.6', environment)).toThrow();
    fs.writeFileSync(path.join(source, 'package.json'), '{');
    expect(() => admitHistoricalRuntime(source, '2026.10.6', environment)).toThrow();
  });

  it('admits the explicit Gateway bundle only through its matching package owner', () => {
    const source = runtime('2026.10.7');
    const bundle = path.join(source, 'gateway-bundle.mjs');
    fs.writeFileSync(bundle, 'export {};');
    const environment = { GOAL_CONTINUATION_BUNDLE_FILE: bundle };
    expect(() => admitHistoricalRuntime(source, '2026.10.6', environment)).toThrow();
    expect(admitHistoricalRuntime(source, '2026.10.7', environment)).toBe(source);
    expect(() => admitHistoricalRuntime(source, '2026.10.7', {
      GOAL_CONTINUATION_BUNDLE_FILE: path.join(source, 'missing-bundle.mjs'),
    })).toThrow();
  });
});
