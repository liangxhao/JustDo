'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const pluginRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(pluginRoot, '../../..');
const upstreamPath = path.join(pluginRoot, 'libraries/upstreams.json');
const defaultOutput = path.join(pluginRoot, 'assets');
const ids = new Set(['three', 'echarts', 'katex', 'mermaid', 'd3', 'matter']);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const legalPath = name =>
  name
    .split('/')
    .some(segment =>
      /^(?:licen[cs]es?|copying|copyright|notices?|third[_-]party[_-](?:notices?|licenses?))(?:[._-].+)?$/i.test(
        segment,
      ),
    );

function safeRelative(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !value.includes('\\') &&
    !value.includes(':') &&
    !value.startsWith('/') &&
    value.split('/').every(segment => segment && segment !== '.' && segment !== '..')
  );
}

function readUpstreams() {
  return JSON.parse(fs.readFileSync(upstreamPath, 'utf8'));
}

function validateUpstreams(manifest) {
  if (
    manifest?.schemaVersion !== 1 ||
    !Array.isArray(manifest.libraries) ||
    !manifest.libraries.length
  )
    throw new Error('Invalid widget library upstream manifest');
  const seen = new Set();
  for (const library of manifest.libraries) {
    if (
      !ids.has(library.id) ||
      seen.has(library.id) ||
      !/^[a-z0-9][a-z0-9-]*$/.test(library.packageName) ||
      !/^\d+\.\d+\.\d+$/.test(library.version) ||
      !/^[a-z0-9][a-z0-9.-]*\.tgz$/.test(library.archive) ||
      !/^sha512-[A-Za-z0-9+/]{86}==$/.test(library.integrity) ||
      !safeRelative(library.entry) ||
      !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(library.global) ||
      typeof library.license !== 'string' ||
      !library.license ||
      library.resourcePath !== `/__widget_kit__/libraries/${library.id}-${library.version}.js` ||
      (library.supplementalLicense && !safeRelative(library.supplementalLicense))
    )
      throw new Error('Invalid widget library upstream entry');
    seen.add(library.id);
  }
  return manifest;
}

function sourceHash(manifest = readUpstreams()) {
  const digest = crypto.createHash('sha256');
  digest.update(fs.readFileSync(__filename));
  digest.update(JSON.stringify(manifest));
  digest.update(require('esbuild').version);
  for (const library of manifest.libraries) {
    if (library.supplementalLicense)
      digest.update(
        fs.readFileSync(path.join(pluginRoot, 'libraries', library.supplementalLicense)),
      );
  }
  return digest.digest('hex');
}

function filesIn(directory, prefix = '') {
  if (fs.lstatSync(directory).isSymbolicLink())
    throw new Error('Widget assets cannot contain links');
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error('Widget assets cannot contain links');
      if (entry.isDirectory()) return filesIn(path.join(directory, entry.name), relative);
      if (!entry.isFile()) throw new Error('Widget assets must be regular files');
      return [relative];
    })
    .sort();
}

/** Verifies the exact bytes returned by a public resource reader against its prepared manifest. */
function verifyWidgetLibraryResource(resourcePath, body, integrity) {
  const entry = integrity?.resources?.[resourcePath];
  if (
    !entry ||
    !(body instanceof Uint8Array) ||
    body.byteLength !== entry.bytes ||
    hash(body) !== entry.sha256
  )
    throw new Error('Widget library resource integrity mismatch');
  return entry;
}

