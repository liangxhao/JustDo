import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build as esbuild } from 'esbuild';
import { describe, expect, test } from 'vitest';

const patch =
  require('../../../../scripts/patches/v2026.7.1-2/045-openai-stop-tool-call-compat.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    verifyPatch: (runtimeDir: string) => void;
    __testing: {
      isJustDoDispatchableStructuredToolCall: (
        block: { type?: string; id?: string; name?: string },
        rawArguments: unknown,
        allowedToolNames: Set<string>,
      ) => boolean;
      shouldPromoteJustDoStructuredToolCalls: (
        stopReason: string,
        hasToolCalls: boolean,
        hasDispatchableStructuredToolCalls: boolean,
        hasVisibleText: boolean,
        sawStopFinishReason?: boolean,
      ) => boolean;
      transformTransport: (content: string, filePath: string) => string;
      transformBundledAiParser: (content: string, filePath: string) => string;
    };
  };

const terminalPatch =
  require('../../../../scripts/patches/v2026.7.1-2/044-managed-terminal-handoff.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    verifyPatch: (runtimeDir: string) => void;
    __testing: {
      transformTools: (content: string, filePath: string) => string;
      transformEmbeddedAttempt: (content: string, filePath: string) => string;
      transformRegistry: (content: string, filePath: string) => string;
      transformPluginLoader: (content: string, filePath: string) => string;
      transformRuntimePluginInstall: (content: string, filePath: string) => string;
    };
  };

const managedSameRunJoinPatch =
  require('../../../../scripts/patches/v2026.7.1-2/018-managed-same-run-join.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    verifyPatch: (runtimeDir: string) => void;
  };

const managedJoinCommitPatch =
  require('../../../../scripts/patches/v2026.7.1-2/019-managed-join-commits.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    verifyPatch: (runtimeDir: string) => void;
  };

const managedJoinRecoveryPatch =
  require('../../../../scripts/patches/v2026.7.1-2/020-managed-join-recovery.cjs') as {
    applyPatch: (runtimeDir: string) => string[];
    verifyPatch: (runtimeDir: string) => void;
  };

