import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { projectDiagnosticGatewayInfo } from '../../../shared/cowork/diagnostics/diagnosticRuntimeInfo';
import { readDiagnosticRuntimeArtifact } from './runtimeInfo';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});
const rootWith = async (content: string) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-diagnostics-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'runtime-build-info.json'), content);
  return root;
};

it('reads only bounded build identity and excludes paths, timestamps and credential fields', async () => {
  const root = await rootWith(
    JSON.stringify({
      openclawVersion: 'v2026.10.4',
      patchSetSha256: 'A'.repeat(64),
      buildRecipeSha256: 'b'.repeat(64),
      gatewayAsarSha256: 'c'.repeat(64),
      token: 'PRIVATE',
      builtAt: 'PRIVATE',
      runtimeRoot: 'PRIVATE',
    }),
  );
  expect(await readDiagnosticRuntimeArtifact(root)).toEqual({
    version: 'v2026.10.4',
    patchSetSha256: 'a'.repeat(64),
    buildRecipeSha256: 'b'.repeat(64),
    gatewayAsarSha256: 'c'.repeat(64),
  });
});

it('tolerates missing, oversized, malformed and canceled artifact reads', async () => {
  expect(await readDiagnosticRuntimeArtifact(null)).toBeUndefined();
  expect(await readDiagnosticRuntimeArtifact(await rootWith('x'.repeat(65537)))).toBeUndefined();
  expect(await readDiagnosticRuntimeArtifact(await rootWith('{broken'))).toBeUndefined();
  expect(
    await readDiagnosticRuntimeArtifact(await rootWith('{}'), AbortSignal.abort()),
  ).toBeUndefined();
  const root = await rootWith('{}');
  await fs.unlink(path.join(root, 'runtime-build-info.json'));
  expect(await readDiagnosticRuntimeArtifact(root)).toBeUndefined();
});

it('projects only valid handshake version, protocol and build hashes', () => {
  expect(
    projectDiagnosticGatewayInfo({
      protocol: 3,
      server: { version: '2026.10.4', buildId: 'abc1234', connId: 'PRIVATE', bootId: 'PRIVATE' },
      auth: { token: 'PRIVATE' },
    }),
  ).toEqual({ version: '2026.10.4', protocol: 3, buildId: 'abc1234' });
  expect(
    Object.values(
      projectDiagnosticGatewayInfo({
        protocol: -1,
        server: { version: 'PRIVATE', buildId: 'PRIVATE' },
      }),
    ).filter(Boolean),
  ).toEqual([]);
});