/** checkSources=false verifies a copied/packaged payload without needing build dependencies. */
function verifyWidgetLibraryAssets(directory = defaultOutput, checkSources = true, options = {}) {
  const manifest = validateUpstreams(options.manifest || readUpstreams());
  const integrityFile = path.join(directory, 'integrity.json');
  if (!fs.existsSync(integrityFile))
    throw new Error(
      'Missing offline widget libraries; run npm run widget-kit:prepare (see docs/offline-downloads.md)',
    );
  const integrity = JSON.parse(fs.readFileSync(integrityFile, 'utf8'));
  if (
    integrity.schemaVersion !== 1 ||
    !integrity.files ||
    !integrity.resources ||
    !/^[a-f0-9]{64}$/.test(integrity.sourceHash) ||
    JSON.stringify(integrity.upstreams) !== JSON.stringify(manifest.libraries) ||
    (checkSources && integrity.sourceHash !== sourceHash(manifest))
  )
    throw new Error(
      'Offline widget library assets are stale or invalid; run npm run widget-kit:prepare',
    );
  const expected = new Set(Object.keys(integrity.files));
  for (const file of expected) {
    if (
      !safeRelative(file) ||
      file === 'integrity.json' ||
      !/^[a-f0-9]{64}$/.test(integrity.files[file])
    )
      throw new Error('Invalid widget library asset entry');
  }
  for (const file of filesIn(directory)) {
    if (file === 'integrity.json') continue;
    if (
      !expected.delete(file) ||
      hash(fs.readFileSync(path.join(directory, file))) !== integrity.files[file]
    )
      throw new Error(`Widget library asset integrity mismatch: ${file}`);
  }
  if (expected.size) throw new Error(`Missing widget library asset: ${[...expected][0]}`);
  if (Object.keys(integrity.resources).length !== manifest.libraries.length)
    throw new Error('Unexpected widget library resources');
  for (const library of manifest.libraries) {
    const entry = integrity.resources[library.resourcePath];
    const file = `libraries/${library.id}-${library.version}.js`;
    if (
      entry?.file !== file ||
      entry.sha256 !== integrity.files[file] ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 1
    )
      throw new Error('Incomplete widget library resource manifest');
    verifyWidgetLibraryResource(
      library.resourcePath,
      fs.readFileSync(path.join(directory, file)),
      integrity,
    );
    const licensePrefix = `licenses/${library.id}-${library.version}/`;
    if (
      !Object.keys(integrity.files).some(
        name => name.startsWith(licensePrefix) && legalPath(name.slice(licensePrefix.length)),
      )
    )
      throw new Error(`Missing widget library license: ${library.id}`);
  }
  if (!integrity.files['THIRD_PARTY_NOTICES.json'])
    throw new Error('Missing widget library notices');
  return integrity;
}

function extractPackage(bytes, directory, library) {
  const tar = require('tar');
  const selected = name =>
    name === 'package.json' ||
    name === library.entry ||
    legalPath(name) ||
    (library.id === 'three' &&
      ['build/three.core.js', 'examples/jsm/controls/OrbitControls.js'].includes(name)) ||
    (library.id === 'katex' &&
      (['dist/katex.min.css', 'dist/contrib/auto-render.min.js'].includes(name) ||
        /^dist\/fonts\/[^/]+\.woff2$/.test(name)));
  const entries = [];
  tar
    .t({
      sync: true,
      strict: true,
      onentry(entry) {
        const name = entry.path.replace(/\/$/, '');
        if ((name !== 'package' && !name.startsWith('package/')) || !safeRelative(name))
          throw new Error('Invalid widget library archive path');
        if (entry.type === 'Directory') return;
        if (selected(name.slice('package/'.length))) {
          if (entry.type !== 'File')
            throw new Error('Widget library archive assets must be regular files');
          entries.push(name);
        }
      },
    })
    .end(bytes);
  fs.mkdirSync(directory, { recursive: true });
  const included = new Set(entries);
  tar
    .x({ cwd: directory, strip: 1, sync: true, strict: true, filter: name => included.has(name) })
    .end(bytes);
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  if (pkg.name !== library.packageName || pkg.version !== library.version)
    throw new Error(`Widget library archive identity mismatch: ${library.id}`);
  return entries.map(name => name.slice('package/'.length));
}

function katexBootstrap(fonts, css) {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  // Binary FontFace sources perform no URL load. data: font URLs are denied by
  // the inherited native proxy CSP, even when the inner document permits them.
  const loaded = fonts.map(font => {
    const bytes = Uint8Array.from(atob(font.base64), character => character.charCodeAt(0));
    const face = new FontFace(font.family, bytes.buffer, {
      style: font.style,
      weight: font.weight,
      display: 'block',
    });
    document.fonts.add(face);
    return face.load();
  });
  globalThis.katexFontsReady = Promise.all(loaded)
    .then(() => document.fonts.ready)
    .then(() => undefined);
  // Keep the rejection observable for callers while reporting a fixed native
  // widget runtime error even when authored code does not await fontsReady.
  globalThis.katexFontsReady.catch(() => {
    dispatchEvent(
      new ErrorEvent('error', {
        message: 'Widget math fonts unavailable',
        error: new Error('Widget math fonts unavailable'),
      }),
    );
  });
}

