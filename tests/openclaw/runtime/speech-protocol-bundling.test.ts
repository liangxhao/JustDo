import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const { bundleProductExtension } = require('../../../scripts/openclaw/sync-openclaw-runtime-resources.cjs') as {
  bundleProductExtension(source: string, target: string): void;
};

describe('speech protocol source bundling', () => {
  it.each(['openai', 'stt-local-cli', 'tts-local-cli', 'runtime-services'])(
    'inlines pure protocol sources in all %s registration/catalog/worker artifacts before relocation',
    id => {
      const buildRoot = path.resolve('build');
      fs.mkdirSync(buildRoot, { recursive: true });
      const fixture = fs.mkdtempSync(path.join(buildRoot, 'speech-bundle-'));
      const source = path.resolve('plugins/extensions', id);
      try {
        for (const name of ['package.json', 'openclaw.plugin.json'])
          fs.copyFileSync(path.join(source, name), path.join(fixture, name));
        bundleProductExtension(source, fixture);
        const pkg = JSON.parse(fs.readFileSync(path.join(fixture, 'package.json'), 'utf8'));
        const manifest = JSON.parse(fs.readFileSync(path.join(fixture, 'openclaw.plugin.json'), 'utf8'));
        const entries = [...pkg.openclaw.extensions, manifest.capabilityCatalogEntry, ...(pkg.openclaw.build?.workerEntries ?? [])].filter(Boolean);
        for (const entry of entries) {
          expect(entry).toMatch(/\.js$/);
          const code = fs.readFileSync(path.join(fixture, entry), 'utf8');
          expect(code).not.toMatch(/(?:from\s*|import\s*\()\s*['"][^'"]*(?:sdk\/speech-protocols|@speech\/protocols)/);
          expect(code).not.toMatch(/(?:from\s*|import\s*\()\s*['"][^'"]*application\/src/);
        }
        expect(fs.readFileSync(path.join(fixture, 'index.js'), 'utf8')).toContain(
          id === 'stt-local-cli' ? 'openai-transcription-http' : 'openai-speech-http',
        );
        expect(fs.existsSync(path.join(fixture, 'node_modules'))).toBe(false);
      } finally {
        fs.rmSync(fixture, { recursive: true, force: true });
      }
    },
  );
});
