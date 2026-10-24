'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

const CONTRACT_PATH = 'src/main/startup/upgrade/nativeDatabaseContract.json';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameKeys = (value, keys) => record(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
const identifier = value => typeof value === 'string' && /^[A-Za-z_$][\w$]*$/u.test(value);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function validateContract(contract, version) {
  if (!sameKeys(contract, ['formatVersion', 'openclawVersion', 'schemaVersions', 'sourceSchemaVersions', 'modules']) ||
      contract.formatVersion !== 1 || contract.openclawVersion !== version ||
      !sameKeys(contract.schemaVersions, ['state', 'agent']) ||
      !sameKeys(contract.sourceSchemaVersions, ['state', 'agent']) ||
      !record(contract.modules) || Object.keys(contract.modules).length === 0)
    throw new Error('Native database contract schema or OpenClaw version is invalid.');
  for (const kind of ['state', 'agent']) {
    const current = contract.schemaVersions[kind];
    const sources = contract.sourceSchemaVersions[kind];
    if (!Number.isSafeInteger(current) || current <= 0 || !Array.isArray(sources) || sources.length === 0 ||
        new Set(sources).size !== sources.length || sources.some(value => !Number.isSafeInteger(value) || value < 1 || value > current))
      throw new Error('Native database schema generations are invalid.');
  }
  const paths = new Set();
  for (const [role, owner] of Object.entries(contract.modules)) {
    if (!identifier(role) || !sameKeys(owner, ['path', 'sha256', 'exports']) ||
        !/^dist\/[A-Za-z0-9][A-Za-z0-9._-]*\.mjs$/u.test(owner.path) ||
        !/^[a-f0-9]{64}$/u.test(owner.sha256) || !record(owner.exports) ||
        Object.keys(owner.exports).length === 0 || paths.has(owner.path) ||
        Object.entries(owner.exports).some(([symbol, alias]) => !identifier(symbol) || !identifier(alias)) ||
        new Set(Object.values(owner.exports)).size !== Object.keys(owner.exports).length)
      throw new Error(`Native database owner contract is invalid: ${role}`);
    paths.add(owner.path);
  }
}

function assertExports(source, owner) {
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const declarations = ast.body.flatMap(node => {
    const declaration = node.type === 'ExportNamedDeclaration' ? node.declaration : node;
    if (!declaration) return [];
    if (declaration.type === 'FunctionDeclaration') return declaration.id ? [declaration.id.name] : [];
    if (declaration.type === 'VariableDeclaration')
      return declaration.declarations.filter(item => item.id.type === 'Identifier' && item.init !== null).map(item => item.id.name);
    return [];
  });
  const exports = ast.body.filter(node => node.type === 'ExportNamedDeclaration' && node.source === null)
    .flatMap(node => node.specifiers.map(specifier => ({ local: specifier.local.name, alias: specifier.exported.name })));
  for (const [symbol, alias] of Object.entries(owner.exports)) {
    if (declarations.filter(name => name === symbol).length !== 1 ||
        exports.filter(entry => entry.local === symbol).length !== 1 ||
        exports.filter(entry => entry.local === symbol && entry.alias === alias).length !== 1 ||
        exports.filter(entry => entry.alias === alias).length !== 1)
      throw new Error(`Native database declaration/export binding changed: ${owner.path} ${symbol} as ${alias}`);
  }
}

/** Selected-owner proof only. Complete dependency/artifact proof remains the runtime manifest. */
function readNativeDatabaseContract(repoRoot, version) {
  const contract = JSON.parse(fs.readFileSync(path.join(repoRoot, CONTRACT_PATH), 'utf8'));
  validateContract(contract, version);
  return contract;
}

function verifyNativeDatabaseContract(runtimeRoot, options) {
  const contract = readNativeDatabaseContract(options.repoRoot, options.version);
  const pkg = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'package.json'), 'utf8'));
  if (pkg.name !== 'openclaw' || `v${pkg.version}` !== contract.openclawVersion ||
      canonicalJson(pkg.openclaw?.schemaVersions) !== canonicalJson(contract.schemaVersions))
    throw new Error('Native database schema contract does not match the runtime package.');
  const root = fs.realpathSync(runtimeRoot);
  const dist = path.join(root, 'dist');
  if (fs.lstatSync(dist).isSymbolicLink()) throw new Error('Native database dist directory must not be linked.');
  const archive = path.join(root, 'gateway.asar');
  const archiveExists = fs.existsSync(archive);
  if (!archiveExists && options.allowOmittedGatewayAsar !== true)
    throw new Error('Native database source archive is missing.');
  const asar = archiveExists ? require('@electron/asar') : undefined;
  if (asar) asar.uncache(archive);
  const modules = Object.keys(contract.modules).sort().map(role => {
    const owner = contract.modules[role];
    const file = path.join(root, owner.path);
    const stat = fs.lstatSync(file);
    const relative = path.relative(root, fs.realpathSync(file));
    if (!stat.isFile() || stat.isSymbolicLink() || relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error(`Native database owner is outside its regular source tree: ${owner.path}`);
    const bytes = fs.readFileSync(file);
    if (digest(bytes) !== owner.sha256) throw new Error(`Native database owner bytes changed: ${owner.path}`);
    assertExports(bytes.toString('utf8'), owner);
    if (asar && !asar.extractFile(archive, owner.path).equals(bytes))
      throw new Error(`Native database owner differs from gateway.asar: ${owner.path}`);
    return { role, path: owner.path, sha256: owner.sha256,
      exports: Object.fromEntries(Object.entries(owner.exports).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) };
  });
  return { contractSha256: digest(canonicalJson(contract)), modules };
}

module.exports = { canonicalJson, readNativeDatabaseContract, verifyNativeDatabaseContract };