function katexSource(directory, library) {
  const css = fs.readFileSync(path.join(directory, 'dist/katex.min.css'), 'utf8');
  const fonts = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].map(([, declarations]) => {
    const value = name => new RegExp(`${name}:\\s*([^;]+)`).exec(declarations)?.[1]?.trim();
    const fontPath = /url\((fonts\/[^)]+\.woff2)\)/.exec(declarations)?.[1];
    if (
      !fontPath ||
      !safeRelative(fontPath) ||
      !value('font-family') ||
      !value('font-style') ||
      !value('font-weight')
    )
      throw new Error('Unsupported offline KaTeX font declaration');
    const fontBytes = fs.readFileSync(path.join(directory, 'dist', fontPath));
    if (fontBytes.subarray(0, 4).toString('ascii') !== 'wOF2')
      throw new Error('Invalid KaTeX WOFF2 font');
    return {
      family: value('font-family').replace(/^['"]|['"]$/g, ''),
      style: value('font-style'),
      weight: value('font-weight'),
      base64: fontBytes.toString('base64'),
    };
  });
  if (fonts.length !== 20) throw new Error('Incomplete offline KaTeX fonts');
  const layoutCss = css.replace(/@font-face\s*\{[^}]+\}/g, '');
  if (/url\s*\(|@import\b/i.test(layoutCss))
    throw new Error('KaTeX CSS contains an external resource');
  return (
    fs.readFileSync(path.join(directory, library.entry), 'utf8') +
    '\n' +
    fs.readFileSync(path.join(directory, 'dist/contrib/auto-render.min.js'), 'utf8') +
    '\n' +
    `(${katexBootstrap.toString()})(${JSON.stringify(fonts)},${JSON.stringify(layoutCss)});\n`
  );
}

function validateClassicSource(source) {
  const tree = require('acorn').parse(source, { ecmaVersion: 'latest', sourceType: 'script' });
  const visit = node => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ImportExpression')
      throw new Error('Widget library bundle contains a dynamic import');
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') visit(value);
    }
  };
  visit(tree);
}

