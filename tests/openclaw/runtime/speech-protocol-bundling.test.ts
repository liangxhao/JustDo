import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const { bundleProductExtension } = require('../../../scripts/openclaw/sync-openclaw-runtime-resources.cjs') as {
  bundleProductExtension(source: string, target: string): void;
};
const { precompileOpenClawExtensions } = require('../../../scripts/openclaw/precompile-openclaw-extensions.cjs');

describe('speech protocol source bundling', () => {
  it.each(['openai', 'stt-local-cli', 'tts-local-cli', 'runtime-services'])(
    'inlines pure protocol sources in all %s registration/catalog/worker artifacts before relocation',
    async id => {
      const buildRoot = path.resolve('build');
      fs.mkdirSync(buildRoot, { recursive: true });
      const runtime = fs.mkdtempSync(path.join(buildRoot, 'speech-bundle-'));
      const fixture = path.join(runtime, 'dist/extensions', id);
      const source = path.resolve('plugins/extensions', id);
      try {
        fs.cpSync(source, fixture, {
          recursive: true,
          filter: entry => !['node_modules', 'tests'].includes(path.basename(entry)),
        });
        for (const name of ['package.json', 'openclaw.plugin.json'])
          fs.copyFileSync(path.join(source, name), path.join(fixture, name));
        bundleProductExtension(source, fixture);
        // Native discovery loads these independently of the main entry. The
        // relocated package has no sibling source SDK to resolve their imports.
        const auxiliaryEntries = ['setup-api', 'provider-policy-api', 'provider-contract-api']
          .filter(name => fs.existsSync(path.join(source, name + '.ts')));
        for (const name of auxiliaryEntries) {
          expect(fs.existsSync(path.join(fixture, name + '.ts'))).toBe(false);
          expect(fs.existsSync(path.join(fixture, name + '.js'))).toBe(true);
        }
        expect(await precompileOpenClawExtensions(runtime, { required: true })).toMatchObject({
          compiled: 0,
          errors: 0,
        });
        const pkg = JSON.parse(fs.readFileSync(path.join(fixture, 'package.json'), 'utf8'));
        const manifest = JSON.parse(fs.readFileSync(path.join(fixture, 'openclaw.plugin.json'), 'utf8'));
        const entries = [...pkg.openclaw.extensions, manifest.capabilityCatalogEntry, ...(pkg.openclaw.build?.workerEntries ?? []), ...auxiliaryEntries.map(name => './' + name + '.js')].filter(Boolean);
        const chunks = fs.readdirSync(fixture).filter(name => /^runtime-.*\.js$/.test(name));
        const bundledCode = [...entries, ...chunks].map(entry => {
          expect(entry).toMatch(/\.js$/);
          const code = fs.readFileSync(path.join(fixture, entry), 'utf8');
          expect(code).not.toMatch(/(?:from\s*|import\s*\()\s*['"][^'"]*(?:sdk\/speech-protocols|@speech\/protocols)/);
          expect(code).not.toMatch(/(?:from\s*|import\s*\()\s*['"][^'"]*application\/src/);
          return code;
        });
        expect(bundledCode.join('\n')).toContain(
          id === 'stt-local-cli' ? 'openai-transcription-http' : 'openai-speech-http',
        );
        expect(fs.existsSync(path.join(fixture, 'node_modules'))).toBe(false);
      } finally {
        fs.rmSync(runtime, { recursive: true, force: true });
      }
    },
  );
});

it('loads OpenCC only when the packaged STT tool executes', () => {
  const buildRoot = path.resolve('build');
  fs.mkdirSync(buildRoot, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(buildRoot, 'stt-entry-'));
  try {
    bundleProductExtension(path.resolve('plugins/extensions/stt-local-cli'), fixture);
    execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      `
        import assert from 'node:assert/strict';
        import { registerHooks } from 'node:module';
        import { pathToFileURL } from 'node:url';

        registerHooks({
          resolve(specifier, context, nextResolve) {
            if (specifier === 'opencc-js/t2cn') throw new Error('OpenCC resolved');
            return nextResolve(specifier, context);
          },
        });
        const { default: plugin } = await import(pathToFileURL(process.argv[1]).href);
        let factory;
        plugin.register({
          config: {},
          pluginConfig: { mode: 'local', command: process.execPath, args: [], modelId: 'test', language: 'zh' },
          registerTool: create => { factory = create; },
        });
        const tool = factory({});
        assert.equal(tool.name, 'transcribe_audio');
        await assert.rejects(tool.execute('fixture', { audio_path: process.execPath }), /OpenCC resolved/);
      `,
      path.join(fixture, 'index.js'),
    ], { timeout: 15_000, windowsHide: true });
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
