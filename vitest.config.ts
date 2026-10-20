import path from 'node:path';
import { realpathSync } from 'node:fs';

import { defineConfig } from 'vitest/config';

if (process.versions.electron) {
  throw new Error('Vitest requires standalone Node.js 24. Electron drivers are disabled; run `npm test` with Node.js.');
}

export default defineConfig({
  plugins: [
    {
      name: 'app-plugin-behavior-fixtures',
      enforce: 'pre',
      resolveId(source, importer) {
        if (!importer) return;
        if (
          source === '@app-plugin/sdk/browser-runtime' ||
          /\/packages\/app-plugin-sdk\/browser-runtime(?:\.ts)?$/.test(
            source.replace(/\\/g, '/'),
          ) ||
          (source === './browser-runtime' &&
            importer.replace(/\\/g, '/').includes('/packages/app-plugin-sdk/'))
        ) {
          return path.resolve(__dirname, 'tests/plugin-host/browserRuntime.ts');
        }
        if (
          source.startsWith('.') &&
          importer.replace(/\\/g, '/').includes('/plugins/extensions/agent-team/app/browser/')
        ) {
          const resolved = path.resolve(path.dirname(importer), source);
          if (
            resolved === path.resolve(__dirname, 'plugins/extensions/agent-team/app/browser/state')
          )
            return path.resolve(__dirname, 'tests/plugin-host/teamState.ts');
        }
      },
    },
  ],
  server: {
    fs: {
      allow: [__dirname, path.dirname(realpathSync(path.join(__dirname, 'node_modules/react')))],
    },
  },
  resolve: {
    alias: {
      '@app-plugin/sdk': path.resolve(__dirname, './packages/app-plugin-sdk'),
      '@shared': path.resolve(__dirname, './src/shared'),
      '@': path.resolve(__dirname, './src/renderer'),
    },
  },
  test: {
    // Native runtime cold starts and Windows process snapshots compete for resources.
    maxWorkers: 2,
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'tests/**/*.test.ts',
      'tests/**/*.test.tsx',
      'plugins/extensions/*/tests/**/*.test.ts',
      'plugins/browser-extensions/*/tests/**/*.test.ts',
      'plugins/extensions/agent-team/{host,app}/**/*.test.{ts,tsx}',
      'plugins/extensions/swarm-workflow/{host,app}/**/*.test.{ts,tsx}',
    ],
    setupFiles: [
      'tests/plugin-host/legacyBehaviorPorts.ts',
      'tests/plugin-host/messagePresentationFixtures.ts',
    ],
    environment: 'node',
  },
});
