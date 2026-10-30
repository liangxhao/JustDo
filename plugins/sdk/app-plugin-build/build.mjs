import { createHash } from 'node:crypto';
import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import { isBuiltin } from 'node:module';
import { parse } from 'acorn';
import { APP_NATIVE_PROFILE, verifyAppNativeModule } from '@app-plugin/sdk/native-profile';
import themePreset from './theme-preset.cjs';
import {
  discoverAppPluginSources,
  readAppPluginSource,
  sourceBoundary,
  sourceEntry,
} from './sources.mjs';
import { writePackageLicenses } from './licenses.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const exists = async file =>
  access(file).then(
    () => true,
    error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
const symbol = "globalThis[Symbol.for('app-plugin.browser-runtime.v1')]";
const reactExports = [
  'Children',
  'Component',
  'Fragment',
  'Profiler',
  'PureComponent',
  'StrictMode',
  'Suspense',
  'cloneElement',
  'createContext',
  'createElement',
  'createFactory',
  'createRef',
  'forwardRef',
  'isValidElement',
  'lazy',
  'memo',
  'startTransition',
  'useCallback',
  'useContext',
  'useDebugValue',
  'useDeferredValue',
  'useEffect',
  'useId',
  'useImperativeHandle',
  'useInsertionEffect',
  'useLayoutEffect',
  'useMemo',
  'useReducer',
  'useRef',
  'useState',
  'useSyncExternalStore',
  'useTransition',
  'version',
];

// Both ESM imports and bundled CJS dependencies use the application's actual React object.
export const browserSdk = {
  name: 'app-browser-sdk',
  setup(builder) {
    builder.onResolve(
      { filter: /^(react(?:-dom)?(?:\/.*)?|@app-plugin\/sdk\/browser-runtime)$/ },
      args => ({ path: args.path, namespace: 'app-sdk' }),
    );
    builder.onLoad({ filter: /.*/, namespace: 'app-sdk' }, ({ path: id }) => {
      if (id === 'react')
        return {
          contents: `const React=${symbol}.React; export default React; ${reactExports.map(name => `export const ${name}=React.${name};`).join('\n')}`,
        };
      if (id === 'react/jsx-runtime')
        return {
          contents: `export const Fragment=${symbol}.React.Fragment; export const jsx=${symbol}.jsx; export const jsxs=${symbol}.jsxs;`,
        };
      if (id === 'react/jsx-dev-runtime')
        return {
          contents: `export const Fragment=${symbol}.React.Fragment; export const jsxDEV=${symbol}.jsxDEV;`,
        };
      if (id === 'react-dom')
        return {
          contents: `export const createPortal=${symbol}.createPortal; export const flushSync=${symbol}.flushSync;`,
        };
      if (id === '@app-plugin/sdk/browser-runtime')
        return { contents: `export const runtime=${symbol};` };
      throw new Error(`Unsupported app browser SDK module: ${id}`);
    });
    builder.onResolve({ filter: /^@\/|^@shared\// }, args => {
      throw new Error(`App plugin cannot import application source: ${args.path}`);
    });
  },
};

export async function buildAppPlugin(source, destination, options = {}) {
  const declarationSource = await readAppPluginSource(source);
  source = declarationSource.source;
  const { manifest, pkg } = declarationSource;
  const declaration = pkg.app;
  const nativeEntry = pkg.openclaw?.extensions;
  const entry = name => sourceEntry(source, name);
  const dependencyRoots = new Set();
  const boundary = () =>
    sourceBoundary(source, pkg, {
      ...options,
      onDependencyRoot: directory => dependencyRoots.add(directory),
    });
  const native = await build({
    absWorkingDir: source,
    tsconfigRaw: {},
    stdin: {
      contents: `
        import * as entry from ${JSON.stringify(entry(nativeEntry[0]))};
        export * from ${JSON.stringify(entry(nativeEntry[0]))};
        import { dispatchGatewayMethod } from 'openclaw/plugin-sdk/gateway-method-runtime';
        import { withAppNative } from '@app-plugin/sdk/native';
        export default withAppNative(entry.default ?? entry, dispatchGatewayMethod);
      `,
      resolveDir: source,
      sourcefile: 'app-native-entry.mjs',
      loader: 'js',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    external: ['openclaw/plugin-sdk/*'],
    write: false,
    plugins: [boundary()],
    metafile: true,
  });
  const nativeBytes = native.outputFiles[0].contents;
  verifyAppNativeModule(Buffer.from(nativeBytes).toString('utf8'), parse, isBuiltin);
  const main = await build({
    absWorkingDir: source,
    tsconfigRaw: {},
    entryPoints: [entry(declaration.main)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    write: false,
    metafile: true,
    plugins: [boundary()],
  });
  const browser = await build({
    absWorkingDir: source,
    tsconfigRaw: {},
    entryPoints: [entry(declaration.browser)],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    jsx: 'automatic',
    write: false,
    plugins: [browserSdk, boundary()],
    metafile: true,
    outdir: 'browser',
  });
  if (Boolean(manifest.entries.presentation) !== Boolean(declaration.presentation))
    throw new Error('App history presentation build declaration mismatch');
  const presentation = declaration.presentation
    ? await build({
        absWorkingDir: source,
        tsconfigRaw: {},
        entryPoints: [entry(declaration.presentation)],
        bundle: true,
        platform: 'browser',
        format: 'esm',
        target: 'es2022',
        write: false,
        metafile: true,
        plugins: [
          {
            name: 'pure-history-presentation',
            setup(builder) {
              builder.onResolve(
                {
                  filter:
                    /^(?:react(?:-dom)?(?:\/.*)?|@app-plugin\/sdk\/browser-runtime|@\/|@shared\/)/,
                },
                args => {
                  throw new Error(
                    `History presentation cannot import application runtime: ${args.path}`,
                  );
                },
              );
            },
          },
          boundary(),
        ],
      })
    : undefined;
  if (
    presentation &&
    !Object.values(presentation.metafile.outputs).every(
      output => output.exports.length === 1 && output.exports[0] === 'presentation',
    )
  )
    throw new Error('History presentation must export only its pure presentation value');
  const bytes = {
    [manifest.entries.main]: main.outputFiles[0].contents,
    [manifest.entries.browser]: browser.outputFiles.find(file => file.path.endsWith('.js'))
      .contents,
    'native.binding.json': Buffer.from(
      JSON.stringify({
        entry: 'index.js',
        sha256: sha(nativeBytes),
        profile: APP_NATIVE_PROFILE,
      }),
    ),
  };
  if (presentation) bytes[manifest.entries.presentation] = presentation.outputFiles[0].contents;
  const css = browser.outputFiles.find(file => file.path.endsWith('.css'));
  const utilities = await postcss([
    tailwind({
      presets: [themePreset],
      content: [path.join(source, '**/*.{ts,tsx}')],
      corePlugins: { preflight: false },
      important: `:where([data-ui-style-scope="${manifest.id}"])`,
    }),
  ]).process('@tailwind utilities;', { from: undefined });
  bytes['browser.css'] = Buffer.from(
    (css ? Buffer.from(css.contents).toString('utf8') : '') + '\n' + utilities.css,
  );
  const files = Object.fromEntries(
    Object.entries(bytes)
      .map(([name, value]) => [name, sha(value)])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const hash = sha(JSON.stringify({ manifest, files }));
  const root = path.join(path.resolve(destination), manifest.id, hash);
  await mkdir(root, { recursive: true });
  for (const [name, value] of Object.entries(bytes)) {
    const output = path.join(root, name);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, value);
  }
  await writeFile(
    path.join(root, 'app.artifact.json'),
    JSON.stringify({ manifest, hash, files }, null, 2) + '\n',
  );
  // A separately installable native package contains its companion, not application src.
  const packageRoot = path.join(path.resolve(destination), 'packages', manifest.id, hash);
  await mkdir(packageRoot, { recursive: true });
  await writeFile(path.join(packageRoot, 'index.js'), nativeBytes);
  await writeFile(
    path.join(packageRoot, 'package.json'),
    JSON.stringify(
      {
        ...pkg,
        type: 'module',
        app: undefined,
        files: [
          'index.js',
          'openclaw.plugin.json',
          'app/',
          'skills/',
          'licenses/',
          'LICENSE',
          'THIRD_PARTY_NOTICES.json',
        ],
        scripts: undefined,
        dependencies: undefined,
        devDependencies: undefined,
        peerDependencies: undefined,
        optionalDependencies: undefined,
        openclaw: { ...pkg.openclaw, extensions: ['./index.js'] },
      },
      null,
      2,
    ) + '\n',
  );
  const nativeManifest = JSON.parse(
    await readFile(path.join(source, 'openclaw.plugin.json'), 'utf8'),
  );
  await writeFile(
    path.join(packageRoot, 'openclaw.plugin.json'),
    JSON.stringify(
      {
        ...nativeManifest,
        contracts: {
          ...nativeManifest.contracts,
          gatewayMethodDispatch: [
            ...new Set([
              ...(nativeManifest.contracts?.gatewayMethodDispatch ?? []),
              'authenticated-request',
            ]),
          ],
        },
      },
      null,
      2,
    ) + '\n',
  );
  if (await exists(path.join(source, 'skills')))
    await cp(path.join(source, 'skills'), path.join(packageRoot, 'skills'), { recursive: true });
  await writePackageLicenses({
    source,
    packageRoot,
    pkg,
    licenseFile: options.licenseFile,
    dependencyRoots: [...dependencyRoots],
    metafiles: [
      native.metafile,
      main.metafile,
      browser.metafile,
      ...(presentation ? [presentation.metafile] : []),
    ],
  });
  await cp(root, path.join(packageRoot, 'app'), { recursive: true });
  return { id: manifest.id, hash, root, packageRoot };
}

export async function buildAppPlugins(options = {}) {
  const sourceRoot = path.resolve(options.sourceRoot ?? 'plugins/extensions');
  const destination = path.resolve(options.destination ?? 'build/app-plugins');
  const result = [];
  for (const { source } of await discoverAppPluginSources(sourceRoot))
    result.push(await buildAppPlugin(source, destination, options));
  await mkdir(destination, { recursive: true });
  await writeFile(
    path.join(destination, 'catalog.json'),
    JSON.stringify(
      result.map(({ id, hash }) => ({ id, hash })),
      null,
      2,
    ) + '\n',
  );
  return result;
}
