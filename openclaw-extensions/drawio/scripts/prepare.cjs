'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { build } = require('esbuild');
const extension = path.resolve(__dirname, '..');
const root = path.resolve(extension, '../..');
const upstream = require('../upstream.json');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const sourceHash = () =>
  hash(
    Buffer.concat([
      ...[
        'server.mjs',
        'editor-resource.mjs',
        'app.ts',
        'app.css',
        'editor-bridge.js',
        'upstream.json',
        'licenses/saxes-6.0.0.txt',
      ].map(file => fs.readFileSync(path.join(extension, file))),
      fs.readFileSync(__filename),
      Buffer.from(
        ['esbuild', '@modelcontextprotocol/sdk', '@modelcontextprotocol/ext-apps', 'saxes']
          .map(name => fs.readFileSync(path.join(root, 'node_modules', name, 'package.json')))
          .join('\n'),
      ),
    ]),
  );
const filesIn = directory =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Diagram assets must not contain symbolic links');
    return entry.isDirectory() ? filesIn(file) : [file];
  });

function verifyDrawioAssets(directory = path.join(extension, 'assets'), checkSources = true) {
  if (!fs.existsSync(path.join(directory, 'integrity.json')))
    throw new Error(
      'Missing offline draw.io assets; run npm run drawio:prepare with the pinned archive (see docs/offline-downloads.md)',
    );
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'integrity.json'), 'utf8'));
  if (manifest.commit !== upstream.commit || (checkSources && manifest.sourceHash !== sourceHash()))
    throw new Error('Draw.io assets are stale; run npm run drawio:prepare with the pinned archive');
  const expected = new Set(Object.keys(manifest.files));
  for (const file of filesIn(directory)) {
    const relative = path.relative(directory, file).replaceAll('\\', '/');
    if (relative === 'integrity.json') continue;
    if (!expected.delete(relative) || hash(fs.readFileSync(file)) !== manifest.files[relative])
      throw new Error(`Draw.io asset integrity mismatch: ${relative}`);
  }
  if (expected.size) throw new Error(`Missing draw.io asset: ${[...expected][0]}`);
  for (const required of [
    'server.cjs',
    'editor-resource.cjs',
    'app.js',
    'app.css',
    'public/editor/index.html',
    'public/editor/js/app.min.js',
    'LICENSE',
  ])
    if (!manifest.files[required]) throw new Error(`Incomplete draw.io bundle: ${required}`);
  return manifest;
}

