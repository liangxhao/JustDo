import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

const { buildManagedPipInstallArgs, enableSitePackages } =
  require('../../scripts/setup-python-runtime.js') as {
    buildManagedPipInstallArgs: (targetDir: string, requirementsPath: string) => string[];
    enableSitePackages: (rootDir: string) => void;
  };

const requirementsPath = path.resolve(__dirname, '../../resources/python-requirements.txt');

test('locks the supported Python packages and transitive dependencies with hashes', () => {
  const requirements = fs
    .readFileSync(requirementsPath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));

  expect(requirements.map(line => line.split('==')[0])).toEqual([
    'requests',
    'PyYAML',
    'openpyxl',
    'pypdf',
    'beautifulsoup4',
    'certifi',
    'charset-normalizer',
    'et-xmlfile',
    'idna',
    'soupsieve',
    'typing-extensions',
    'urllib3',
  ]);
  for (const requirement of requirements) {
    expect(requirement).toMatch(/^[A-Za-z0-9_.-]+==[^\s]+ --hash=sha256:[a-f0-9]{64}$/);
  }
});

test('builds a binary-only hashed pip install for CPython 3.12 on Windows x64', () => {
  const args = buildManagedPipInstallArgs('C:\\runtime\\managed', requirementsPath);

  expect(args).toContain('--only-binary=:all:');
  expect(args).toContain('--require-hashes');
  expect(args).toContain('win_amd64');
  expect(args).toContain('cp312');
  expect(args).toContain('3.12');
  expect(args).toContain('C:\\runtime\\managed');
  expect(args).toContain(requirementsPath);
});

test('adds managed site-packages after the runtime pip directory idempotently', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'justdo-python-pth-'));
  const pthPath = path.join(tempRoot, 'python312._pth');

  try {
    fs.writeFileSync(pthPath, 'python312.zip\n.\n\n#import site\n', 'utf8');
    enableSitePackages(tempRoot);
    const first = fs.readFileSync(pthPath, 'utf8');
    enableSitePackages(tempRoot);
    const second = fs.readFileSync(pthPath, 'utf8');

    expect(second).toBe(first);
    expect(second.indexOf('Lib\\site-packages')).toBeLessThan(
      second.indexOf('Lib\\bundled-site-packages'),
    );
    expect(second.match(/import site/g)).toHaveLength(1);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('setup replaces the managed package directory instead of retaining stale files', () => {
  const setupScript = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/setup-python-runtime.js'),
    'utf8',
  );

  expect(setupScript).toContain('fs.rmSync(managedDir, { recursive: true, force: true })');
  expect(setupScript.indexOf('fs.rmSync(managedDir')).toBeLessThan(
    setupScript.indexOf('installManagedPackagesWithPip(rootDir, managedDir'),
  );
});

test('bundles sitecustomize support for skill PYTHONPATH and persistent user packages', () => {
  const siteCustomize = fs.readFileSync(
    path.resolve(__dirname, '../../resources/python-sitecustomize.py'),
    'utf8',
  );
  const setupScript = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/setup-python-runtime.js'),
    'utf8',
  );

  expect(siteCustomize).toContain('os.environ.get("PYTHONPATH", "")');
  expect(siteCustomize).toContain('raw_pythonpath.split(os.pathsep)');
  expect(siteCustomize).toContain('sys.path[:] = pythonpath_entries + [');
  expect(siteCustomize.lastIndexOf('_add_pythonpath()')).toBeLessThan(
    siteCustomize.lastIndexOf('_add_justdo_user_sites()'),
  );
  expect(siteCustomize).toContain('JUSTDO_PYTHON_USER_SITE');
  expect(siteCustomize).not.toContain('JUSTDO_PYTHON_LEGACY_SITE');
  expect(siteCustomize).toContain('if "install" in pip_args and not has_conflicting_option');
  expect(siteCustomize).toContain('os.environ.setdefault("PIP_USER", "true")');
  expect(siteCustomize).toContain('bundled-site-packages');
  expect(setupScript).toContain('python-sitecustomize.py');
  expect(setupScript).toContain('fs.copyFileSync(DEFAULT_SITE_CUSTOMIZE_PATH, siteCustomizePath)');
});
