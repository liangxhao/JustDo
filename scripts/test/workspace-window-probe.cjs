/** Real Electron integration gate. Isolated profile/output; no Gateway or application DB. */
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { build } = require('esbuild');
const root = path.resolve(__dirname, '../..');
const fixture = path.join(root, 'tests/electron/workspace-window');
fs.mkdirSync(path.join(root, '.tmp'), { recursive: true });
const output = fs.mkdtempSync(path.join(root, '.tmp/workspace-integration-'));
(async () => {
  await build({
    entryPoints: [path.join(fixture, 'ui.tsx')],
    bundle: true,
    format: 'iife',
    outfile: path.join(output, 'bundle.js'),
    tsconfig: path.join(root, 'tsconfig.json'),
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
    logOverride: { 'empty-import-meta': 'silent' },
    loader: { '.ttf': 'file', '.woff': 'file', '.woff2': 'file', '.png': 'file', '.webp': 'file' },
  });
  // Generate the production utilities, including tab sizing and focus styles;
  // an incomplete CSS fixture can change whether the overflow control exists.
  const layout = await require('postcss')([
    require('tailwindcss')({ config: path.join(root, 'tailwind.config.js') }),
  ]).process('@tailwind base; @tailwind utilities;', {
    from: path.join(root, 'src/renderer/index.css'),
  });
  fs.writeFileSync(path.join(output, 'layout.css'), layout.css);
  // One bundle shares the same manager registry with its IPC module.
  await build({
    stdin: {
      contents:
        "export * from './src/main/core/window/workspaceWindowManager'; export * from './src/main/ipc/app/workspaceWindow'; export * from './src/main/core/window/windowChrome';",
      resolveDir: root,
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: path.join(output, 'manager.cjs'),
  });
  fs.writeFileSync(path.join(output, 'ipc.cjs'), "module.exports=require('./manager.cjs')");
  fs.copyFileSync(path.join(fixture, 'preload.cjs'), path.join(output, 'preload.cjs'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [path.join(fixture, 'main.cjs'), output], {
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  child.on('exit', code => {
    process.exitCode = code ?? 1;
  });
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