function copyLicenses(directory, output, library, packageFiles, source) {
  const target = path.join(output, 'licenses', `${library.id}-${library.version}`);
  const files = [];
  for (const name of packageFiles.filter(legalPath)) {
    const destination = path.join(target, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(directory, name), destination);
    files.push(name);
  }
  if (library.supplementalLicense) {
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(
      path.join(pluginRoot, 'libraries', library.supplementalLicense),
      path.join(target, 'LICENSE'),
    );
    files.push('LICENSE');
  }
  if (!files.length) throw new Error(`Missing widget library upstream license: ${library.id}`);
  const comments =
    source
      .match(/\/\*[\s\S]*?\*\//g)
      ?.filter(comment => /@license|copyright|permission|licensed under/i.test(comment)) || [];
  if (comments.length) {
    fs.writeFileSync(path.join(target, 'NOTICE.bundle.txt'), `${comments.join('\n\n')}\n`);
    files.push('NOTICE.bundle.txt');
  }
  return {
    id: library.id,
    packageName: library.packageName,
    version: library.version,
    license: library.license,
    directory: `licenses/${library.id}-${library.version}`,
    files: files.sort(),
  };
}

/** Reads verified local archives only; no package installation, network or lifecycle scripts. */
async function prepareWidgetLibraryAssets(options = {}) {
  const manifest = validateUpstreams(options.manifest || readUpstreams());
  const output = path.resolve(options.outputDirectory || defaultOutput);
  const cache = path.resolve(options.cacheDirectory || path.join(repoRoot, 'cache/widget-kit'));
  const buildRoot = path.resolve(options.buildDirectory || path.join(repoRoot, 'build/widget-kit'));
  fs.mkdirSync(buildRoot, { recursive: true });
  const staging = fs.mkdtempSync(path.join(buildRoot, 'libraries-'));
  const stagedOutput = path.join(staging, 'assets');
  fs.mkdirSync(path.join(stagedOutput, 'libraries'), { recursive: true });
  try {
    const resources = {};
    const notices = [];
    for (const library of manifest.libraries) {
      const archive = path.join(cache, library.archive);
      if (!fs.existsSync(archive))
        throw new Error(
          `Missing cached widget library archive: ${library.archive}; see docs/offline-downloads.md`,
        );
      const bytes = fs.readFileSync(archive);
      const integrity = `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`;
      if (integrity !== library.integrity)
        throw new Error(`Widget library archive SHA-512 mismatch: ${library.id}`);
      const directory = path.join(staging, 'node_modules', library.packageName);
      const packageFiles = extractPackage(bytes, directory, library);
      let source;
      if (library.id === 'three') {
        const result = await require('esbuild').build({
          stdin: {
            contents:
              "import * as THREE from 'three'; import { OrbitControls } from 'three/addons/controls/OrbitControls.js'; globalThis.THREE = { ...THREE, OrbitControls }; globalThis.OrbitControls = OrbitControls;",
            resolveDir: staging,
          },
          absWorkingDir: staging,
          bundle: true,
          platform: 'browser',
          format: 'iife',
          target: 'chrome134',
          minify: true,
          legalComments: 'eof',
          write: false,
          logLevel: 'silent',
        });
        if (result.outputFiles.length !== 1)
          throw new Error('Three.js must produce one self-contained bundle');
        source = result.outputFiles[0].text;
      } else
        source =
          library.id === 'katex'
            ? katexSource(directory, library)
            : fs.readFileSync(path.join(directory, library.entry), 'utf8');
      validateClassicSource(source);
      const file = `libraries/${library.id}-${library.version}.js`;
      fs.writeFileSync(path.join(stagedOutput, file), source);
      resources[library.resourcePath] = {
        file,
        sha256: hash(source),
        bytes: Buffer.byteLength(source),
      };
      notices.push(copyLicenses(directory, stagedOutput, library, packageFiles, source));
    }
    fs.writeFileSync(
      path.join(stagedOutput, 'THIRD_PARTY_NOTICES.json'),
      `${JSON.stringify(notices, null, 2)}\n`,
    );
    const files = Object.fromEntries(
      filesIn(stagedOutput).map(file => [
        file,
        hash(fs.readFileSync(path.join(stagedOutput, file))),
      ]),
    );
    fs.writeFileSync(
      path.join(stagedOutput, 'integrity.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          sourceHash: sourceHash(manifest),
          upstreams: manifest.libraries,
          resources,
          files,
        },
        null,
        2,
      )}\n`,
    );
    verifyWidgetLibraryAssets(stagedOutput, true, { manifest });
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const previous = path.join(staging, 'previous-assets');
    if (fs.existsSync(output)) {
      filesIn(output); // Reject links before moving an old generated tree into cleanup.
      fs.renameSync(output, previous);
    }
    try {
      fs.renameSync(stagedOutput, output);
    } catch (error) {
      if (fs.existsSync(previous)) fs.renameSync(previous, output);
      throw error;
    }
    return verifyWidgetLibraryAssets(output, true, { manifest });
  } finally {
    // Only delete this freshly created, checked child of the declared build root.
    const resolved = fs.realpathSync(staging);
    const parent = fs.realpathSync(buildRoot);
    if (path.dirname(resolved) !== parent)
      throw new Error('Invalid widget library staging directory');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    if (args.some(argument => !['--verify', '--ensure'].includes(argument)))
      throw new Error('Supported widget library preparation options: --verify, --ensure');
    if (args.includes('--verify')) {
      verifyWidgetLibraryAssets();
      process.stdout.write('[WidgetKit] Offline library assets verified\n');
      return;
    }
    if (args.includes('--ensure')) {
      try {
        verifyWidgetLibraryAssets();
        process.stdout.write('[WidgetKit] Reusing verified offline library assets\n');
        return;
      } catch {
        /* Rebuild only from the explicitly prepared local archives. */
      }
    }
    const integrity = await prepareWidgetLibraryAssets();
    process.stdout.write(
      `[WidgetKit] Prepared ${Object.keys(integrity.resources).length} offline libraries\n`,
    );
  })().catch(error => {
    process.stderr.write(`[WidgetKit] ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  prepareWidgetLibraryAssets,
  verifyWidgetLibraryAssets,
  verifyWidgetLibraryResource,
  readUpstreams,
};
