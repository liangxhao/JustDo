/** Opt-in real Electron regression: local pages and synthetic admission, no Gateway or app data. */
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');

const root = path.resolve(__dirname, '../../..');
const fixture = path.join(root, 'tests/browser/session-browser-handoff');
const artifactRoot = path.join(root, '.agent-tasks/browser/session-handoff');
const baseline = process.argv.find(argument => argument.startsWith('--baseline='))?.slice(11);
if (baseline && !/^[a-f\d]{7,40}$/iu.test(baseline)) {
  throw new Error('--baseline must name a Git commit hash');
}
fs.mkdirSync(artifactRoot, { recursive: true });
const output = fs.mkdtempSync(path.join(artifactRoot, 'probe-'));

(async () => {
  const baselineSource = baseline && execFileSync(
    'git', ['show', `${baseline}:src/renderer/features/cowork/coworkService.ts`],
    { cwd: root, encoding: 'utf8', windowsHide: true },
  );
  await build({
    entryPoints: [path.join(fixture, 'ui.tsx')],
    bundle: true,
    format: 'iife',
    outfile: path.join(output, 'bundle.js'),
    tsconfig: path.join(root, 'tsconfig.json'),
    alias: {
      '@app-plugin/sdk/browser-runtime': path.join(root, 'tests/workspace-window/appPluginRuntime.ts'),
    },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
    logOverride: { 'empty-import-meta': 'silent' },
    loader: { '.ttf': 'file', '.woff': 'file', '.woff2': 'file', '.png': 'file', '.webp': 'file', '.md': 'text' },
    plugins: baselineSource ? [{
      name: 'historical-service-fixture',
      setup(builder) {
        builder.onLoad({ filter: /[\\/]coworkService\.ts$/ }, args => ({
          contents: baselineSource, loader: 'ts', resolveDir: path.dirname(args.path),
        }));
      },
    }] : [],
  });
  const layout = await require('postcss')([
    require('tailwindcss')({ config: path.join(root, 'tailwind.config.js') }),
  ]).process('@tailwind base; @tailwind utilities;', {
    from: path.join(root, 'src/renderer/index.css'),
  });
  fs.writeFileSync(path.join(output, 'layout.css'), layout.css);
  await build({
    stdin: {
      contents: "export * from './src/main/core/window/workspaceWindowManager'; export * from './src/main/ipc/app/workspaceWindow';",
      resolveDir: root,
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    outfile: path.join(output, 'manager.cjs'),
  });
  fs.writeFileSync(path.join(output, 'empty-preload.cjs'), '');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [
    path.join(fixture, 'main.cjs'), output, ...(baseline ? ['--expect-flicker'] : []),
  ], { env, stdio: 'inherit', windowsHide: true });
  child.on('exit', code => { process.exitCode = code ?? 1; });
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
