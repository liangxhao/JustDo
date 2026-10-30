import { existsSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const licenseName = /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/iu;

const inside = (root, file) => {
  const relative = path.relative(root, file);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
  );
};

/** Provenance covers files actually bundled, without copying dependency source trees. */
export async function writePackageLicenses({
  source,
  packageRoot,
  pkg,
  metafiles,
  licenseFile,
  dependencyRoots,
}) {
  const sourceRoot = realpathSync(source);
  const ownLicense = (await readdir(source, { withFileTypes: true })).find(
    entry => entry.isFile() && /^licen[cs]e(?:[.-].*)?$/iu.test(entry.name),
  );
  const ownFile = ownLicense ? path.join(source, ownLicense.name) : licenseFile;
  if (!ownFile) throw new Error('App plugin must provide its own LICENSE');
  await copyFile(ownFile, path.join(packageRoot, 'LICENSE'));
  const packages = new Map();
  const roots = dependencyRoots
    .map(directory => realpathSync(directory))
    .sort((left, right) => right.length - left.length);
  for (const metafile of metafiles) {
    for (const input of Object.keys(metafile.inputs)) {
      const file = path.resolve(source, input);
      if (!existsSync(file)) continue; // Virtual JSX adapters and the generated native wrapper.
      const actual = realpathSync(file);
      // A dependency can contain package.json files used only to set module type.
      // Its root comes from installed-export resolution, not the nearest JSON file.
      const directory = roots.find(root => inside(root, actual));
      if (directory) {
        if (!packages.has(directory))
          packages.set(directory, {
            directory,
            metadata: JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')),
          });
      } else if (!inside(sourceRoot, actual)) {
        throw new Error('Bundled input has no resolved dependency package: ' + actual);
      }
    }
  }
  const notices = [];
  for (const { directory, metadata } of packages.values()) {
    if (typeof metadata.name !== 'string' || typeof metadata.version !== 'string')
      throw new Error('Bundled dependency must declare name and version: ' + directory);
    const files = (await readdir(directory, { withFileTypes: true })).filter(
      entry => entry.isFile() && licenseName.test(entry.name),
    );
    if (!files.length) throw new Error('Bundled dependency has no license file: ' + metadata.name);
    const prefix = (metadata.name + '-' + metadata.version).replace(/[^a-zA-Z0-9_.-]/gu, '_');
    const licenses = [];
    for (const file of files) {
      const relative = 'licenses/' + prefix + '/' + file.name;
      const target = path.join(packageRoot, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(directory, file.name), target);
      licenses.push(relative);
    }
    notices.push({
      name: metadata.name,
      version: metadata.version,
      license: metadata.license ?? null,
      files: licenses.sort(),
    });
  }
  notices.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  await writeFile(
    path.join(packageRoot, 'THIRD_PARTY_NOTICES.json'),
    JSON.stringify(
      {
        package: { name: pkg.name, version: pkg.version },
        dependencies: notices,
      },
      null,
      2,
    ) + '\n',
  );
}
