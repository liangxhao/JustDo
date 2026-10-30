import { existsSync, readdirSync, realpathSync } from 'node:fs';
import path from 'node:path';

import { defineConfig } from 'vitest/config';

const extensionRoot = path.resolve(__dirname, 'plugins/extensions');
const independentPlugins = readdirSync(extensionRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(path.join(extensionRoot, entry.name, 'vitest.config.ts')))
  .map(entry => entry.name);
const pluginTests = readdirSync(extensionRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => independentPlugins.includes(entry.name)
    ? `plugins/extensions/${entry.name}/tests/host/**/*.test.{ts,tsx}`
    : `plugins/extensions/${entry.name}/{tests,host,app}/**/*.test.{ts,tsx}`);
const pluginSetups = readdirSync(extensionRoot, { withFileTypes: true }).flatMap(entry => {
  if (!entry.isDirectory() || independentPlugins.includes(entry.name)) return [];
  const setup = path.join(extensionRoot, entry.name, 'tests/hostSetup.ts');
  return existsSync(setup) ? [setup] : [];
});

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
          /\/plugins\/sdk\/app-plugin-sdk\/browser-runtime(?:\.ts)?$/.test(
            source.replace(/\\/g, '/'),
          ) ||
          (source === './browser-runtime' &&
            importer.replace(/\\/g, '/').includes('/plugins/sdk/app-plugin-sdk/'))
        ) {
          return path.resolve(__dirname, 'tests/plugin-host/browserRuntime.ts');
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
      '@app-plugin/sdk': path.resolve(__dirname, './plugins/sdk/app-plugin-sdk'),
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
      ...pluginTests,
      'plugins/extensions/*/sdk/**/*.test.ts',
      'plugins/sdk/*/tests/**/*.test.{ts,tsx}',
      'plugins/browser-extensions/*/tests/**/*.test.ts',
    ],
    setupFiles: [
      'tests/plugin-host/messagePresentationFixtures.ts',
      ...pluginSetups,
    ],
    env: { APP_PLUGIN_HOST_ROOT: path.resolve(__dirname) },
    environment: 'node',
  },
});
