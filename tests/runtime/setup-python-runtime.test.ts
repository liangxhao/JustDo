import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

const { buildManagedPipInstallArgs, enableSitePackages, ensureBundledPythonPackages } =
  require('../../scripts/runtime/setup-python-runtime.js') as {
    buildManagedPipInstallArgs: (targetDir: string, requirementsPath: string) => string[];
    enableSitePackages: (rootDir: string) => void;
    ensureBundledPythonPackages: (rootDir: string, options: Record<string, unknown>) => { reused: boolean };
  };

const requirementsPath = path.resolve(__dirname, '../../resources/python/requirements.txt');

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

test('bundles sitecustomize support for skill PYTHONPATH and persistent user packages', () => {
  const siteCustomize = fs.readFileSync(
    path.resolve(__dirname, '../../resources/python/sitecustomize.py'),
    'utf8',
  );
  const setupScript = fs.readFileSync(
    path.resolve(__dirname, '../../scripts/runtime/setup-python-runtime.js'),
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
  expect(setupScript).toContain("'sitecustomize.py'");
  expect(setupScript).toContain("['-B', '-c', script]");
});

const fixtureDirectories: string[] = [];
afterEach(() => {
  for (const directory of fixtureDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function packageFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'python-package-cache-'));
  fixtureDirectories.push(directory);
  const rootDir = path.join(directory, '运行时 with spaces');
  const managedDir = path.join(rootDir, 'Lib/bundled-site-packages');
  const customizePath = path.join(rootDir, 'Lib/site-packages/sitecustomize.py');
  const proofPath = path.join(directory, `${path.basename(rootDir)}-packages-proof.json`);
  fs.mkdirSync(managedDir, { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'python.exe'), 'interpreter');
  fs.writeFileSync(path.join(rootDir, 'python312._pth'), 'Lib\\bundled-site-packages\nimport site\n');
  const inputRequirements = path.join(directory, 'requirements.txt');
  const inputCustomize = path.join(directory, 'sitecustomize.py');
  fs.writeFileSync(inputRequirements, 'example==1.0 --hash=sha256:example');
  fs.writeFileSync(inputCustomize, '# site setup\n');
  const install = vi.fn((_root: string, target: string) => {
    fs.mkdirSync(path.join(target, 'example/__pycache__'), { recursive: true });
    fs.writeFileSync(path.join(target, 'example/__init__.py'), 'value = 1\n');
    fs.writeFileSync(path.join(target, 'example/__pycache__/module.pyc'), 'bytecode');
  });
  const verify = vi.fn();
  const options = {
    requirementsPath: inputRequirements, siteCustomizePath: inputCustomize,
    install, verify, log: vi.fn(),
  };
  return {
    directory, rootDir, managedDir, customizePath, proofPath, inputRequirements, inputCustomize,
    install, verify, options,
    prepare: () => ensureBundledPythonPackages(rootDir, options),
  };
}

test('installs once, removes stale files, then reuses verified packages without reinstalling', () => {
  const fixture = packageFixture();
  const staleFile = path.join(fixture.managedDir, 'retired.py');
  fs.writeFileSync(staleFile, 'obsolete');

  expect(fixture.prepare()).toEqual({ reused: false });
  expect(fs.existsSync(staleFile)).toBe(false);
  expect(fs.readFileSync(fixture.customizePath, 'utf8')).toBe('# site setup\n');
  expect(fixture.prepare()).toEqual({ reused: true });
  expect(fixture.install).toHaveBeenCalledTimes(1);
  expect(fixture.verify).toHaveBeenCalledTimes(2);
  expect(path.dirname(fixture.proofPath)).toBe(path.dirname(fixture.rootDir));
});

test.each(['requirements', 'site setup', 'interpreter', 'import path'])(
  'reinstalls when the %s input changes', input => {
    const fixture = packageFixture();
    fixture.prepare();
    const file = {
      requirements: fixture.inputRequirements,
      'site setup': fixture.inputCustomize,
      interpreter: path.join(fixture.rootDir, 'python.exe'),
      'import path': path.join(fixture.rootDir, 'python312._pth'),
    }[input]!;
    fs.appendFileSync(file, '# changed');

    expect(fixture.prepare()).toEqual({ reused: false });
    expect(fixture.install).toHaveBeenCalledTimes(2);
  },
);

test.each(['changed', 'missing', 'extra', 'bytecode', 'site setup', 'site bytecode'])(
  'reinstalls a %s installed payload without accepting its old proof', change => {
    const fixture = packageFixture();
    fixture.prepare();
    const module = path.join(fixture.managedDir, 'example/__init__.py');
    if (change === 'changed') fs.writeFileSync(module, 'value = 2\n'); // Same length.
    if (change === 'missing') fs.rmSync(module);
    if (change === 'extra') fs.writeFileSync(path.join(fixture.managedDir, 'extra.py'), 'extra');
    if (change === 'bytecode') fs.writeFileSync(path.join(fixture.managedDir, 'example/__pycache__/module.pyc'), 'modified');
    if (change === 'site setup') fs.writeFileSync(fixture.customizePath, '# modified\n');
    if (change === 'site bytecode') {
      const cacheDirectory = path.join(path.dirname(fixture.customizePath), '__pycache__');
      fs.mkdirSync(cacheDirectory);
      fs.writeFileSync(path.join(cacheDirectory, 'sitecustomize.cpython-312.pyc'), 'modified');
    }

    expect(fixture.prepare()).toEqual({ reused: false });
    expect(fixture.install).toHaveBeenCalledTimes(2);
    if (change === 'site bytecode') {
      expect(fs.existsSync(path.join(path.dirname(fixture.customizePath), '__pycache__/sitecustomize.cpython-312.pyc'))).toBe(false);
    }
    expect(fixture.prepare()).toEqual({ reused: true });
  },
);

test('clears only sitecustomize bytecode before launching the package installer', () => {
  const fixture = packageFixture();
  fs.mkdirSync(path.dirname(fixture.customizePath), { recursive: true });
  const staleBytecode = path.join(path.dirname(fixture.customizePath), 'sitecustomize.pyc');
  const unrelatedFile = path.join(path.dirname(fixture.customizePath), 'pip.pyc');
  fs.writeFileSync(staleBytecode, 'obsolete');
  fs.writeFileSync(unrelatedFile, 'pip');
  fixture.install.mockImplementationOnce(() => {
    expect(fs.existsSync(staleBytecode)).toBe(false);
    expect(fs.existsSync(unrelatedFile)).toBe(true);
    expect(fs.readFileSync(fixture.customizePath, 'utf8')).toBe('# site setup\n');
  });

  expect(fixture.prepare()).toEqual({ reused: false });
});

test('reinstalls when cache evidence is malformed', () => {
  const fixture = packageFixture();
  fixture.prepare();
  fs.writeFileSync(fixture.proofPath, '{incomplete');

  expect(fixture.prepare()).toEqual({ reused: false });
  expect(fixture.install).toHaveBeenCalledTimes(2);
});

test('invalidates evidence before installation and leaves no usable proof on failure', () => {
  const fixture = packageFixture();
  fixture.prepare();
  fs.appendFileSync(fixture.inputRequirements, '\nchanged');
  fixture.install.mockImplementationOnce(() => {
    expect(fs.existsSync(fixture.proofPath)).toBe(false);
    throw new Error('installation failed');
  });

  expect(fixture.prepare).toThrow('installation failed');
  expect(fs.existsSync(fixture.proofPath)).toBe(false);
  expect(fixture.prepare()).toEqual({ reused: false });
});

test('repairs a cached payload whose import check fails', () => {
  const fixture = packageFixture();
  fixture.prepare();
  fixture.verify.mockImplementationOnce(() => { throw new Error('import failed'); });

  expect(fixture.prepare()).toEqual({ reused: false });
  expect(fixture.install).toHaveBeenCalledTimes(2);
  expect(fixture.verify).toHaveBeenCalledTimes(3);
});

test('does not publish evidence when imports still fail after installation', () => {
  const fixture = packageFixture();
  fixture.prepare();
  fixture.verify.mockImplementation(() => { throw new Error('import failed'); });

  expect(fixture.prepare).toThrow('import failed');
  expect(fs.existsSync(fixture.proofPath)).toBe(false);
});

test('rejects package directory links instead of signing external files into cache evidence', () => {
  const fixture = packageFixture();
  const external = path.join(fixture.directory, 'external');
  fs.mkdirSync(external);
  fixture.install.mockImplementationOnce((_root: string, target: string) => {
    fs.symlinkSync(external, path.join(target, 'borrowed'), process.platform === 'win32' ? 'junction' : 'dir');
  });

  expect(fixture.prepare).toThrow(/non-regular entry/);
  expect(fs.existsSync(fixture.proofPath)).toBe(false);
});
