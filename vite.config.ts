import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';

import packageJson from './package.json';
import { reactHooksRefreshPlugin } from './scripts/build/vite-react-hooks-refresh.mjs';
import { startupPresentationPlugin } from './scripts/build/startupPresentationPlugin.mjs';
import applicationLicenses from './scripts/packaging/application-license-assets.cjs';

// https://vitejs.dev/config/
const devPort = Number(process.env.JUSTDO_DEV_SERVER_PORT || packageJson.devServer.port);
const isProductionBuild = process.env.NODE_ENV !== 'development';
const projectRoot = path.resolve(__dirname);
const rendererRoot = path.join(projectRoot, 'src/renderer');
const dependencyRoot = fs.realpathSync(path.join(projectRoot, 'node_modules'));
const { createApplicationLicensePlugin } = applicationLicenses;
const escapedProductName = packageJson.productName.replace(
  /[&<>"']/g,
  character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
    character,
);

export default defineConfig({
  root: rendererRoot,
  envDir: projectRoot,
  plugins: [
    {
      name: 'product-name-html',
      transformIndexHtml(html) {
        return html.replaceAll('%PRODUCT_NAME%', escapedProductName);
      },
    },
    startupPresentationPlugin(rendererRoot),
    createApplicationLicensePlugin({ repoRoot: projectRoot, scope: 'renderer' }),
    reactHooksRefreshPlugin(projectRoot),
    react(),
    electron([
      {
        // 主进程入口文件
        entry: 'src/main/main.ts',
        vite: {
          root: projectRoot,
          plugins: [createApplicationLicensePlugin({ repoRoot: projectRoot, scope: 'main' })],
          build: {
            sourcemap: !isProductionBuild,
            outDir: 'dist-electron',
            minify: isProductionBuild ? 'esbuild' : false,
            rollupOptions: {
              external: id => {
                const staticExternals = [
                  'electron',
                  'electron-updater',
                  'better-sqlite3',
                  'discord.js',
                  'zlib-sync',
                  '@discordjs/opus',
                  'bufferutil',
                  'utf-8-validate',
                  'node-nim',
                  'nim-web-sdk-ng',
                ];
                if (staticExternals.includes(id)) return true;
                if (
                  id.startsWith('@larksuite/openclaw-lark-tools') ||
                  id.startsWith('@larksuite/openclaw-lark')
                )
                  return true;
                return false;
              },
              checks: {
                pluginTimings: false,
              },
              output: {
                // Keep CJS format (default), but load via ESM loader.mjs
                codeSplitting: false,
              },
            },
          },
        },
        onstart() {
          // Signal that the main process bundle is ready for electron to load
          fs.writeFileSync('dist-electron/.electron-ready', '');
        },
      },
      {
        // 预加载脚本入口文件
        entry: 'src/main/preload.ts',
        vite: {
          root: projectRoot,
          plugins: [createApplicationLicensePlugin({ repoRoot: projectRoot, scope: 'preload' })],
          build: {
            sourcemap: !isProductionBuild,
            outDir: 'dist-electron',
            minify: isProductionBuild ? 'esbuild' : false,
            rollupOptions: {
              checks: {
                pluginTimings: false,
              },
            },
          },
        },
        onstart() {},
      },
      {
        // 独立图片查看窗口的最小权限预加载脚本
        entry: 'src/main/imagePreviewPreload.ts',
        vite: {
          root: projectRoot,
          plugins: [createApplicationLicensePlugin({ repoRoot: projectRoot, scope: 'imagePreviewPreload' })],
          build: {
            sourcemap: !isProductionBuild,
            outDir: 'dist-electron',
            minify: isProductionBuild ? 'esbuild' : false,
            rollupOptions: {
              checks: {
                pluginTimings: false,
              },
            },
          },
        },
        onstart() {},
      },
      {
        // 外部网页 guest 的固定检查桥；不向页面暴露 Node 或 Electron API。
        entry: 'src/main/browserGuestPreload.ts',
        vite: {
          root: projectRoot,
          plugins: [createApplicationLicensePlugin({ repoRoot: projectRoot, scope: 'browserGuestPreload' })],
          build: {
            sourcemap: !isProductionBuild,
            outDir: 'dist-electron',
            minify: isProductionBuild ? 'esbuild' : false,
            rollupOptions: { checks: { pluginTimings: false } },
          },
        },
        onstart() {},
      },
      {
        entry: 'src/main/widgetViewerPreload.ts',
        vite: {
          root: projectRoot,
          plugins: [createApplicationLicensePlugin({ repoRoot: projectRoot, scope: 'widgetViewerPreload' })],
          build: {
            outDir: 'dist-electron',
            sourcemap: !isProductionBuild,
            minify: isProductionBuild ? 'esbuild' : false,
            rollupOptions: { checks: { pluginTimings: false } },
          },
        },
        onstart() {},
      },
    ]),
    renderer(),
  ],
  base: process.env.NODE_ENV === 'development' ? '/' : './',
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, './src/shared'),
      '@': path.resolve(__dirname, './src/renderer'),
      // Use mermaid core build (no dynamic imports, all diagrams statically bundled)
      mermaid: 'mermaid/dist/mermaid.core.mjs',
    },
  },
  build: {
    outDir: path.join(projectRoot, 'dist'),
    emptyOutDir: true,
    sourcemap: !isProductionBuild,
    minify: isProductionBuild ? 'esbuild' : false,
    cssMinify: isProductionBuild ? 'esbuild' : false,
    rollupOptions: {
      input: {
        main: path.join(rendererRoot, 'index.html'),
        startupBootstrap: path.join(rendererRoot, 'startup-bootstrap.html'),
        imagePreview: path.join(rendererRoot, 'image-preview.html'),
        workspace: path.join(rendererRoot, 'workspace.html'),
        widgetViewer: path.join(rendererRoot, 'widget-viewer.html'),
      },
      checks: {
        pluginTimings: false,
      },
    },
  },
  server: {
    port: devPort,
    strictPort: true,
    host: true,
    fs: {
      // Git worktrees may share dependencies through a directory junction.
      // Vite validates resolved paths, so allow only that dependency tree in
      // addition to this worktree instead of allowing the junction's parent.
      allow: [projectRoot, dependencyRoot],
    },
    hmr: {
      port: devPort,
    },
    watch: {
      usePolling: false,
      ignored: ['**/.work/**', '**/vendor/**'],
    },
  },
  optimizeDeps: {
    exclude: ['electron', '@larksuite/openclaw-lark-tools', '@larksuite/openclaw-lark'],
  },
  clearScreen: false,
});
