// Validates isolated Main projections with immutable target schema + real load-time legacy rules.
// Frozen admission intentionally proves archived native bytes, not the current Main recipe.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const expectedVersion = `v${require('../../../package.json').openclaw.version.replace(/^v/u, '')}`;
const runtime = fs.realpathSync(process.argv[2]);
const input = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
assert.ok(Array.isArray(input));
const { verifyFrozenOpenClawRuntime } = require('../../../scripts/openclaw/verify-openclaw-runtime-patches.cjs');
const { hostTarget, targetContract } = require('../../../scripts/runtime/setup-node-runtime.cjs');
const { manifest } = verifyFrozenOpenClawRuntime(runtime, { expectedVersion, requireBundle: true });
assert.equal(manifest.target, hostTarget());
const executable = path.join(runtime, 'node-runtime', targetContract(hostTarget()).executable);
assert.equal(fs.realpathSync(process.execPath), fs.realpathSync(executable));
const asar = require('@electron/asar');
const dist = path.join(runtime, 'dist');
const names = fs.readdirSync(dist);
async function owner(prefix, symbol, declaration) {
  const matches = [];
  for (const file of names.filter(name => name.startsWith(prefix) && name.endsWith('.mjs'))) {
    const content = fs.readFileSync(path.join(dist, file), 'utf8');
    if (!content.includes(declaration)) continue;
    const tail = content.slice(content.lastIndexOf('\nexport {'));
    const match = tail.match(new RegExp('\\b' + symbol + '(?: as ([\\w$]+))?\\s*[,}]'));
    if (match) matches.push({ file, alias: match[1] ?? symbol, content });
  }
  assert.equal(matches.length, 1, 'one actual native owner: ' + symbol);
  const selected = matches[0];
  assert.ok(asar.extractFile(path.join(runtime, 'gateway.asar'), 'dist/' + selected.file)
    .equals(Buffer.from(selected.content)), 'selected native module matches the verified immutable archive');
  return (await import(pathToFileURL(path.join(dist, selected.file)).href))[selected.alias];
}
const schema = await owner('zod-schema-', 'OpenClawSchema', 'const OpenClawSchema =');
const findLegacy = await owner('legacy-', 'findLegacyConfigIssues', 'function findLegacyConfigIssues(');
const results = input.map(({ label, config }) => {
  const parsed = schema.safeParse(config);
  return { label, schemaSuccess: parsed.success,
    schemaIssues: parsed.success ? [] : parsed.error.issues.map(issue => ({
      path: issue.path.join('.'), code: issue.code, ...(issue.keys ? { keys: issue.keys } : {}),
    })),
    legacyIssues: findLegacy(config).map(issue => ({ path: issue.path, message: issue.message })),
  };
});
process.stdout.write('NATIVE_MANAGED_CONFIG=' + JSON.stringify({
  identity: { runtime, version: manifest.openclawVersion, nodeVersion: process.version,
    patchSetSha256: manifest.patchSetSha256, archivedRecipeSha256: manifest.buildRecipeSha256,
    evidence: 'immutable-native-schema-and-legacy-rules; Main projection is current test subject' },
  results,
}) + '\n');
