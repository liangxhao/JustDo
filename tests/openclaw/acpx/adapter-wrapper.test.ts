import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

import { transformSync } from 'esbuild';
import ts from 'typescript';
import { afterEach, expect, test } from 'vitest';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

const sourcePath = path.resolve('openclaw-extensions/acpx/src/codex-auth-bridge.ts');
const source = ts.createSourceFile(sourcePath, fs.readFileSync(sourcePath, 'utf8'), ts.ScriptTarget.Latest, true);
const builder = source.statements.find(statement =>
  ts.isFunctionDeclaration(statement) && statement.name?.text === 'buildAdapterWrapperScript',
);
const buildWrapper = vm.runInNewContext(
  transformSync(`${builder!.getText(source)}; buildAdapterWrapperScript`, { loader: 'ts' }).code,
  {
    quoteCommandPart: JSON.stringify,
    OPENCLAW_ACPX_LEASE_ID_ARG: '--openclaw-acpx-lease-id',
    OPENCLAW_GATEWAY_INSTANCE_ID_ARG: '--openclaw-gateway-instance-id',
    RUN_CONFIGURED_COMMAND_SENTINEL: '--openclaw-run-configured',
    renderDiagnosticRedactionRuleSpecs: () => '[]',
  },
) as (params: { displayName: string; installedBinPath: string; envSetup: string }) => string;

test.each(['missing', 'bundled', 'configured'])('launches the %s adapter without a runtime download', mode => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acpx-wrapper-'));
  roots.push(root);
  const adapter = path.join(root, 'adapter.mjs');
  fs.writeFileSync(adapter, 'console.log("local adapter launched");');
  const wrapper = path.join(root, 'wrapper.mjs');
  fs.writeFileSync(wrapper, buildWrapper({
    displayName: 'Test',
    installedBinPath: mode === 'bundled' ? adapter : path.join(root, 'removed-capture.mjs'),
    envSetup: 'const env = { ...process.env };',
  }));
  const result = spawnSync(process.execPath, [wrapper,
    ...(mode === 'configured' ? ['--openclaw-run-configured', process.execPath, adapter] : []),
  ], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  if (mode === 'missing') {
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('bundled Test ACP adapter is missing');
    expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
  } else {
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('local adapter launched');
  }
});
