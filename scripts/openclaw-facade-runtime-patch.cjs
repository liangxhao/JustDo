'use strict';

// Packaging transform: replace OpenClaw's source-file fallback loader with a static dist import
// so esbuild can include facade activation in the packaged Gateway. This is intentionally kept
// outside the product capability patches because it changes bundling mechanics, not behavior.

const fs = require('fs');
const path = require('path');
const { assertCurrentPatchContract } = require('./patches/v2026.9.2/_patch-utils.js');

const CONTRACT = 'JUSTDO_FACADE_RUNTIME_STATIC_IMPORT_V2026_9_2';
const STATIC_IMPORT = `// ${CONTRACT}\nimport * as _facadeActivationCheckStatic from "./facade-activation-check.runtime.js";`;

function findFacadeRuntime(runtimeDir) {
  const distDir = path.join(runtimeDir, 'dist');
  if (!fs.existsSync(distDir)) throw new Error('facade-runtime dist directory is missing');
  const files = fs.readdirSync(distDir).filter(name => /^facade-runtime-.*\.js$/.test(name));
  if (files.length !== 1) {
    throw new Error(
      `facade-runtime target count is ${files.length}, expected 1: ${files.join(', ')}`,
    );
  }
  return path.join(distDir, files[0]);
}

function verifyFacadeRuntime(runtimeDir) {
  const facadePath = findFacadeRuntime(runtimeDir);
  const content = fs.readFileSync(facadePath, 'utf8');
  assertCurrentPatchContract(content, CONTRACT, facadePath);
  for (const required of [
    STATIC_IMPORT,
    'function loadFacadeActivationCheckRuntime() {\n\treturn _facadeActivationCheckStatic;\n}',
    'async function loadFacadeActivationCheckRuntimeAsync() {\n\treturn _facadeActivationCheckStatic;\n}',
  ]) {
    if (!content.includes(required))
      throw new Error(`facade-runtime static loader is missing: ${required}`);
  }
  for (const forbidden of [
    'createRequire(import.meta.url)',
    'FACADE_ACTIVATION_CHECK_RUNTIME_CANDIDATES',
    'getFacadeActivationCheckRuntimeModule',
    'getCachedPluginSourceModuleLoader',
  ]) {
    if (content.includes(forbidden))
      throw new Error(`facade-runtime retains dynamic loader: ${forbidden}`);
  }
  return facadePath;
}

function patchFacadeRuntime(runtimeDir) {
  const facadePath = findFacadeRuntime(runtimeDir);
  let content = fs.readFileSync(facadePath, 'utf8');
  assertCurrentPatchContract(content, CONTRACT, facadePath, false);
  if (content.includes(CONTRACT)) {
    verifyFacadeRuntime(runtimeDir);
    return [];
  }

  if (!content.includes('createRequire(import.meta.url)')) {
    throw new Error(
      'facade-runtime is neither pristine nor completely patched; rebuild from the locked npm tarball.',
    );
  }
  if (!content.includes('FACADE_ACTIVATION_CHECK_RUNTIME_CANDIDATES')) {
    throw new Error(
      'facade-runtime pristine candidate loader anchor is missing; npm package structure changed.',
    );
  }

  const replaceRequired = (pattern, replacement, description) => {
    const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
    const count = [...content.matchAll(new RegExp(pattern.source, flags))].length;
    if (count !== 1) throw new Error(`${description} count is ${count}, expected 1`);
    content = content.replace(pattern, replacement);
  };

  replaceRequired(
    /import\s*\{\s*createRequire\s*\}\s*from\s*"node:module";\s*\n?/,
    '',
    'facade createRequire import',
  );
  replaceRequired(
    /import\s*\{\s*[A-Za-z_$][\w$]*\s+as\s+getCachedPluginSourceModuleLoader\s*\}\s*from\s*"[^"]*plugin-module-loader-cache[^"]*";\s*\n?/g,
    '',
    'facade plugin source loader import',
  );
  replaceRequired(
    /import\s*\{\s*([A-Za-z_$][\w$]*\s+as\s+getPluginCacheRoot),\s*[A-Za-z_$][\w$]*\s+as\s+getPluginCacheSource\s*\}\s*from\s*("[^"]*plugin-cache[^"]*");/,
    'import { $1 } from $2;',
    'facade plugin cache import',
  );

  const lastImportIdx = findLastImportEnd(content);
  if (lastImportIdx === 0) throw new Error('facade-runtime import boundary was not found');
  content = content.slice(0, lastImportIdx) + `\n${STATIC_IMPORT}` + content.slice(lastImportIdx);

  replaceRequired(
    /const\s+nodeRequire\s*=\s*createRequire\(import\.meta\.url\);\s*\n?/g,
    '',
    'facade nodeRequire declaration',
  );
  replaceRequired(
    /const\s+FACADE_ACTIVATION_CHECK_RUNTIME_CANDIDATES\s*=\s*\[[\s\S]*?\];\s*\n?/g,
    '',
    'facade runtime candidates',
  );
  replaceRequired(
    /function\s+getFacadeActivationCheckRuntimeModule\(\)\s*\{[\s\S]*?\n\}\n/,
    '',
    'facade dynamic module getter',
  );
  replaceRequired(
    /function\s+setFacadeActivationCheckRuntimeModule\([^)]*\)\s*\{[\s\S]*?\n\}\n/,
    '',
    'facade dynamic module setter',
  );
  replaceRequired(
    /function\s+getFacadeActivationCheckRuntimeSourceLoader\([\s\S]*?\n\}\n/g,
    '',
    'facade source loader helper',
  );
  replaceRequired(
    /function\s+loadFacadeActivationCheckRuntimeFromCandidates\([\s\S]*?\n\}\n/g,
    '',
    'facade candidate loader helper',
  );
  replaceRequired(
    /function\s+loadFacadeActivationCheckRuntime\(\)\s*\{[\s\S]*?\n\}/,
    'function loadFacadeActivationCheckRuntime() {\n\treturn _facadeActivationCheckStatic;\n}',
    'facade synchronous loader',
  );
  replaceRequired(
    /async function\s+loadFacadeActivationCheckRuntimeAsync\(\)\s*\{[\s\S]*?\n\}/,
    'async function loadFacadeActivationCheckRuntimeAsync() {\n\treturn _facadeActivationCheckStatic;\n}',
    'facade asynchronous loader',
  );

  content = content.replace(
    /function\s+setFacadeActivationCheckRuntimeForTest\([\s\S]*?\n\}/,
    'function setFacadeActivationCheckRuntimeForTest(_module) {\n\t// no-op: static import cannot be replaced at test time\n}',
  );
  content = content.replace(
    /function\s+resetFacadeRuntimeStateForTest\(\)\s*\{[\s\S]*?\n\}/,
    'function resetFacadeRuntimeStateForTest() {\n\tresetFacadeLoaderStateForTest();\n}',
  );
  content = content.replace(/\n{3,}/g, '\n\n');

  fs.writeFileSync(facadePath, content, 'utf8');
  try {
    verifyFacadeRuntime(runtimeDir);
  } catch (error) {
    throw new Error(`facade-runtime static-loader verification failed: ${String(error)}`);
  }
  return [path.relative(runtimeDir, facadePath)];
}

function findLastImportEnd(content) {
  const importRegex = /^import\s+[\s\S]*?;\s*$/gm;
  let lastIdx = 0;
  let match;
  while ((match = importRegex.exec(content)) !== null) {
    lastIdx = match.index + match[0].length;
  }
  return lastIdx;
}

module.exports = {
  CONTRACT,
  patchFacadeRuntime,
  verifyFacadeRuntime,
};
