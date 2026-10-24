import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { verifyCollaborationExtensionAssembly } from './extension-assembly-contract.mjs';

const runtime = process.env.OPENCLAW_TEST_NATIVE_RUNTIME_DIR;
if (process.env.OPENCLAW_REQUIRE_MANAGEMENT_CONTRACTS === '1' && !runtime)
  throw new Error('The collaboration assembly controls require the selected frozen runtime.');
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

test.skipIf(!runtime)('assembly rejects output drift, unrecorded files and incomplete source receipts', () => {
  const admitted = verifyCollaborationExtensionAssembly(runtime!);
  const fixtureParent = fs.realpathSync(os.tmpdir());
  const fixture = fs.mkdtempSync(path.join(fixtureParent, 'extension-assembly-'));
  const receiptFile = path.join(fixture, 'extension-assembly-receipt.json');
  try {
    // Only the helper's source/output binding is under test. These synthetic
    // core bytes are deliberately not a valid frozen Gateway admission.
    const manifest = fs.readFileSync(path.join(runtime!, 'runtime-patch-manifest.json'));
    const core = JSON.parse(manifest.toString());
    fs.writeFileSync(path.join(fixture, 'runtime-patch-manifest.json'), manifest);
    for (const file of ['gateway-bundle.mjs', 'gateway.asar'])
      fs.writeFileSync(path.join(fixture, file), 'synthetic core fixture');
    for (const entry of admitted.entries) {
      const destination = path.join(fixture, entry.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(runtime!, entry.path), destination);
    }
    expect(verifyCollaborationExtensionAssembly(fixture).assemblySha256).toBe(admitted.assemblySha256);
    const receipt = {
      formatVersion: 1,
      core: {
        manifestSha256: hash(manifest), buildRecipeSha256: core.buildRecipeSha256,
        patchSetSha256: core.patchSetSha256,
        gatewayBundleSha256: hash('synthetic core fixture'), gatewayAsarSha256: hash('synthetic core fixture'),
      },
      sources: admitted.sources,
      outputs: admitted.entries.map(({ path: relative, sha256 }: { path: string; sha256: string }) => ({ path: relative, sha256 })),
      tools: [{ path: 'package.json', sha256: hash(fs.readFileSync('package.json')) }],
      extensions: Object.fromEntries(admitted.entries.map(({ id, path: entry, sha256 }: { id: string; path: string; sha256: string }) =>
        [id, { entry, sha256 }])),
    };
    const writeReceipt = (value: unknown) => fs.writeFileSync(receiptFile, JSON.stringify(value));
    writeReceipt(receipt);
    expect(verifyCollaborationExtensionAssembly(fixture).receiptSha256).toBeTruthy();

    const extra = path.join(fixture, 'dist/extensions/unrecorded.js');
    fs.writeFileSync(extra, 'unrecorded');
    expect(() => verifyCollaborationExtensionAssembly(fixture)).toThrow(/complete extension output inventory/);
    fs.unlinkSync(extra);
    writeReceipt({ ...receipt, sources: receipt.sources.slice(1) });
    expect(() => verifyCollaborationExtensionAssembly(fixture)).toThrow(/complete current production source closure/);
    writeReceipt({ ...receipt, core: { ...receipt.core, manifestSha256: 'wrong' } });
    expect(() => verifyCollaborationExtensionAssembly(fixture)).toThrow();
    writeReceipt(receipt);
    fs.appendFileSync(path.join(fixture, admitted.entries[0].path), '\n// changed output');
    expect(() => verifyCollaborationExtensionAssembly(fixture)).toThrow(/does not match the production source closure/);
  } finally {
    expect(path.dirname(fs.realpathSync(fixture))).toBe(fixtureParent);
    expect(path.basename(fixture)).toMatch(/^extension-assembly-.+/);
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}, 30_000);