describe('OpenAI stop plus structured tool-call compatibility', () => {
  const block = { type: 'toolCall', id: 'call-1', name: 'sessions_yield' };
  const allowed = new Set(['sessions_yield']);

  test('accepts only complete advertised structured calls', () => {
    const isDispatchable = patch.__testing.isJustDoDispatchableStructuredToolCall;
    expect(isDispatchable(block, '{"message":"wait"}', allowed)).toBe(true);
    for (const raw of ['', '   ', '{"message":', '[]', 'null', undefined])
      expect(isDispatchable(block, raw, allowed)).toBe(false);
    expect(isDispatchable({ ...block, id: '' }, '{}', allowed)).toBe(false);
    expect(isDispatchable({ ...block, name: '' }, '{}', allowed)).toBe(false);
    expect(isDispatchable({ ...block, name: 'unknown_tool' }, '{}', allowed)).toBe(false);
  });

  test('rejects a call whose argument stream becomes invalid after a valid prefix', () => {
    const isDispatchable = patch.__testing.isJustDoDispatchableStructuredToolCall;
    expect(isDispatchable(block, '{}', allowed)).toBe(true);
    expect(isDispatchable(block, '{} trailing garbage', allowed)).toBe(false);
  });

  test('keeps the legacy no-text path but strictly gates the new visible-text path', () => {
    const isDispatchable = patch.__testing.isJustDoDispatchableStructuredToolCall;
    const shouldPromote = patch.__testing.shouldPromoteJustDoStructuredToolCalls;
    const calls = (rawArguments: unknown[], names = rawArguments.map(() => 'sessions_yield')) =>
      rawArguments.map((raw, index) =>
        isDispatchable(
          { ...block, id: `call-${index}`, name: names[index] },
          raw,
          allowed,
        ),
      );
    for (const invalid of ['', '{"message":', undefined]) {
      const dispatchable = calls([invalid]).every(Boolean);
      expect(shouldPromote('stop', true, dispatchable, false)).toBe(true);
      expect(shouldPromote('stop', true, dispatchable, true)).toBe(false);
    }
    expect(shouldPromote('stop', true, calls(['{}'], ['unknown_tool']).every(Boolean), true)).toBe(
      false,
    );
    expect(shouldPromote('stop', true, calls(['{}', '{"message":']).every(Boolean), true)).toBe(
      false,
    );
    expect(shouldPromote('stop', true, calls(['{}']).every(Boolean), true)).toBe(true);
    expect(shouldPromote('stop', true, true, true, false)).toBe(false);
    expect(shouldPromote('toolUse', true, true, true)).toBe(false);
  });

  test('patches both OpenAI parser implementations idempotently', () => {
    const distRoot = path.resolve('vendor/openclaw-runtime/win-x64');
    const transportPath = path.join(distRoot, 'dist', 'openai-transport-stream-B0WkSqXp.js');
    const bundlePath = path.join(distRoot, 'gateway-bundle.mjs');
    const transport = fs.readFileSync(transportPath, 'utf8');
    const bundle = fs.readFileSync(bundlePath, 'utf8');

    const transformedTransport = patch.__testing.transformTransport(transport, transportPath);
    const transformedBundle = patch.__testing.transformBundledAiParser(bundle, bundlePath);
    expect(transformedTransport).toContain('hasJustDoDispatchableStructuredToolCalls');
    expect(transformedTransport).toContain('options?.allowedToolNames');
    expect(transformedBundle).toContain('hasJustDoAiDispatchableStructuredToolCalls');
    expect(transformedBundle).toContain('block3.partialArgs === void 0');
    expect(transformedBundle).toContain('justDoAiStructuredToolCallArguments.get(block3)');
    expect(patch.__testing.transformTransport(transformedTransport, transportPath)).toBe(
      transformedTransport,
    );
    expect(patch.__testing.transformBundledAiParser(transformedBundle, bundlePath)).toBe(
      transformedBundle,
    );
  });

  test('applies and verifies the copied runtime target subset idempotently', () => {
    const sourceRoot = path.resolve('vendor/openclaw-runtime/win-x64');
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-openai-stop-patch-'));
    const fixtureDist = path.join(fixtureRoot, 'dist');
    fs.mkdirSync(fixtureDist, { recursive: true });
    fs.copyFileSync(
      path.join(sourceRoot, 'dist', 'openai-transport-stream-B0WkSqXp.js'),
      path.join(fixtureDist, 'openai-transport-stream-B0WkSqXp.js'),
    );
    fs.copyFileSync(
      path.join(sourceRoot, 'gateway-bundle.mjs'),
      path.join(fixtureRoot, 'gateway-bundle.mjs'),
    );
    try {
      const source = fs.readFileSync(
        path.join(fixtureDist, 'openai-transport-stream-B0WkSqXp.js'),
        'utf8',
      );
      const bundle = fs.readFileSync(path.join(fixtureRoot, 'gateway-bundle.mjs'), 'utf8');
      const transportContracts = [
        'function isJustDoDispatchableStructuredToolCall(',
        'function shouldPromoteJustDoStructuredToolCalls(',
        'allowedToolNames: new Set((params.tools ?? [])',
        'hasJustDoDispatchableStructuredToolCalls',
      ];
      const bundledAiContracts = [
        'const justDoAiAllowedToolNames = new Set((params.tools ?? [])',
        'const justDoAiStructuredToolCallArguments = /* @__PURE__ */ new WeakMap();',
        'recordJustDoAiStructuredToolCallArguments(block3);',
        'hasJustDoAiDispatchableStructuredToolCalls',
      ];
      const expectedChanged = [
        ...(transportContracts.every(contract => source.includes(contract)) &&
        source.includes('JUSTDO_OPENAI_STOP_TOOL_CALL_COMPAT_V2026_7_1_2')
          ? []
          : [path.join('dist', 'openai-transport-stream-B0WkSqXp.js')]),
        ...(transportContracts.every(contract => bundle.includes(contract)) &&
        bundledAiContracts.every(contract => bundle.includes(contract))
          ? []
          : ['gateway-bundle.mjs']),
      ];
      expect(patch.applyPatch(fixtureRoot).sort()).toEqual(expectedChanged.sort());
      expect(() => patch.verifyPatch(fixtureRoot)).not.toThrow();
      expect(patch.applyPatch(fixtureRoot)).toEqual([]);
      expect(() => patch.verifyPatch(fixtureRoot)).not.toThrow();
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 60_000);

  test('recognizes source patches after a real esbuild bundle and completes the fresh pass', async () => {
    const runtimeRoot = path.resolve('vendor/openclaw-runtime/win-x64');
    const distRoot = path.join(runtimeRoot, 'dist');
    const gatewayEntry = path.join(distRoot, 'gateway-entry.js');
    const entryPoint = fs.existsSync(gatewayEntry) ? gatewayEntry : path.join(distRoot, 'entry.js');
    const sourceTransforms = new Map<string, (content: string, filePath: string) => string>([
      ['openclaw-tools-KulZ1cdH.js', terminalPatch.__testing.transformTools],
      ['selection-JInn13lc.js', terminalPatch.__testing.transformEmbeddedAttempt],
      ['subagent-registry-DexSZ4w1.js', terminalPatch.__testing.transformRegistry],
      ['loader-D8d2EvVh.js', terminalPatch.__testing.transformPluginLoader],
      [
        'runtime-plugin-install-DIbOhSHk.js',
        terminalPatch.__testing.transformRuntimePluginInstall,
      ],
      ['openai-transport-stream-B0WkSqXp.js', patch.__testing.transformTransport],
      ['attempt.model-diagnostic-events-CfZQM0hs.js', content => content],
      ['provider-capabilities-CYpG67go.js', content => content],
    ]);
    const transformedSources = new Map<string, string>();
    for (const [name, transform] of sourceTransforms) {
      const filePath = path.join(distRoot, name);
      transformedSources.set(name, transform(fs.readFileSync(filePath, 'utf8'), filePath));
    }
    const build = await esbuild({
      entryPoints: [entryPoint],
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
      external: [
        'sharp',
        '@img/*',
        '@lydell/*',
        '@mariozechner/*',
        '@napi-rs/*',
        '@snazzah/*',
        'koffi',
        'electron',
        'node-llama-cpp',
        'ffmpeg-static',
        'chromium-bidi',
        'playwright-core',
        'playwright',
        'better-sqlite3',
        'jiti',
      ],
      logLevel: 'silent',
      plugins: [
        {
          name: 'justdo-patched-source-fixture',
          setup(buildApi) {
            buildApi.onLoad({ filter: /\.js$/ }, args => {
              const transformed = transformedSources.get(path.basename(args.path));
              return transformed === undefined ? null : { contents: transformed, loader: 'js' };
            });
          },
        },
      ],
    });
    const bundled = build.outputFiles[0].text;
    expect(bundled).not.toContain('JUSTDO_OPENAI_STOP_TOOL_CALL_COMPAT_V2026_7_1_2');
    expect(bundled).toContain('hasJustDoDispatchableStructuredToolCalls');
    expect(
      terminalPatch.__testing.transformRuntimePluginInstall(bundled, 'gateway-bundle.mjs'),
    ).toBe(bundled);
    expect(patch.__testing.transformTransport(bundled, 'gateway-bundle.mjs')).toBe(bundled);

    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-real-esbuild-patches-'));
    const fixtureDist = path.join(fixtureRoot, 'dist');
    fs.mkdirSync(fixtureDist, { recursive: true });
    for (const [name, content] of transformedSources)
      fs.writeFileSync(path.join(fixtureDist, name), content);
    fs.writeFileSync(path.join(fixtureRoot, 'gateway-bundle.mjs'), bundled);
    try {
      expect(managedSameRunJoinPatch.applyPatch(fixtureRoot)).toEqual([]);
      expect(() => managedSameRunJoinPatch.verifyPatch(fixtureRoot)).not.toThrow();
      expect(managedJoinCommitPatch.applyPatch(fixtureRoot)).toEqual([]);
      expect(() => managedJoinCommitPatch.verifyPatch(fixtureRoot)).not.toThrow();
      expect(managedJoinRecoveryPatch.applyPatch(fixtureRoot)).toEqual([]);
      expect(() => managedJoinRecoveryPatch.verifyPatch(fixtureRoot)).not.toThrow();
      expect(terminalPatch.applyPatch(fixtureRoot)).toEqual([]);
      expect(() => terminalPatch.verifyPatch(fixtureRoot)).not.toThrow();
      expect(patch.applyPatch(fixtureRoot)).toEqual(['gateway-bundle.mjs']);
      expect(() => patch.verifyPatch(fixtureRoot)).not.toThrow();
      expect(patch.applyPatch(fixtureRoot)).toEqual([]);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  }, 60_000);

  test('runs the authoritative bundle patch after dependency install and esbuild', () => {
    const installScript = fs.readFileSync(
      path.resolve('scripts/install-openclaw-runtime.cjs'),
      'utf8',
    );
    const bundleScript = fs.readFileSync(path.resolve('scripts/bundle-openclaw-gateway.cjs'), 'utf8');
    const patchDriver = fs.readFileSync(path.resolve('scripts/patch-openclaw-runtime.cjs'), 'utf8');
    const manifestVerifier = fs.readFileSync(
      path.resolve('scripts/verify-openclaw-runtime-patches.cjs'),
      'utf8',
    );
    const packageJson = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const launcher = fs.readFileSync(
      path.resolve('src/main/openclaw/runtime/openclawGatewayBundleLauncher.cjs'),
      'utf8',
    );
    expect(installScript).toContain("'install',\n      '--omit=dev'");
    expect(installScript.indexOf('    installProdDeps(')).toBeLessThan(
      installScript.indexOf('    await packGatewayAsar('),
    );
    const runtimeScript = packageJson.scripts['openclaw:runtime:win-x64'];
    expect(runtimeScript.indexOf('install-openclaw-runtime.cjs')).toBeLessThan(
      runtimeScript.indexOf('sync-openclaw-runtime-current.cjs'),
    );
    expect(runtimeScript.indexOf('sync-openclaw-runtime-current.cjs')).toBeLessThan(
      runtimeScript.indexOf('npm run openclaw:bundle'),
    );
    expect(bundleScript.indexOf('esbuild\n  .build({')).toBeLessThan(
      bundleScript.indexOf('.then(result => {'),
    );
    expect(bundleScript.indexOf('.then(result => {')).toBeLessThan(bundleScript.indexOf('freshBundlePass: true'));
    expect(bundleScript).toContain('patchOpenClawRuntime(runtimeDir, {');
    expect(bundleScript).toContain('freshBundlePass: true');
    expect(patchDriver.indexOf('patchModule.verifyPatch(runtimeDir')).toBeLessThan(
      patchDriver.indexOf('writeOpenClawPatchManifest(runtimeDir'),
    );
    expect(manifestVerifier).toContain("path: 'gateway-bundle.mjs'");
    expect(manifestVerifier).toContain('sha256: hashFile(gatewayBundlePath)');
    expect(launcher).toContain('Loads gateway-bundle.mjs directly without dist/ fallback');
  });
});
