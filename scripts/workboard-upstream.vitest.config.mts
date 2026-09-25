import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineConfig } from 'vitest/config';

// Opt-in contract check against a pristine sibling checkout; no live Gateway or model calls.
const upstream = path.resolve(process.env.OPENCLAW_SOURCE ?? '../openclaw');
const { sharedVitestConfig } = await import(
  pathToFileURL(path.join(upstream, 'test/vitest/vitest.shared.config.ts')).href
);

if (process.env.OPENCLAW_RUNTIME) {
  const sourceVersion = JSON.parse(
    fs.readFileSync(path.join(upstream, 'package.json'), 'utf8'),
  ).version;
  const runtimeVersion = JSON.parse(
    fs.readFileSync(path.resolve(process.env.OPENCLAW_RUNTIME, 'package.json'), 'utf8'),
  ).version;
  if (sourceVersion !== runtimeVersion)
    throw new Error('Workboard source and SDK runtime versions must match');
}

export default defineConfig({
  plugins: process.env.OPENCLAW_RUNTIME
    ? [
        {
          name: 'workboard-runtime-dependencies',
          enforce: 'pre',
          resolveId(id) {
            if (
              !id.startsWith('.') &&
              !id.startsWith('/') &&
              !id.includes(':') &&
              !['vitest', 'electron'].includes(id)
            ) {
              try {
                return createRequire(
                  path.resolve(process.env.OPENCLAW_RUNTIME!, 'package.json'),
                ).resolve(id);
              } catch {
                return null;
              }
            }
          },
        },
      ]
    : [],
  resolve: {
    alias: [
      { find: 'upstream-workboard', replacement: path.join(upstream, 'extensions/workboard/src') },
      ...sharedVitestConfig.resolve.alias.filter(
        (entry: { find: string | RegExp }) =>
          !process.env.OPENCLAW_RUNTIME || String(entry.find).includes('workboard-contract'),
      ),
    ],
  },
  test: {
    include: ['tests/workboard-upstream.contract.test.mts'],
    environment: 'node',
    server: { deps: { inline: [/upstream-workboard/, /openclaw/] } },
  },
});
