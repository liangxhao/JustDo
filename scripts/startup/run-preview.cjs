'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { findFreePort } = require('../electron/find-free-port.cjs');

const choices = {
  route: ['fresh', 'migration', 'upgrade', 'normal'],
  language: ['zh', 'en'],
  theme: ['light', 'dark'],
};

function parsePreviewArguments(argv) {
  const options = { route: 'fresh', language: 'zh', theme: 'light' };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, '');
    if (!argv[index]?.startsWith('--') || !Object.hasOwn(choices, key) || seen.has(key))
      throw new Error(
        'Use only --route, --language and --theme once each; profiles are not accepted.',
      );
    if (!choices[key].includes(argv[index + 1]))
      throw new Error(`Invalid --${key}. Choose ${choices[key].join(', ')}.`);
    options[key] = argv[index + 1];
    seen.add(key);
  }
  return options;
}

async function createPreviewServer(options) {
  if (process.env.NODE_ENV === 'production')
    throw new Error('Startup presentation preview is available only in development.');
  const [{ createServer }, { default: react }] = await Promise.all([
    import('vite'),
    import('@vitejs/plugin-react'),
  ]);
  const root = path.resolve(__dirname, '../..');
  // A worktree may use package junctions. Admit only its installed dependency tree.
  const reactRoot = path.dirname(fs.realpathSync(require.resolve('react/package.json')));
  const dependencyRoot = path.dirname(reactRoot);
  // Vite treats zero as its default port, so reserve an OS-assigned port explicitly.
  const port = await findFreePort(0);
  const server = await createServer({
    configFile: false,
    root: path.join(root, 'src/renderer'),
    envDir: false,
    cacheDir: path.join(root, 'build/startup-preview/vite-cache'),
    mode: 'development',
    appType: 'mpa',
    plugins: [
      {
        name: 'startup-presentation-preview-only',
        configureServer(devServer) {
          devServer.middlewares.use((req, res, next) => {
            const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
            if (
              pathname === '/' ||
              (pathname.endsWith('.html') && pathname !== '/startup-preview.html')
            ) {
              res.statusCode = 404;
              res.end('Open the startup-preview.html URL printed by the preview command.');
              return;
            }
            next();
          });
        },
      },
      react(),
    ],
    resolve: {
      alias: {
        '@shared': path.join(root, 'src/shared'),
        '@': path.join(root, 'src/renderer'),
      },
    },
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      fs: { strict: true, allow: [root, dependencyRoot] },
      watch: { ignored: ['**/.agent-tasks/**', '**/vendor/**', '**/build/**'] },
    },
  });
  try {
    await server.listen();
    const address = server.httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Preview listener did not start.');
    return {
      port,
      url: `http://127.0.0.1:${address.port}/startup-preview.html?${new URLSearchParams(options)}`,
      close: () => server.close(),
    };
  } catch (error) {
    await server.close();
    throw error;
  }
}

async function main() {
  const preview = await createPreviewServer(parsePreviewArguments(process.argv.slice(2)));
  console.log(
    '[Startup Preview] UI rehearsal only; no application profile, Main or Gateway is opened.',
  );
  console.log(preview.url);
  let stopping;
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      stopping ||= preview.close().then(() => {
        process.exitCode = 0;
      });
    });
}

if (require.main === module)
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { parsePreviewArguments, createPreviewServer };
