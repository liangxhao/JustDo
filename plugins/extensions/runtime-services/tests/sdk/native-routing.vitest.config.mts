import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { defineConfig } from 'vitest/config';

const sourceRoot = process.env.OPENCLAW_SOURCE_ROOT
  ? realpathSync(process.env.OPENCLAW_SOURCE_ROOT) : undefined;
if (sourceRoot && (!statSync(path.join(sourceRoot, 'src/plugins/registry.ts')).isFile() ||
    JSON.parse(readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')).name !== 'openclaw'))
  throw new Error('OPENCLAW_SOURCE_ROOT must identify the matching native source checkout.');
const nativeRequire = sourceRoot && createRequire(path.join(sourceRoot, 'package.json'));
const unavailableSubpaths = new Set([
  '@openclaw/fs-safe/copy', '@openclaw/fs-safe/durability', 'import-meta-resolve',
  'mdast-util-gfm-table', 'micromark-extension-gfm-table',
]);

export default defineConfig({
  root: path.resolve(import.meta.dirname, '../../../../..'),
  plugins: sourceRoot ? [{
    name: 'native-source-conformance-fixture',
    enforce: 'pre',
    resolveId(source) {
      if (process.env.OPENCLAW_CONFORMANCE_STUB_UNUSED_DEPENDENCIES === '1' && unavailableSubpaths.has(source)) {
        try { nativeRequire!.resolve(source); } catch {
          return path.join(import.meta.dirname, 'native-routing.unavailable-dependencies.ts');
        }
      }
      const match = /^@openclaw\/([^/]+)(?:\/(.+))?$/u.exec(source);
      if (!match) return;
      const root = path.join(sourceRoot, 'packages', match[1], 'src');
      const leaf = ['llm-core', 'ai'].includes(match[1]) && ['diagnostics', 'event-stream'].includes(match[2])
        ? 'utils/' + match[2] : match[2] ?? 'index';
      const target = path.join(root, leaf);
      return [target + '.ts', path.join(target, 'index.ts')].find(file => existsSync(file));
    },
  }] : [],
  test: {
    include: [
      'plugins/extensions/runtime-services/tests/sdk/native-routing.integration.test.ts',
      'plugins/extensions/runtime-services/tests/sdk/owner-binding.integration.test.ts',
    ],
    maxWorkers: 1,
    environment: 'node',
    testTimeout: 60000,
  },
});
