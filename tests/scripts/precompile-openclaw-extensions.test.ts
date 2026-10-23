import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

const { precompileOpenClawExtensions } =
  require('../../scripts/openclaw/precompile-openclaw-extensions.cjs') as {
    precompileOpenClawExtensions: (
      runtimeRoot: string,
      options: { required: boolean },
    ) => Promise<{
      compiled: number;
      errors: number;
    }>;
  };
const { bundleProductExtension } =
  require('../../scripts/openclaw/sync-openclaw-runtime-resources.cjs') as {
    bundleProductExtension: (sourceDir: string, targetDir: string) => void;
  };

test('keeps CUA native SDK and image loaders external when precompiling its TypeScript entry', async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-cua-compile-'));
  const pluginRoot = path.join(runtimeRoot, 'dist', 'extensions', 'cua-computer');
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, 'package.json'),
      JSON.stringify({
        type: 'module',
        openclaw: { extensions: ['./index.ts'] },
      }),
    );
    fs.writeFileSync(
      path.join(pluginRoot, 'index.ts'),
      [
        "import { registerComputerUseProvider } from 'openclaw/plugin-sdk/computer-use';",
        "import { CuaDriver } from '@trycua/cua-driver';",
        "import * as rastermill from 'rastermill';",
        'export default { registerComputerUseProvider, CuaDriver, rastermill };',
      ].join('\n'),
    );

    const result = await precompileOpenClawExtensions(runtimeRoot, { required: true });

    expect(result).toMatchObject({ compiled: 1, errors: 0 });
    const compiled = fs.readFileSync(path.join(pluginRoot, 'index.js'), 'utf8');
    expect(compiled).toContain('from "openclaw/plugin-sdk/computer-use"');
    expect(compiled).toContain('from "@trycua/cua-driver"');
    expect(compiled).toContain('from "rastermill"');
    expect(
      JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8')),
    ).toMatchObject({ openclaw: { extensions: ['./index.js'] } });
  } finally {
    log.mockRestore();
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test('leaves compiled upstream worker build hints untouched when their original TS source is not published', async () => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-worker-hint-'));
  const pluginRoot = path.join(runtimeRoot, 'dist/extensions/code-mode-quickjs');
  const metadata = {
    type: 'module',
    openclaw: {
      extensions: ['./index.js'],
      build: { workerEntries: ['./src/code-mode.worker.ts'] },
    },
  };
  try {
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'package.json'), JSON.stringify(metadata));
    fs.writeFileSync(path.join(pluginRoot, 'index.js'), 'export default {};');
    expect(await precompileOpenClawExtensions(runtimeRoot, { required: true })).toMatchObject({
      compiled: 0,
      skipped: 1,
      errors: 0,
    });
    expect(JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'))).toEqual(
      metadata,
    );
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test.each(['precompile', 'sync'] as const)(
  'cold loads real MCP registration, schema validation and stdio client after %s without external npm dependencies',
  async mode => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'external-mcp-compile-'));
    const pluginRoot = path.join(runtimeRoot, 'dist/extensions/runtime-services');
    const sourceRoot =
      mode === 'sync' ? path.join(runtimeRoot, 'source/runtime-services') : pluginRoot;
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      fs.mkdirSync(pluginRoot, { recursive: true });
      fs.mkdirSync(sourceRoot, { recursive: true });
      const packageJson = JSON.parse(
        fs.readFileSync(path.resolve('plugins/extensions/runtime-services/package.json'), 'utf8'),
      );
      // This required plugin must not start a second npm installation chain.
      expect(packageJson.dependencies).toBeUndefined();
      fs.writeFileSync(path.join(sourceRoot, 'package.json'), JSON.stringify(packageJson));
      const entry = path.resolve('plugins/extensions/runtime-services/external-mcp/index.ts');
      fs.writeFileSync(
        path.join(sourceRoot, 'index.ts'),
        `export { registerExternalMcp } from ${JSON.stringify(entry)};`,
      );
      fs.copyFileSync(
        path.resolve('plugins/extensions/runtime-services/openclaw.plugin.json'),
        path.join(pluginRoot, 'openclaw.plugin.json'),
      );
      if (mode === 'sync') bundleProductExtension(sourceRoot, pluginRoot);
      expect(await precompileOpenClawExtensions(runtimeRoot, { required: true })).toMatchObject({
        compiled: mode === 'precompile' ? 1 : 0,
        errors: 0,
      });
      expect(
        JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8')).openclaw
          .extensions,
      ).toEqual(['./index.js']);
      // Production keeps the native SDK external. Replace only that boundary in
      // this fixture; no MCP/Ajv package may resolve from a parent's node_modules.
      const sdkRoot = path.join(runtimeRoot, 'node_modules/openclaw');
      fs.mkdirSync(sdkRoot, { recursive: true });
      fs.writeFileSync(
        path.join(sdkRoot, 'package.json'),
        JSON.stringify({
          type: 'module',
          exports: {
            './plugin-sdk/session-store-runtime': './session.mjs',
            './plugin-sdk/process-runtime': './process.mjs',
          },
        }),
      );
      fs.writeFileSync(
        path.join(sdkRoot, 'session.mjs'),
        'export const getSessionEntry = () => globalThis.externalMcpColdSession;',
      );
      fs.writeFileSync(
        path.join(sdkRoot, 'process.mjs'),
        [
          'export function isPidDefinitelyDead(pid) {',
          "  try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }",
          '}',
          'export function signalProcessTree(pid, signal, options) {',
          '  try { process.kill(pid, signal); } catch {}',
          '  options.onComplete();',
          '}',
        ].join('\n'),
      );
      const fixtures = path.resolve('plugins/extensions/runtime-services/tests/fixtures');
      const output = execFileSync(
        process.execPath,
        [
          path.join(fixtures, 'external-mcp-cold-start.mjs'),
          path.join(pluginRoot, 'index.js'),
          runtimeRoot,
          path.join(fixtures, 'external-mcp-server.cjs'),
          path.join(pluginRoot, 'openclaw.plugin.json'),
        ],
        { encoding: 'utf8', timeout: 15_000, windowsHide: true },
      );
      expect(output.trim()).toBe('registered schema-approved stdio-called closed');
      expect(fs.existsSync(path.join(pluginRoot, 'node_modules'))).toBe(false);
      expect(fs.readdirSync(path.join(runtimeRoot, 'node_modules'))).toEqual(['openclaw']);
    } finally {
      log.mockRestore();
      fs.rmSync(runtimeRoot, { recursive: true, force: true });
    }
  },
);