async function prepare(archive) {
  const bytes = fs.readFileSync(archive);
  if (hash(bytes) !== upstream.archiveSha256)
    throw new Error('Draw.io source archive SHA-256 mismatch');
  const staging = path.join(root, 'build', `drawio-${upstream.commit}`);
  fs.mkdirSync(staging, { recursive: true });
  const sourceName = `drawio-${upstream.commit}`;
  const result = spawnSync(
    'tar',
    [
      '-xzf',
      path.resolve(archive),
      '-C',
      staging,
      `${sourceName}/src/main/webapp`,
      `${sourceName}/LICENSE`,
    ],
    { windowsHide: true, stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error('Could not extract draw.io source archive');
  const output = path.join(extension, 'assets');
  // Fixed absolute target under this extension; never remove caller-provided paths.
  if (path.dirname(output) !== extension) throw new Error('Invalid draw.io output path');
  fs.rmSync(output, { recursive: true, force: true });
  fs.mkdirSync(path.join(output, 'public'), { recursive: true });
  fs.cpSync(path.join(staging, sourceName, 'src/main/webapp'), path.join(output, 'public/editor'), {
    recursive: true,
  });
  fs.copyFileSync(path.join(staging, sourceName, 'LICENSE'), path.join(output, 'LICENSE'));
  fs.copyFileSync(path.join(extension, 'app.css'), path.join(output, 'app.css'));
  fs.appendFileSync(
    path.join(output, 'public/editor/js/app.min.js'),
    '\n' + fs.readFileSync(path.join(extension, 'editor-bridge.js'), 'utf8'),
  );
  const indexPath = path.join(output, 'public/editor/index.html');
  fs.writeFileSync(
    indexPath,
    fs
      .readFileSync(indexPath, 'utf8')
      .replace(
        '</head>',
        '<style>a[href^="https://"],a[href^="http://"]{display:none!important}</style></head>',
      ),
  );
  // Configure the real draw.io web editor for local assets only. CSP also blocks all egress.
  fs.writeFileSync(
    path.join(output, 'public/editor/js/PreConfig.js'),
    `window.DRAWIO_CONFIG={defaultFonts:["Arial","Helvetica","Verdana","Times New Roman","Courier New"],fontCss:'',enableCustomFonts:false};\nwindow.EXPORT_URL='';window.PLANT_URL='';window.DRAWIO_GOOGLE_APP_ID='';window.DRAWIO_GOOGLE_CLIENT_ID='';\n`,
  );
  const serverBuild = await build({
    absWorkingDir: root,
    entryPoints: [path.join(extension, 'server.mjs')],
    outfile: path.join(output, 'server.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    minify: true,
    legalComments: 'eof',
    metafile: true,
  });
  const appBuild = await build({
    absWorkingDir: root,
    entryPoints: [path.join(extension, 'app.ts')],
    outfile: path.join(output, 'app.js'),
    bundle: true,
    platform: 'browser',
    target: 'chrome134',
    format: 'iife',
    minify: true,
    legalComments: 'eof',
    metafile: true,
  });
  await build({
    absWorkingDir: root,
    entryPoints: [path.join(extension, 'editor-resource.mjs')],
    outfile: path.join(output, 'editor-resource.cjs'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    minify: true,
    legalComments: 'eof',
  });
  const packages = new Map();
  for (const input of Object.keys({
    ...serverBuild.metafile.inputs,
    ...appBuild.metafile.inputs,
  })) {
    let directory = path.dirname(path.resolve(root, input));
    while (directory.startsWith(path.join(root, 'node_modules') + path.sep)) {
      const packageFile = path.join(directory, 'package.json');
      if (fs.existsSync(packageFile)) {
        const metadata = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
        if (metadata.name) {
          packages.set(directory, metadata);
          break;
        }
      }
      directory = path.dirname(directory);
    }
  }
  const notices = [];
  for (const [directory, metadata] of packages) {
    const packageKey = `${metadata.name.replaceAll('/', '__')}-${metadata.version}`;
    const destination = path.join(output, 'licenses', packageKey);
    fs.mkdirSync(destination, { recursive: true });
    const legalFiles = fs
      .readdirSync(directory)
      .filter(
        file =>
          /^(?:licen[sc]e|copying|notice)(?:\.|$)/i.test(file) &&
          fs.statSync(path.join(directory, file)).isFile(),
      );
    for (const file of legalFiles)
      fs.copyFileSync(path.join(directory, file), path.join(destination, file));
    // Some published packages omit their license file. Keep the pinned upstream
    // notice in this plugin; preparing an installer must never fetch it online.
    if (!legalFiles.length) {
      fs.copyFileSync(
        path.join(extension, 'licenses', `${packageKey}.txt`),
        path.join(destination, 'LICENSE'),
      );
      legalFiles.push('LICENSE');
    }
    notices.push({
      name: metadata.name,
      version: metadata.version,
      license: metadata.license,
      directory: path.relative(output, destination).replaceAll('\\', '/'),
      files: legalFiles,
    });
  }
  fs.writeFileSync(path.join(output, 'THIRD_PARTY_NOTICES.json'), JSON.stringify(notices, null, 2));
  const files = Object.fromEntries(
    filesIn(output)
      .sort()
      .map(file => [
        path.relative(output, file).replaceAll('\\', '/'),
        hash(fs.readFileSync(file)),
      ]),
  );
  fs.writeFileSync(
    path.join(output, 'integrity.json'),
    JSON.stringify({ commit: upstream.commit, sourceHash: sourceHash(), files }),
  );
  verifyDrawioAssets(output);
  console.log(`[DiagramEditor] Prepared ${Object.keys(files).length} verified offline files`);
}

if (require.main === module) {
  (async () => {
    if (process.argv.includes('--verify')) {
      verifyDrawioAssets();
      console.log('[DiagramEditor] Offline assets verified');
      return;
    }
    const ensure = process.argv.includes('--ensure');
    if (ensure) {
      try {
        verifyDrawioAssets();
        console.log('[DiagramEditor] Offline assets verified; reusing existing bundle');
        return;
      } catch (error) {
        console.log(`[DiagramEditor] Preparing offline assets: ${error.message}`);
      }
    }
    const archiveIndex = process.argv.indexOf('--archive');
    const archive =
      archiveIndex >= 0
        ? process.argv[archiveIndex + 1]
        : path.join(root, 'resources/drawio-cache', `drawio-${upstream.commit}.tar.gz`);
    if (process.argv.includes('--download') && (!ensure || !fs.existsSync(archive))) {
      fs.mkdirSync(path.dirname(archive), { recursive: true });
      const response = await fetch(
        `https://codeload.github.com/jgraph/drawio/tar.gz/${upstream.commit}`,
      );
      if (!response.ok) throw new Error(`Draw.io download failed (${response.status})`);
      fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    }
    await prepare(archive);
  })().catch(error => {
    console.error(`[DiagramEditor] ${error.message}`);
    process.exitCode = 1;
  });
}
module.exports = { verifyDrawioAssets };
