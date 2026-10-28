'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const PACKAGE_PROOF_FORMAT = 1;

function hashFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile()) throw new Error(`Python cache input must be a regular file: ${file}`);
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function buildPackageRecipe(rootDir, options) {
  const inputs = [
    ['requirements', options.requirementsPath],
    ['sitecustomize', options.siteCustomizePath],
    ['preparation', options.setupScriptPath],
    ['cache', __filename],
    ...fs.readdirSync(rootDir).filter(name =>
      /^python(?:w|3|\d+)?\.exe$/i.test(name) || /^python\d+\.(?:dll|zip|_pth)$/i.test(name),
    ).sort().map(name => [`runtime/${name}`, path.join(rootDir, name)]),
  ];
  return createHash('sha256').update(JSON.stringify({
    target: 'win_amd64/cp312',
    pythonVersion: options.pythonVersion,
    inputs: inputs.map(([name, file]) => [name, hashFile(file)]),
  })).digest('hex');
}

function siteCustomizeBytecodePaths(siteCustomizePath) {
  const siteDirectory = path.dirname(siteCustomizePath);
  const bytecode = [];
  if (fs.existsSync(path.join(siteDirectory, 'sitecustomize.pyc'))) bytecode.push('sitecustomize.pyc');
  const cacheDirectory = path.join(siteDirectory, '__pycache__');
  if (fs.existsSync(cacheDirectory)) {
    const stat = fs.lstatSync(cacheDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Python site cache must not be a link: ${cacheDirectory}`);
    }
    for (const name of fs.readdirSync(cacheDirectory).sort()) {
      if (/^sitecustomize\..+\.pyc$/i.test(name)) bytecode.push(`__pycache__/${name}`);
    }
  }
  return bytecode;
}

function clearSiteCustomizeBytecode(siteCustomizePath) {
  for (const file of siteCustomizeBytecodePaths(siteCustomizePath)) {
    fs.unlinkSync(path.join(path.dirname(siteCustomizePath), file));
  }
}

function snapshotPackagePayload(managedDir, siteCustomizePath) {
  const entries = [];
  function visit(directory, relative = '') {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Python package directory must not be a link: ${directory}`);
    }
    entries.push({ path: relative, type: 'directory', mode: stat.mode & 0o777 });
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const entryPath = relative ? `${relative}/${name}` : name;
      const entry = fs.lstatSync(file);
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(file, entryPath);
      else if (entry.isFile()) entries.push({
        path: entryPath, type: 'file', mode: entry.mode & 0o777, sha256: hashFile(file),
      });
      else throw new Error(`Python package cache contains a non-regular entry: ${file}`);
    }
  }
  visit(managedDir);
  // -B prevents writes but Python may still execute existing sitecustomize pyc.
  const bytecode = siteCustomizeBytecodePaths(siteCustomizePath).map(file => ({
    path: file, sha256: hashFile(path.join(path.dirname(siteCustomizePath), file)),
  }));
  return { entries, siteCustomizeSha256: hashFile(siteCustomizePath), siteCustomizeBytecode: bytecode };
}

function verifyPackageProof(proofPath, recipeSha256, managedDir, siteCustomizePath) {
  try {
    const proof = JSON.parse(fs.readFileSync(proofPath, 'utf8'));
    return proof.formatVersion === PACKAGE_PROOF_FORMAT && proof.recipeSha256 === recipeSha256 &&
      JSON.stringify(proof.payload) === JSON.stringify(snapshotPackagePayload(managedDir, siteCustomizePath));
  } catch {
    return false;
  }
}

function writePackageProof(proofPath, recipeSha256, managedDir, siteCustomizePath) {
  const proof = {
    formatVersion: PACKAGE_PROOF_FORMAT, recipeSha256,
    payload: snapshotPackagePayload(managedDir, siteCustomizePath),
  };
  const temporary = `${proofPath}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(proof, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, proofPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = { buildPackageRecipe, verifyPackageProof, writePackageProof, clearSiteCustomizeBytecode };
