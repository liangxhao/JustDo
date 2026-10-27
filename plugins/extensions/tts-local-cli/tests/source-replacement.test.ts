import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const repoRoot = process.cwd();
const source = path.join(repoRoot, 'plugins/extensions/tts-local-cli');
const upstream = path.resolve(repoRoot, '../openclaw/extensions/tts-local-cli/speech-provider.ts');
const require = createRequire(import.meta.url);
const {
  syncLocalExtensions,
} = require('../../../../scripts/openclaw/sync-openclaw-runtime-resources.cjs');

describe('version-locked native speech replacement', () => {
  it('stages the complete own source and legal/provenance files over the upstream directory without downloading dependencies', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'speech-package-'));
    const repo = path.join(root, 'repo');
    const runtime = path.join(root, 'runtime');
    const target = path.join(runtime, 'dist/extensions/tts-local-cli');
    try {
      await fs.mkdir(path.join(repo, 'plugins/extensions'), { recursive: true });
      await fs.cp(source, path.join(repo, 'plugins/extensions/tts-local-cli'), { recursive: true });
      await fs.mkdir(target, { recursive: true });
      await fs.writeFile(path.join(target, 'stale-upstream.ts'), 'old');
      await fs.writeFile(
        path.join(runtime, 'package.json'),
        JSON.stringify({ version: '2026.10.7' }),
      );
      const installProductionDependencies = vi.fn();
      expect(
        syncLocalExtensions(repo, runtime, 'SpeechContract', { installProductionDependencies })
          .copied,
      ).toEqual(['tts-local-cli']);
      expect(installProductionDependencies).not.toHaveBeenCalled();
      expect(await fs.readFile(path.join(target, 'online.ts'), 'utf8')).toContain(
        'maxRedirects: 0',
      );
      expect(await fs.readFile(path.join(target, 'LICENSE'), 'utf8')).toContain('MIT License');
      expect(
        JSON.parse(await fs.readFile(path.join(target, 'upstream-source.json'), 'utf8')).version,
      ).toBe('2026.10.7');
      await expect(fs.stat(path.join(target, 'stale-upstream.ts'))).rejects.toThrow();
      await fs.writeFile(
        path.join(runtime, 'package.json'),
        JSON.stringify({ version: '2026.10.8' }),
      );
      expect(() =>
        syncLocalExtensions(repo, runtime, 'SpeechContract', { installProductionDependencies }),
      ).toThrow('requires review');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it.skipIf(!existsSync(upstream))(
    'retains the full locked upstream CLI implementation except task-text logging',
    async () => {
      const metadata = JSON.parse(
        await fs.readFile(path.join(source, 'upstream-source.json'), 'utf8'),
      );
      const original = await fs.readFile(upstream, 'utf8');
      expect(createHash('sha256').update(original).digest('hex')).toBe(
        metadata.files['speech-provider.ts'],
      );
      const normalized = original
        .replace(/\r\n/g, '\n')
        .replace('import { truncateUtf16Safe } from "openclaw/plugin-sdk/speech-provider";\n', '')
        .replace(
          /  log\.debug\(\r?\n    `\$\{telephony \? "synthesizeTelephony" : "synthesize"\}: text=\$\{truncateUtf16Safe\(req\.text, 50\)\}\.\.\.`,\r?\n  \);\r?\n/,
          '',
        );
      expect(
        (await fs.readFile(path.join(source, 'cli-speech-provider.ts'), 'utf8')).replace(
          /\r\n/g,
          '\n',
        ),
      ).toBe(normalized.replace(/\r\n/g, '\n'));
    },
  );
  it('classifies exactly one native source replacement', async () => {
    const policy = JSON.parse(
      await fs.readFile(path.join(repoRoot, 'plugins/extensions/prune-policy.json'), 'utf8'),
    );
    expect(policy.keep).not.toContain('tts-local-cli');
    expect(
      policy.remove
        .flatMap((entry: { extensions: string[] }) => entry.extensions)
        .filter((id: string) => id === 'tts-local-cli'),
    ).toEqual(['tts-local-cli']);
  });
});
