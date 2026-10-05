import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test, vi } from 'vitest';

const { pruneRuntimeExtensions } = require('../../scripts/openclaw/prune-openclaw-runtime.cjs') as {
  pruneRuntimeExtensions: (
    runtimeRoot: string,
    stats: { extensionDirsRemoved: number; bytesFreed: number },
    options: { repoRoot: string; label: string },
  ) => { removed: string[] };
};

test('preinstalled plugin requirements remain present after runtime pruning on every platform', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const metadata = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const policy = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'resources/openclaw-extension-prune.json'), 'utf8'),
  );
  const removed = policy.remove.flatMap((group: { extensions: string[] }) => group.extensions);
  for (const plugin of metadata.openclaw.plugins) {
    expect(removed, `${plugin.id} is required by packaging`).not.toContain(plugin.id);
  }
});

test('prunes public-cloud plugins while retaining the intranet OpenAI adapter and local extensions', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-plugin-prune-'));
  const extensionsRoot = path.join(runtimeRoot, 'dist', 'extensions');
  const excluded = ['novita', 'elevenlabs', 'kie', 'zai', 'anthropic', 'github'];
  const retained = ['openai', 'browser', 'tts-local-cli', 'stt-local-cli', 'typesafe'];
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    for (const id of [...excluded, ...retained]) {
      const extensionRoot = path.join(extensionsRoot, id);
      fs.mkdirSync(extensionRoot, { recursive: true });
      fs.writeFileSync(path.join(extensionRoot, 'index.js'), 'export default {};');
    }
    const stats = { extensionDirsRemoved: 0, bytesFreed: 0 };

    const result = pruneRuntimeExtensions(runtimeRoot, stats, { repoRoot, label: 'test' });

    expect(result.removed.sort()).toEqual([...excluded].sort());
    expect(stats.extensionDirsRemoved).toBe(6);
    expect(fs.readdirSync(extensionsRoot).sort()).toEqual([...retained].sort());
  } finally {
    log.mockRestore();
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
