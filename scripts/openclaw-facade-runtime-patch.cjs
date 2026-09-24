'use strict';
// Packaging-only seam for the locked 2026.9.6 npm artifact. Native require cannot
// discover this companion once the Gateway entry is bundled at the runtime root.
const fs = require('fs');
const path = require('path');
const { assertCurrentPatchContract, replaceNamedFunction } = require('./patches/v2026.9.6/_patch-utils.js');
const CONTRACT = 'JUSTDO_FACADE_RUNTIME_STATIC_IMPORT_V2026_9_6';
const STATIC_IMPORT = `// ${CONTRACT}\nimport * as _facadeActivationCheckStatic from "./facade-activation-check.runtime.js";`;
function findFacadeRuntime(root) {
  const files = fs.readdirSync(path.join(root, 'dist')).filter(name => /^facade-runtime-.*\.mjs$/.test(name));
  if (files.length !== 1) throw new Error('Expected exactly one v2026.9.6 facade runtime');
  return path.join(root, 'dist', files[0]);
}
function transform(source, file) {
  assertCurrentPatchContract(source, CONTRACT, file, false);
  if (source.includes(CONTRACT)) {
    if (!source.includes(STATIC_IMPORT) || (source.match(/return _facadeActivationCheckStatic;/g) || []).length !== 2) throw new Error('Partial facade transform; rebuild pristine runtime');
    return source;
  }
  if (!source.includes('Host facade activation runtime requires native loading:')) throw new Error('Unknown facade runtime; rebuild pristine runtime');
  let next = STATIC_IMPORT + '\n' + source;
  for (const name of ['loadFacadeActivationCheckRuntime', 'loadFacadeActivationCheckRuntimeAsync']) {
    next = replaceNamedFunction(next, name, `${name.endsWith('Async') ? 'async ' : ''}function ${name}() {\n\treturn _facadeActivationCheckStatic;\n}`);
  }
  return next;
}
function verifyFacadeRuntime(root) {
  const file = findFacadeRuntime(root), before = fs.readFileSync(file, 'utf8');
  if (transform(before, file) !== before) throw new Error('Facade static import missing');
  return file;
}
function patchFacadeRuntime(root) {
  const file = findFacadeRuntime(root), before = fs.readFileSync(file, 'utf8'), after = transform(before, file);
  if (before === after) return [];
  fs.writeFileSync(file, after);
  verifyFacadeRuntime(root);
  return [path.relative(root, file)];
}
module.exports = { CONTRACT, patchFacadeRuntime, verifyFacadeRuntime };
