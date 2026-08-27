import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import { defineConfig } from 'vite';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';

import packageJson from './package.json';

// https://vitejs.dev/config/
const devPort = Number(process.env.JUSTDO_DEV_SERVER_PORT || packageJson.devServer.port);
const isProductionBuild = process.env.NODE_ENV !== 'development';
const escapedProductName = packageJson.productName.replace(
  /[&<>"']/g,
  character =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
    character,
);

export default defineConfig({
  plugins: [
    {
      name: 'product-name-html',
      transformIndexHtml(html) {
        return html.replaceAll('%PRODUCT_NAME%', escapedProductName);
      },
    },
    react(),
    electron([
      {
        // 主进程入口文件
        entry: 'src/main/main.ts',
        vite: {
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
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: !isProductionBuild,
    minify: isProductionBuild ? 'esbuild' : false,
    cssMinify: isProductionBuild ? 'esbuild' : false,
    rollupOptions: {
      checks: {
        pluginTimings: false,
      },
    },
  },
  server: {
    port: devPort,
    strictPort: true,
    host: true,
    hmr: {
      port: devPort,
    },
    watch: {
      usePolling: false,
    },
  },
  optimizeDeps: {
    exclude: ['electron', '@larksuite/openclaw-lark-tools', '@larksuite/openclaw-lark'],
  },
  clearScreen: false,
});
